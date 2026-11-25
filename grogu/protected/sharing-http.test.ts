import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import {
  ProtectedChatShareResponseSchema,
  ProtectedPublicAutomationResponseSchema,
  ProtectedPublicAutomationsResponseSchema,
  ProtectedShareClaimResponseSchema,
  ProtectedSharedChatResponseSchema,
  ProtectedSharedChatsResponseSchema,
} from "../../packages/gateway-protocol/src/protected-sharing.js";
import {
  ProtectedAutomationCatalogSchema,
  ProtectedAutomationResponseSchema,
  ProtectedMeSchema,
} from "../../packages/gateway-protocol/src/protected.js";
import { appendTranscriptMessage } from "../../src/config/sessions/session-accessor.js";
import { closeSessionTranscriptReconcileWorkerPool } from "../../src/config/sessions/session-transcript-reconcile-pool.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import {
  listProtectedAdmissions,
  migrateProtectedSubjects,
  removeProtectedAdmission,
} from "./admission-store.js";
import { createProtectedAgentCatalog } from "./agents.js";
import {
  readProtectedAutomationLifecycleStorageUsage,
  writeProtectedAutomationLifecycle,
  type ProtectedAutomationLifecycleAuthority,
} from "./automation-lifecycle-store.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import { readProtectedAutomationStorageUsage } from "./automations-store.js";
import { measureProtectedStorage, storageEntryOverheadBytes } from "./capacity.js";
import { chatArtifactsDirectory, restrictChatFiles } from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import { readProtectedFeedbackStorageUsage } from "./feedback-store.js";
import { createProtectedHttp } from "./http.js";
import { createProtectedServer } from "./server.js";
import {
  canMemberReadAutomation,
  canMemberReadAutomationRun,
  canMemberReadChat,
  canMemberReadChatArtifact,
  runProtectedSharing,
} from "./sharing-store.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";
import type { StoredDataRetirement } from "./storage-entry-quota.js";

function seedLegacyPublication(databasePath: string, automationId: string, followerId: string) {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE protected_automations SET visibility = 'shared' WHERE id = ?").run(
      automationId,
    );
    db.prepare(
      "INSERT INTO protected_automation_publications (automation_id, published_at) VALUES (?, 1000)",
    ).run(automationId);
    db.prepare(
      "INSERT INTO protected_automation_members (automation_id, profile_id, role, added_at) VALUES (?, ?, 'follower', 1001)",
    ).run(automationId, followerId);
    db.prepare(
      "INSERT INTO protected_automation_subscriptions (automation_id, profile_id, subscribed_at) VALUES (?, ?, 1001)",
    ).run(automationId, followerId);
  } finally {
    db.close();
  }
}

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalStorageKeyFile = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
const keyStateDir = path.resolve(".artifacts", `protected-sharing-key-${randomUUID()}`);
const keyFile = `${keyStateDir}.key`;

before(async () => {
  await mkdir(keyStateDir, { recursive: true, mode: 0o700 });
  await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  process.env.OPENCLAW_STATE_DIR = keyStateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyFile;
});

after(async () => {
  await rm(keyFile, { force: true });
  await rm(keyStateDir, { recursive: true, force: true });
  for (const [name, value] of [
    ["OPENCLAW_STATE_DIR", originalStateDir],
    ["OPENCLAW_PROTECTED_STORAGE_KEY_FILE", originalStorageKeyFile],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const subjects = {
  admin: "00000000-0000-4000-8000-000000000001",
  owner: "00000000-0000-4000-8000-000000000002",
  recipient: "00000000-0000-4000-8000-000000000003",
  second: "00000000-0000-4000-8000-000000000004",
  outsider: "00000000-0000-4000-8000-000000000005",
  development: `service-token:${"d".repeat(32)}.access`,
};
type Member = keyof typeof subjects;

async function createSharingFixture(t: TestContext) {
  const stateDir = path.resolve(".artifacts", `protected-sharing-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const issuer = "https://access.example";
  const allowed = new Set<string>(Object.values(subjects));
  const expiresAt = Date.now() + 120_000;
  await prepareProtectedSharedState(stateDir, () => {});
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [...allowed] });
  const encryption = createStorageValueEncryption(randomBytes(32));
  const usersRoot = await root(usersDir);
  const storageLimits = { globalBytes: 50_000_000, userBytes: 10_000_000, freeFloorBytes: 1 };
  const app = createProtectedHttp({
    origin: "https://alcove.example",
    accessIssuer: issuer,
    directory: {
      issuer,
      get allowedSubjects() {
        return [...allowed];
      },
    },
    ownerSubject: subjects.admin,
    onRemoveSubject: (subject) => allowed.delete(subject),
    stateDir,
    usersRoot,
    encryption,
    verifyIdentity: async (request) => {
      const subject = request.headers.get("x-test-subject") ?? "";
      if (!allowed.has(subject)) {
        throw new ProtectedError(401, "unauthorized", "Sign in.");
      }
      return {
        issuer,
        subject,
        kind: subject === subjects.development ? "development" : "human",
        sessionId: `session-${subject}`,
        expiresAt,
        assertCurrent() {},
        async revalidate() {},
      };
    },
    maxChatsPerUser: 5,
    maxFileBytes: 4096,
    storageLimits,
    turns: {
      models: [
        {
          provider: "sparky",
          id: "synthetic",
          label: "Synthetic",
          thinking: { levels: ["low"], default: "low" },
        },
      ],
      async run(turn) {
        for (const message of [
          { role: "user" as const, content: turn.input.text },
          {
            role: "assistant" as const,
            content: `Synthetic reply to ${turn.input.text}`,
            stopReason: "stop" as const,
          },
        ]) {
          turn.assertCurrent();
          await appendTranscriptMessage(
            { ...turn.target, sessionId: turn.id, env: { OPENCLAW_STATE_DIR: stateDir } },
            { message },
          );
        }
      },
      async steer() {
        assert.fail("This fixture does not steer turns.");
      },
    },
  });
  const chats = createProtectedChats({
    stateDir,
    maxChatsPerUser: 5,
    agentCatalog: createProtectedAgentCatalog(),
    usersRoot,
    maxFileBytes: 4096,
  });
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  t.after(async () => {
    await app.shutdown();
    encryption.dispose();
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    await rm(stateDir, { recursive: true, force: true });
  });

  const profiles = new Map<Member, string>();
  const call = (
    member: Member,
    pathname: string,
    init: { method?: string; body?: object; headers?: Record<string, string> } = {},
    capabilities = "sharing-v1",
  ) =>
    app.fetch(
      new Request(`https://alcove.example/api/protected/v1${pathname}`, {
        method: init.method ?? "GET",
        headers: {
          origin: "https://alcove.example",
          "x-test-subject": subjects[member],
          ...(capabilities ? { "X-Alcove-Capabilities": capabilities } : {}),
          ...(profiles.has(member) ? { "x-grogu-profile": profiles.get(member)! } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
  const ok = async (response: Response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text());
    return status === 204 ? undefined : await response.json();
  };
  const errorCode = async (response: Response) => (await response.json()).error.code;

  const legacyMe = await ok(await call("owner", "/me", {}, ""));
  assert.equal("sharing" in legacyMe.capabilities, false);
  for (const member of Object.keys(subjects) as Member[]) {
    const me = await ok(await call(member, "/me", {}, "profile-v1, agents-v1, sharing-v1"));
    assert.ok(Value.Check(ProtectedMeSchema, me));
    assert.equal(me.capabilities.sharing, member !== "development");
    profiles.set(member, me.user.id);
  }
  const id = (member: Member) => profiles.get(member)!;
  await ok(
    await call("owner", "/account/name", {
      method: "PUT",
      body: { displayName: "Synthetic Owner" },
    }),
  );
  const removeMember = async (member: Member) => {
    const { people } = await ok(await call("admin", "/admin/people"));
    const person = people.find((entry: { subject?: string }) => entry.subject === subjects[member]);
    await ok(
      await call("admin", `/admin/people/${person.id}/remove`, { method: "POST", body: {} }),
    );
  };
  // Mirrors the service's measurement, so a limit squeezed from it admits nothing new.
  const globalUsage = async () =>
    (
      await measureProtectedStorage(
        {
          chats,
          usersRoot,
          maxFileBytes: 4096,
          encryption,
          automationUsage: (profileId, assertCurrent) =>
            readProtectedAutomationStorageUsage(stateDir, profileId, assertCurrent),
          storedDataUsage: async (_profileId, assertCurrent) => [
            ...(await readProtectedFeedbackStorageUsage(
              stateDir,
              storageEntryOverheadBytes,
              assertCurrent,
            )),
            ...(await readProtectedAutomationResultStorageUsage(stateDir, assertCurrent)),
            ...(await readProtectedAutomationLifecycleStorageUsage(stateDir, assertCurrent)),
            ...(await runProtectedSharing(
              stateDir,
              "protectedSharing.storageUsage",
              storageEntryOverheadBytes,
              assertCurrent,
            )),
          ],
        },
        id("owner"),
        () => {},
        true,
      )
    ).globalBytes;
  return {
    app,
    stateDir,
    usersRoot,
    encryption,
    storageLimits,
    globalUsage,
    chats,
    databasePath,
    call,
    ok,
    errorCode,
    id,
    removeMember,
  };
}

void test("isolated child files and widget promotion stay within their run", async (t) => {
  const { usersRoot, encryption, id } = await createSharingFixture(t);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: id("owner"),
    assertCurrent() {},
    maxBytes: 4096,
    encryption,
  });
  t.after(() => files.dispose());
  const run = randomUUID();
  const child = randomUUID();
  const other = randomUUID();
  const childFiles = restrictChatFiles(files, new Set([child]));
  const promotionFiles = restrictChatFiles(files, new Set([run, child]));
  await files.write(`chats/${run}/private.txt`, "run");
  await files.write(`chats/${other}/private.txt`, "other");
  await files.write("member-memory/memory/private.txt", "memory");
  await childFiles.write(`chats/${child}/widget`, "widget");
  for (const name of [
    `chats/${run}/private.txt`,
    `chats/${other}/private.txt`,
    "member-memory/memory/private.txt",
  ]) {
    assert.throws(() => childFiles.readText(name), /unavailable/u);
  }
  assert.throws(() => promotionFiles.readText(`chats/${other}/private.txt`), /unavailable/u);
  assert.throws(
    () => promotionFiles.move(`chats/${child}/widget`, `chats/${other}/widget`),
    /unavailable/u,
  );
  await promotionFiles.move(`chats/${child}/widget`, `chats/${run}/widget`);
  assert.equal(await files.readText(`chats/${run}/widget`), "widget");
});

void test("chat links grant live read-only access until revoked", async (t) => {
  const {
    stateDir,
    usersRoot,
    encryption,
    storageLimits,
    globalUsage,
    chats,
    databasePath,
    call,
    ok,
    errorCode,
    id,
    removeMember,
  } = await createSharingFixture(t);

  const { chat } = await ok(await call("owner", "/chats", { method: "POST", body: {} }));
  const turn = async (text: string) => {
    const response = await call("owner", `/chats/${chat.id}/turns`, {
      method: "POST",
      body: { text, provider: "sparky", model: "synthetic" },
    });
    assert.equal(response.status, 200);
    await response.text();
  };
  await turn("First synthetic question");
  const ownerFiles = await createAuthorizedUserFiles({
    usersRoot,
    profileId: id("owner"),
    assertCurrent() {},
    maxBytes: 4096,
    encryption,
  });
  try {
    await ownerFiles.write(`${chatArtifactsDirectory(chat.id)}/notes.txt`, "Synthetic notes");
  } finally {
    ownerFiles.dispose();
  }

  // Old clients keep the current contract: every sharing route is absent.
  for (const [member, pathname, method] of [
    ["owner", `/chats/${chat.id}/share`, "POST"],
    ["recipient", "/shared/chats", "GET"],
    ["recipient", `/shares/${"a".repeat(43)}/claim`, "POST"],
  ] as const) {
    const response = await call(member, pathname, { method }, "feedback-v1");
    assert.equal(response.status, 404);
    assert.equal(await errorCode(response), "not_found");
  }
  const development = await call("development", `/shares/${"a".repeat(43)}/claim`, {
    method: "POST",
  });
  assert.equal(development.status, 403);
  assert.equal(await errorCode(development), "sharing_unavailable");

  assert.deepEqual(await ok(await call("owner", `/chats/${chat.id}/share`)), { share: null });
  const created = await ok(await call("owner", `/chats/${chat.id}/share`, { method: "POST" }));
  assert.ok(Value.Check(ProtectedChatShareResponseSchema, created));
  const share = created.share;
  assert.ok(share);
  assert.match(share.id, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(share.path, `/s/${share.id}`);
  assert.deepEqual(share.recipients, []);
  const again = await ok(await call("owner", `/chats/${chat.id}/share`, { method: "POST" }));
  assert.equal(again.share.id, share.id);
  assert.equal((await call("recipient", `/chats/${chat.id}/share`)).status, 404);

  const shared = `/shared/chats/${id("owner")}/${chat.id}`;
  assert.equal((await call("recipient", shared)).status, 404);
  const claim = (member: Member, shareId: string) =>
    call(member, `/shares/${shareId}/claim`, { method: "POST" });
  const claimed = await ok(await claim("recipient", share.id));
  assert.ok(Value.Check(ProtectedShareClaimResponseSchema, claimed));
  assert.deepEqual(claimed, {
    access: "recipient",
    chat: {
      id: chat.id,
      title: claimed.chat.title,
      updatedAt: claimed.chat.updatedAt,
      owner: { personId: id("owner"), displayName: "Synthetic Owner" },
    },
  });
  assert.equal((await ok(await claim("owner", share.id))).access, "owner");
  assert.deepEqual(await ok(await claim("recipient", share.id)), claimed);

  const read = await ok(await call("recipient", shared));
  assert.ok(Value.Check(ProtectedSharedChatResponseSchema, read));
  assert.deepEqual(read.owner, { personId: id("owner"), displayName: "Synthetic Owner" });
  assert.match(JSON.stringify(read.chat.messages), /Synthetic reply to First synthetic question/u);
  await turn("Second synthetic question");
  assert.match(
    JSON.stringify((await ok(await call("recipient", shared))).chat.messages),
    /Synthetic reply to Second synthetic question/u,
  );

  // A reply the owner sends from a side chat is plain parent text for everyone else.
  // Sending a reply to the main chat writes through the process-wide state directory.
  const ambientStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    process.env.OPENCLAW_STATE_DIR = ambientStateDir;
  });
  const withSide = "sharing-v1,side-chats-v1";
  const { chat: side } = await ok(
    await call(
      "owner",
      `/chats/${chat.id}/side`,
      { method: "POST", body: { requestId: randomUUID() } },
      withSide,
    ),
    201,
  );
  const sideTurn = await call(
    "owner",
    `/chats/${side.id}/turns`,
    { method: "POST", body: { text: "Side question", provider: "sparky", model: "synthetic" } },
    withSide,
  );
  assert.equal(sideTurn.status, 200);
  await sideTurn.text();
  const sideReply = (await ok(await call("owner", `/chats/${side.id}`, {}, withSide))).chat.messages
    .toReversed()
    .find((message: { role: string }) => message.role === "assistant");
  await ok(
    await call(
      "owner",
      `/chats/${side.id}/side/return`,
      { method: "POST", body: { requestId: randomUUID(), messageIds: [sideReply.id] } },
      withSide,
    ),
  );
  const returned = (
    await ok(await call("owner", `/chats/${chat.id}`, {}, withSide))
  ).chat.messages.at(-1);
  assert.deepEqual(returned.sideNote, { chatId: side.id, title: "Side chat" });
  for (const capabilities of [withSide, "sharing-v1"]) {
    const message = (await ok(await call("recipient", shared, {}, capabilities))).chat.messages.at(
      -1,
    );
    assert.equal(message.text, "Synthetic reply to Side question");
    assert.equal(message.sideNote, undefined);
  }
  assert.equal(
    (await ok(await call("owner", `/chats/${chat.id}`, {}, "sharing-v1"))).chat.messages.at(-1)
      .sideNote,
    undefined,
  );

  const artifacts = await ok(await call("recipient", `${shared}/artifacts`));
  assert.deepEqual(
    artifacts.artifacts.map((artifact: { id: string; kind: string }) => [
      artifact.kind,
      artifact.id,
    ]),
    [["file", `${chat.id}~notes.txt`]],
  );
  const download = await call("recipient", `${shared}/files/${chat.id}~notes.txt`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "Synthetic notes");
  assert.equal((await call("recipient", `${shared}/files/${chat.id}~missing.txt`)).status, 404);
  assert.equal((await call("outsider", shared)).status, 404);
  assert.equal((await call("outsider", `${shared}/files/${chat.id}~notes.txt`)).status, 404);
  const listed = await ok(await call("recipient", "/shared/chats"));
  assert.ok(Value.Check(ProtectedSharedChatsResponseSchema, listed));
  assert.deepEqual(
    listed.chats.map((entry: { id: string }) => entry.id),
    [chat.id],
  );
  assert.deepEqual((await ok(await call("outsider", "/shared/chats"))).chats, []);

  // Grants are read-only: owner routes stay owner-scoped.
  for (const [pathname, method, body] of [
    [`/chats/${chat.id}`, "GET", undefined],
    [`/chats/${chat.id}/turns`, "POST", { text: "Hi", provider: "sparky", model: "synthetic" }],
    [`/chats/${chat.id}/title`, "PATCH", { title: "Taken" }],
    [`/chats/${chat.id}/share`, "DELETE", undefined],
    [`/files/${chat.id}~notes.txt`, "GET", undefined],
  ] as const) {
    assert.equal((await call("recipient", pathname, { method, body })).status, 404, pathname);
  }

  // The exported access owner agrees with the routes.
  const member = (name: Member) => ({ profileId: id(name), assertCurrent() {} });
  const target = { ownerProfileId: id("owner"), chatId: chat.id };
  const access = { stateDir, chats };
  assert.equal(await canMemberReadChat(access, member("recipient"), target), true);
  assert.equal(await canMemberReadChat(access, member("owner"), target), true);
  assert.equal(await canMemberReadChat(access, member("outsider"), target), false);
  assert.equal(
    await canMemberReadChatArtifact(access, member("recipient"), {
      ...target,
      kind: "file",
      id: `${chat.id}~notes.txt`,
    }),
    true,
  );
  assert.equal(
    await canMemberReadChatArtifact(access, member("recipient"), {
      ...target,
      kind: "file",
      id: `${randomUUID()}~notes.txt`,
    }),
    false,
  );

  // Renaming keeps the link and every grant.
  const { chat: current } = await ok(await call("owner", `/chats/${chat.id}`));
  await ok(
    await call("owner", `/chats/${chat.id}/title`, {
      method: "PATCH",
      body: { title: "Renamed synthetic chat" },
      headers: { "if-match": current.version },
    }),
  );
  assert.equal(
    (await ok(await call("recipient", "/shared/chats"))).chats[0].title,
    "Renamed synthetic chat",
  );
  assert.equal((await ok(await claim("second", share.id))).chat.title, "Renamed synthetic chat");
  const recipients = (await ok(await call("owner", `/chats/${chat.id}/share`))).share.recipients;
  assert.deepEqual(
    recipients.map((person: { personId: string }) => person.personId).toSorted(),
    [id("recipient"), id("second")].toSorted(),
  );
  const usage = await runProtectedSharing(
    stateDir,
    "protectedSharing.storageUsage",
    4096,
    () => {},
  );
  assert.deepEqual(
    usage.map((entry) => entry.profileId).toSorted(),
    [id("owner"), id("recipient"), id("second")].toSorted(),
  );

  // Removing one recipient rotates the link; the removed member cannot claim it again.
  const rotated = await ok(
    await call("owner", `/chats/${chat.id}/share/recipients/${id("recipient")}`, {
      method: "DELETE",
    }),
  );
  assert.notEqual(rotated.share.id, share.id);
  assert.deepEqual(
    rotated.share.recipients.map((person: { personId: string }) => person.personId),
    [id("second")],
  );
  assert.equal((await call("recipient", shared)).status, 404);
  const reclaim = await claim("recipient", share.id);
  assert.equal(reclaim.status, 404);
  assert.equal(await errorCode(reclaim), "share_not_found");
  assert.equal((await call("recipient", shared)).status, 404);
  await ok(await call("second", shared));

  // Disabling the link revokes everyone.
  await ok(await call("owner", `/chats/${chat.id}/share`, { method: "DELETE" }), 204);
  assert.equal((await call("second", shared)).status, 404);
  assert.deepEqual((await ok(await call("second", "/shared/chats"))).chats, []);
  assert.equal((await claim("second", rotated.share.id)).status, 404);

  // Deleting the chat denies immediately and removes its link.
  const reshared = await ok(await call("owner", `/chats/${chat.id}/share`, { method: "POST" }));
  await ok(await claim("second", reshared.share.id));
  const { chat: latest } = await ok(await call("owner", `/chats/${chat.id}`));
  await ok(
    await call("owner", `/chats/${chat.id}`, {
      method: "DELETE",
      headers: { "if-match": latest.version },
    }),
    204,
  );
  assert.equal((await call("second", shared)).status, 404);
  assert.equal((await claim("second", reshared.share.id)).status, 404);
  const countRows = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return [
        db.prepare("SELECT count(*) AS count FROM protected_chat_shares").get()?.count,
        db.prepare("SELECT count(*) AS count FROM protected_chat_share_grants").get()?.count,
      ];
    } finally {
      db.close();
    }
  };
  assert.deepEqual(countRows(), [0, 0]);

  // Interrupted cleanup: link rows for a chat the owner no longer has expose nothing and are removed.
  const orphanChat = randomUUID();
  const orphanShare = randomBytes(32).toString("base64url");
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture
      .prepare("INSERT INTO protected_chat_shares VALUES (?, ?, ?, ?)")
      .run(id("owner"), orphanChat, orphanShare, Date.now());
    fixture
      .prepare("INSERT INTO protected_chat_share_grants VALUES (?, ?, ?, ?)")
      .run(id("owner"), orphanChat, id("second"), Date.now());
  } finally {
    fixture.close();
  }
  assert.equal((await call("second", `/shared/chats/${id("owner")}/${orphanChat}`)).status, 404);
  assert.deepEqual((await ok(await call("second", "/shared/chats"))).chats, []);
  assert.deepEqual(countRows(), [0, 0]);

  // Removing either member from Alcove removes their links and grants.
  const { chat: next } = await ok(await call("owner", "/chats", { method: "POST", body: {} }));
  const nextShare = await ok(await call("owner", `/chats/${next.id}/share`, { method: "POST" }));
  await ok(await claim("recipient", nextShare.share.id));
  await ok(await claim("second", nextShare.share.id));
  await ok(
    await call("outsider", "/account/name", {
      method: "PUT",
      body: { displayName: "Synthetic Other" },
    }),
  );
  const pendingShare = async () => {
    const { chat: pending } = await ok(
      await call("outsider", "/chats", { method: "POST", body: {} }),
    );
    return (await ok(await call("outsider", `/chats/${pending.id}/share`, { method: "POST" })))
      .share;
  };
  const firstPending = await pendingShare();
  storageLimits.globalBytes = (await globalUsage()) + storageEntryOverheadBytes / 2;
  assert.equal((await claim("second", firstPending.id)).status, 413);
  await removeMember("recipient");
  assert.deepEqual(countRows(), [2, 1]);
  assert.equal((await claim("second", nextShare.share.id)).status, 404);
  await ok(await call("second", `/shared/chats/${id("owner")}/${next.id}`));
  await t.test(
    "member removal immediately releases a removed recipient's grant quota",
    async () => {
      await ok(await claim("second", firstPending.id));
    },
  );
  storageLimits.globalBytes = 50_000_000;
  await removeMember("owner");
  assert.equal((await call("second", `/shared/chats/${id("owner")}/${next.id}`)).status, 404);
  assert.deepEqual(
    (await ok(await call("second", "/shared/chats"))).chats.map(
      (item: { owner: { personId: string } }) => item.owner.personId,
    ),
    [id("outsider")],
  );
  assert.deepEqual(countRows(), [1, 1]);
});

void test("legacy public automation data remains private at the HTTP boundary", async (t) => {
  const { stateDir, databasePath, chats, call, ok, errorCode, id } = await createSharingFixture(t);
  const capabilities =
    "sharing-v1, automations-public-v1, automation-results-v1, automation-runs-v1";
  const catalog = await ok(await call("owner", "/automations/catalog"));
  const { automation } = await ok(
    await call("owner", "/automations", {
      method: "POST",
      body: {
        name: "Synthetic legacy automation",
        instructions: "Summarize synthetic material.",
        whenToNotify: "Only when useful.",
        agentId: catalog.defaultAgentId,
        model: { provider: "sparky", id: "synthetic" },
        schedule: { kind: "every", everyMs: 60_000 },
      },
    }),
    201,
  );
  await runProtectedSharing(
    stateDir,
    "protectedSharing.publishAutomation",
    {
      profileId: id("owner"),
      automationId: automation.id,
      now: 1_000,
      storageOverheadBytes: storageEntryOverheadBytes,
    },
    () => {},
  );
  seedLegacyPublication(databasePath, automation.id, id("recipient"));

  const runId = randomUUID();
  const run = await commitProtectedAutomationFinishedResult(
    stateDir,
    {
      automationId: automation.id,
      definitionRevision: Number(automation.version),
      centralOwnerProfileId: id("owner"),
      jobId: automation.id,
      runAtMs: 1_000,
      runId,
      completedAtMs: 2_000,
      automationName: automation.name,
      privateFinalText: "Synthetic legacy result.",
      transcript: { sessionKey: "synthetic-session-key", sessionId: randomUUID() },
    },
    {
      profileId: id("owner"),
      revalidate: async () => {},
      assertCurrent: () => {},
      enrollPublication: () => ({ finish: () => {} }),
      reserveStorage: async () => ({ settle: () => {}, release: () => {} }),
      retainUncertainCommit: () => {},
    },
  );
  assert.equal(run.status, "created");
  if (run.status !== "created") {
    throw new Error("Synthetic legacy run was not stored.");
  }

  const runChatId = randomUUID();
  const ownerAuthority = { profileId: id("owner"), assertCurrent() {} };
  await chats.create(ownerAuthority, automation.name, automation.agentId, undefined, {
    chatId: runChatId,
    automationId: automation.id,
  });
  const lifecycle: ProtectedAutomationLifecycleAuthority = {
    profileId: id("owner"),
    revalidate: async () => {},
    assertCurrent() {},
    enrollPublication: () => ({ finish: () => {} }),
    reserveStorage: async () => ({ settle: () => {}, release: () => {} }),
    reserveReplacement: async () => ({ settle: () => {}, release: () => {} }),
    reserveBatchReplacement: async () => ({ settle: () => {}, release: () => {} }),
    reserveRecipient: async () => ({ settle: () => {}, release: () => {} }),
    retireStorage: () => {},
    retainUncertainCommit: () => assert.fail("Unexpected lifecycle reconciliation."),
  };
  const writeLifecycle = (command: Parameters<typeof writeProtectedAutomationLifecycle>[1]) =>
    writeProtectedAutomationLifecycle(stateDir, command, lifecycle);
  assert.deepEqual(
    await writeLifecycle({
      kind: "provision",
      profileId: id("owner"),
      automationId: automation.id,
    }),
    { status: "committed" },
  );
  assert.deepEqual(
    await writeLifecycle({
      kind: "queue",
      profileId: id("owner"),
      automationId: automation.id,
      runId,
      definitionRevision: Number(automation.version),
      contextAccess: "member",
      trigger: "manual",
      scheduledAtMs: 1_000,
      now: 1_001,
    }),
    {
      status: "committed",
      admission: { definitionRevision: Number(automation.version), contextAccess: "member" },
    },
  );
  assert.deepEqual(
    await writeLifecycle({
      kind: "start",
      profileId: id("owner"),
      automationId: automation.id,
      runId,
      chatId: runChatId,
      now: 1_002,
    }),
    { status: "committed" },
  );
  assert.deepEqual(
    await writeLifecycle({
      kind: "finish",
      profileId: id("owner"),
      automationId: automation.id,
      runId,
      now: 2_000,
      outcome: { status: "succeeded", resultId: run.id },
    }),
    { status: "committed" },
  );
  assert.deepEqual(
    await writeLifecycle({
      kind: "deliver",
      profileId: id("owner"),
      automationId: automation.id,
      runId,
      now: 2_001,
    }),
    { status: "committed" },
  );

  const legacySharingState = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        publications: db
          .prepare(
            "SELECT automation_id, published_at FROM protected_automation_publications ORDER BY automation_id",
          )
          .all(),
        followers: db
          .prepare(
            "SELECT automation_id, profile_id, added_at FROM protected_automation_members WHERE role = 'follower' ORDER BY automation_id, profile_id",
          )
          .all(),
        subscriptions: db
          .prepare(
            "SELECT automation_id, profile_id, subscribed_at FROM protected_automation_subscriptions ORDER BY automation_id, profile_id",
          )
          .all(),
      };
    } finally {
      db.close();
    }
  };
  const retainedLegacySharingState = legacySharingState();
  const owner = await ok(await call("owner", `/automations/${automation.id}`, {}, capabilities));
  assert.equal(owner.automation.id, automation.id);
  assert.equal(
    (await ok(await call("owner", "/automations", {}, capabilities))).automations.length,
    1,
  );
  const publicCatalog = await ok(await call("owner", "/automations/catalog", {}, capabilities));
  assert.deepEqual(publicCatalog.capabilities.automations.public, {
    publish: true,
    follow: true,
    notifications: true,
  });
  assert.deepEqual(
    (await ok(await call("recipient", "/automations/public", {}, capabilities))).automations,
    [],
  );
  for (const [member, pathname, method, body] of [
    ["owner", `/automations/${automation.id}/publication`, "PUT", undefined],
    ["recipient", `/automations/${automation.id}/follow`, "PUT", undefined],
    ["recipient", `/automations/${automation.id}/notifications`, "PUT", { subscribed: true }],
    ["recipient", `/automations/public/${automation.id}/runs`, "GET", undefined],
    ["recipient", `/automations/public/${automation.id}/runs/${run.id}`, "GET", undefined],
  ] as const) {
    const response = await call(member, pathname, { method, body }, capabilities);
    assert.equal(response.status, 404, pathname);
    assert.equal(await errorCode(response), "not_found");
  }
  assert.deepEqual(legacySharingState(), retainedLegacySharingState);
  for (const pathname of [
    `/automations/${automation.id}`,
    `/automations/${automation.id}/runs`,
    `/automations/${automation.id}/runs/${run.id}`,
    `/automations/${automation.id}/run-history`,
  ]) {
    const response = await call("recipient", pathname, {}, capabilities);
    assert.equal(response.status, 404, pathname);
    assert.equal(await errorCode(response), "not_found");
  }
  assert.deepEqual(
    (
      await ok(await call("owner", `/automations/${automation.id}/runs`, {}, capabilities))
    ).runs.map((entry: { id: string }) => entry.id),
    [run.id],
  );
  assert.deepEqual(
    (
      await ok(
        await call("owner", `/automations/${automation.id}/runs/${run.id}`, {}, capabilities),
      )
    ).run.text,
    "Synthetic legacy result.",
  );
  assert.deepEqual(
    (
      await ok(await call("owner", `/automations/${automation.id}/run-history`, {}, capabilities))
    ).runs.map((entry: { id: string }) => entry.id),
    [runId],
  );
  assert.deepEqual(
    (await ok(await call("owner", "/automations/inbox", {}, capabilities))).entries.map(
      (entry: { runId: string }) => entry.runId,
    ),
    [runId],
  );
  // A legacy (non-isolated) run never gives followers a receipt.
  assert.deepEqual(
    (await ok(await call("recipient", "/automations/inbox", {}, capabilities))).entries,
    [],
  );
  assert.equal((await call("recipient", `/chats/${runChatId}`, {}, capabilities)).status, 404);
  assert.equal(
    (await ok(await call("owner", `/chats/${runChatId}`, {}, capabilities))).chat.id,
    runChatId,
  );

  const share = await ok(
    await call("owner", `/chats/${runChatId}/share`, { method: "POST" }, capabilities),
  );
  const sharedChat = `/shared/chats/${id("owner")}/${runChatId}`;
  assert.equal(
    (await call("recipient", `/shares/${share.share.id}/claim`, { method: "POST" })).status,
    200,
  );
  assert.equal(
    (await ok(await call("recipient", sharedChat, {}, capabilities))).chat.id,
    runChatId,
  );
  await ok(
    await call(
      "owner",
      `/automations/${automation.id}/publication`,
      { method: "DELETE" },
      capabilities,
    ),
  );
  assert.deepEqual(legacySharingState(), { publications: [], followers: [], subscriptions: [] });
});

void test("isolated automation publishing and follower notifications use current grants", async (t) => {
  const { call, ok, id } = await createSharingFixture(t);
  const capabilities = "automations-public-v1, automations-context-v1, automation-results-v1";
  const catalog = await ok(await call("owner", "/automations/catalog", {}, capabilities));
  assert.deepEqual(catalog.capabilities.automations.public, {
    publish: true,
    follow: true,
    notifications: true,
  });
  const { automation } = await ok(
    await call(
      "owner",
      "/automations",
      {
        method: "POST",
        body: {
          name: "Synthetic public automation",
          instructions: "Summarize synthetic material.",
          whenToNotify: "After each run.",
          agentId: catalog.defaultAgentId,
          model: { provider: "sparky", id: "synthetic" },
          contextAccess: "isolated",
          schedule: { kind: "every", everyMs: 60_000 },
        },
      },
      capabilities,
    ),
    201,
  );
  const item = `/automations/${automation.id}`;
  assert.equal((await call("owner", `${item}/publication`, { method: "PUT" })).status, 404);
  assert.equal((await call("development", "/automations/public", {}, capabilities)).status, 403);
  assert.equal(
    (await call("recipient", `${item}/follow`, { method: "PUT" }, capabilities)).status,
    404,
  );
  await ok(await call("owner", `${item}/publication`, { method: "PUT" }, capabilities));
  const list = await ok(await call("recipient", "/automations/public", {}, capabilities));
  assert.ok(Value.Check(ProtectedPublicAutomationsResponseSchema, list));
  const [published] = list.automations;
  assert.ok(published);
  assert.equal(published.id, automation.id);
  assert.equal(published.owner.personId, id("owner"));
  const followed = await ok(
    await call("recipient", `${item}/follow`, { method: "PUT" }, capabilities),
  );
  assert.ok(Value.Check(ProtectedPublicAutomationResponseSchema, followed));
  assert.equal(followed.automation.following, true);
  const subscribed = await ok(
    await call(
      "recipient",
      `${item}/notifications`,
      { method: "PUT", body: { subscribed: true } },
      capabilities,
    ),
  );
  assert.equal(subscribed.automation.subscribed, true);
  await ok(await call("recipient", `${item}/follow`, { method: "DELETE" }, capabilities), 204);
  assert.equal(
    (
      await call(
        "recipient",
        `${item}/notifications`,
        { method: "PUT", body: { subscribed: true } },
        capabilities,
      )
    ).status,
    404,
  );
  await ok(await call("owner", `${item}/publication`, { method: "DELETE" }, capabilities));
  assert.deepEqual(
    (await ok(await call("recipient", "/automations/public", {}, capabilities))).automations,
    [],
  );
});

void test.skip("retired public automation behavior is no longer a contract", async (t) => {
  const {
    app,
    stateDir,
    storageLimits,
    globalUsage,
    databasePath,
    call,
    ok,
    errorCode,
    id,
    removeMember,
  } = await createSharingFixture(t);
  const publicV1 = "sharing-v1, automations-public-v1";
  const pub = (
    member: Member,
    pathname: string,
    init: { method?: string; body?: object; headers?: Record<string, string> } = {},
  ) => call(member, pathname, init, publicV1);
  const legacyCatalog = await ok(await call("owner", "/automations/catalog"));
  const { automation } = await ok(
    await call("owner", "/automations", {
      method: "POST",
      body: {
        name: "Synthetic public digest",
        instructions: "Summarize synthetic updates.",
        whenToNotify: "Only when useful.",
        agentId: legacyCatalog.defaultAgentId,
        model: { provider: "sparky", id: "synthetic" },
        schedule: { kind: "every", everyMs: 60_000 },
      },
    }),
    201,
  );
  const item = `/automations/${automation.id}`;

  // Clients without automations-public-v1 keep the earlier contract.
  for (const [pathname, method] of [
    ["/automations/public", "GET"],
    [`${item}/publication`, "PUT"],
    [`${item}/follow`, "PUT"],
    [`${item}/notifications`, "PUT"],
  ] as const) {
    const body = method === "PUT" ? { subscribed: true } : undefined;
    assert.equal((await call("owner", pathname, { method, body })).status, 404, pathname);
  }
  const catalog = await ok(await pub("owner", "/automations/catalog"));
  assert.ok(Value.Check(ProtectedAutomationCatalogSchema, catalog));
  const { public: marker, ...automations } = catalog.capabilities.automations;
  assert.deepEqual(marker, { publish: true, follow: true, notifications: true });
  assert.deepEqual(
    { ...catalog, capabilities: { ...catalog.capabilities, automations } },
    {
      ...legacyCatalog,
    },
  );
  assert.deepEqual(
    (await ok(await pub("development", "/automations/catalog"))).capabilities.automations.public,
    { publish: false, follow: false, notifications: false },
  );
  const development = await pub("development", `${item}/publication`, { method: "PUT" });
  assert.equal(development.status, 403);
  assert.equal(await errorCode(development), "sharing_unavailable");
  assert.equal((await ok(await pub("owner", item))).automation.publication, null);

  // Only the owner publishes; following needs a publication.
  assert.equal((await pub("recipient", `${item}/follow`, { method: "PUT" })).status, 404);
  assert.equal((await pub("recipient", `${item}/publication`, { method: "PUT" })).status, 404);
  const published = await ok(await pub("owner", `${item}/publication`, { method: "PUT" }));
  assert.ok(Value.Check(ProtectedAutomationResponseSchema, published));
  const publishedAt = published.automation.publication?.publishedAt;
  assert.ok(publishedAt);
  assert.deepEqual(published.automation.publication, { publishedAt, followers: 0 });
  assert.deepEqual(
    (await ok(await pub("owner", `${item}/publication`, { method: "PUT" }))).automation.publication,
    { publishedAt, followers: 0 },
  );
  const { publication: _, ...legacyRecord } = published.automation;
  assert.deepEqual((await ok(await call("owner", item))).automation, legacyRecord);
  assert.deepEqual((await ok(await call("owner", "/automations"))).automations, [legacyRecord]);

  const server = createProtectedServer("https://alcove.example", app.fetch);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const followUrl = `http://127.0.0.1:${address.port}/api/protected/v1${item}/follow`;
  const followHeaders = {
    origin: "https://alcove.example",
    "x-test-subject": subjects.recipient,
    "x-grogu-profile": id("recipient"),
    "X-Alcove-Capabilities": publicV1,
  };
  try {
    for (const [contentType, body, subscribed] of [
      [undefined, undefined, false],
      ["application/json", undefined, false],
      ["application/json", "{}", false],
      ["application/json", '{"subscribed":true}', true],
      ["application/json", '{"subscribed":false}', false],
    ] as const) {
      const response = await fetch(followUrl, {
        method: "PUT",
        headers: { ...followHeaders, ...(contentType ? { "content-type": contentType } : {}) },
        body,
      });
      assert.equal((await ok(response)).automation.subscribed, subscribed);
      await ok(await fetch(followUrl, { method: "DELETE", headers: followHeaders }), 204);
    }
    for (const [contentType, body, status] of [
      [undefined, "not json", 400],
      ["application/json", "not json", 400],
      ["application/json", " ".repeat(48_001), 413],
    ] as const) {
      const response = await fetch(followUrl, {
        method: "PUT",
        headers: { ...followHeaders, ...(contentType ? { "content-type": contentType } : {}) },
        body,
      });
      assert.equal(response.status, status);
      assert.equal(
        await errorCode(response),
        status === 413 ? "request_too_large" : "invalid_request",
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const listed = await ok(await pub("recipient", "/automations/public"));
  assert.ok(Value.Check(ProtectedPublicAutomationsResponseSchema, listed));
  const expected = {
    id: automation.id,
    name: automation.name,
    instructions: automation.instructions,
    whenToNotify: automation.whenToNotify,
    schedule: automation.schedule,
    state: automation.state,
    nextCheckAt: null,
    owner: { personId: id("owner"), displayName: "Synthetic Owner" },
    publishedAt,
    followers: 0,
    following: false,
    subscribed: false,
  };
  assert.deepEqual(listed.automations, [expected]);
  assert.deepEqual((await ok(await pub("owner", "/automations/public"))).automations, [expected]);

  // Following starts unsubscribed; notifications are a follower opt-in.
  const followed = await ok(await pub("recipient", `${item}/follow`, { method: "PUT" }));
  assert.ok(Value.Check(ProtectedPublicAutomationResponseSchema, followed));
  assert.deepEqual(followed.automation, { ...expected, followers: 1, following: true });
  assert.equal((await pub("owner", `${item}/follow`, { method: "PUT" })).status, 404);
  const invalidFollow = await pub("second", `${item}/follow`, {
    method: "PUT",
    body: { subscribed: "yes" },
  });
  assert.equal(invalidFollow.status, 400);
  await ok(await pub("second", `${item}/follow`, { method: "PUT", body: { subscribed: true } }));
  const subscribed = await ok(
    await pub("recipient", `${item}/notifications`, { method: "PUT", body: { subscribed: true } }),
  );
  assert.deepEqual(subscribed.automation, {
    ...expected,
    followers: 2,
    following: true,
    subscribed: true,
  });
  assert.equal(
    (
      await pub("outsider", `${item}/notifications`, {
        method: "PUT",
        body: { subscribed: true },
      })
    ).status,
    404,
  );
  assert.deepEqual((await ok(await pub("owner", item))).automation.publication, {
    publishedAt,
    followers: 2,
  });
  await ok(
    await pub("recipient", `${item}/notifications`, { method: "PUT", body: { subscribed: false } }),
  );

  // Followers read runs and results under the owner; owner routes stay owner-only.
  const run = await commitProtectedAutomationFinishedResult(
    stateDir,
    {
      automationId: automation.id,
      definitionRevision: 1,
      centralOwnerProfileId: id("owner"),
      jobId: "synthetic-job",
      runAtMs: 1_000,
      runId: randomUUID(),
      completedAtMs: 2_000,
      automationName: automation.name,
      privateFinalText: "Synthetic run result.",
      transcript: { sessionKey: "synthetic-session-key", sessionId: randomUUID() },
    },
    {
      profileId: id("owner"),
      revalidate: async () => {},
      assertCurrent: () => {},
      enrollPublication: () => ({ finish: () => {} }),
      reserveStorage: async () => ({ settle: () => {}, release: () => {} }),
      retainUncertainCommit: () => {},
    },
  );
  assert.equal(run.status, "created");
  const runId = run.status === "created" ? run.id : "";
  const member = (name: Member) => ({ profileId: id(name), assertCurrent() {} });
  const access = (name: Member) => canMemberReadAutomation(stateDir, member(name), automation.id);
  const runAccess = (name: Member, target = runId) =>
    canMemberReadAutomationRun(stateDir, member(name), {
      automationId: automation.id,
      runId: target,
    });
  const asOwner = { ownerProfileId: id("owner"), relation: "owner" };
  const asFollower = { ownerProfileId: id("owner"), relation: "follower" };
  assert.deepEqual(await access("owner"), asOwner);
  assert.deepEqual(await access("recipient"), asFollower);
  assert.equal(await access("outsider"), undefined);
  assert.deepEqual(await runAccess("recipient"), asFollower);
  assert.equal(await runAccess("recipient", randomUUID()), undefined);
  assert.equal(await runAccess("outsider"), undefined);
  const results = "sharing-v1, automations-public-v1, automation-results-v1";
  const runs = `${item}/runs`;
  for (const pathname of [runs, `${runs}/${runId}`]) {
    assert.deepEqual(
      await ok(await call("recipient", pathname, {}, results)),
      await ok(await call("owner", pathname, {}, "automation-results-v1")),
    );
  }
  for (const [name, capabilities, pathname] of [
    ["outsider", results, runs],
    ["recipient", "sharing-v1, automation-results-v1", runs],
    ["recipient", results, `${runs}/${randomUUID()}`],
  ] as const) {
    const denied = await call(name, pathname, {}, capabilities);
    assert.equal(denied.status, 404, `${name} ${pathname}`);
    assert.equal(await errorCode(denied), "not_found");
  }
  for (const [pathname, method, body] of [
    [item, "GET", undefined],
    [item, "PATCH", { name: "Taken" }],
    [`${item}/publication`, "DELETE", undefined],
  ] as const) {
    const headers = { "if-match": legacyRecord.version };
    assert.equal(
      (await pub("recipient", pathname, { method, body, headers })).status,
      404,
      pathname,
    );
  }

  // Owner edits keep the publication and its followers.
  const renamed = await ok(
    await pub("owner", item, {
      method: "PATCH",
      body: { name: "Renamed public digest" },
      headers: { "if-match": legacyRecord.version },
    }),
  );
  assert.deepEqual(renamed.automation.publication, { publishedAt, followers: 2 });
  assert.equal(
    (await ok(await pub("second", "/automations/public"))).automations[0].name,
    "Renamed public digest",
  );
  const usage = await runProtectedSharing(
    stateDir,
    "protectedSharing.storageUsage",
    4096,
    () => {},
  );
  assert.deepEqual(
    usage
      .filter((entry) => entry.id.startsWith("automation-"))
      .map((entry) => entry.profileId)
      .toSorted(),
    [id("owner"), id("recipient"), id("second")].toSorted(),
  );

  // Leaving stops access and notifications; unpublishing removes every follower.
  await ok(await pub("second", `${item}/follow`, { method: "DELETE" }), 204);
  assert.equal(await access("second"), undefined);
  assert.equal(
    (await ok(await pub("second", "/automations/public"))).automations[0].following,
    false,
  );
  const unpublished = await ok(await pub("owner", `${item}/publication`, { method: "DELETE" }));
  assert.equal(unpublished.automation.publication, null);
  assert.equal(await access("recipient"), undefined);
  assert.equal(await runAccess("recipient"), undefined);
  assert.equal((await call("recipient", runs, {}, results)).status, 404);
  const unavailable = await pub("recipient", "/automations/public");
  assert.equal(unavailable.status, 503);
  assert.equal(await errorCode(unavailable), "public_automations_unavailable");
  const countRows = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return [
        "SELECT count(*) AS count FROM protected_automation_publications",
        "SELECT count(*) AS count FROM protected_automation_subscriptions",
        "SELECT count(*) AS count FROM protected_automation_members WHERE role = 'follower'",
      ].map((query) => db.prepare(query).get()?.count);
    } finally {
      db.close();
    }
  };
  assert.deepEqual(countRows(), [0, 0, 0]);

  // Unpublishing and member removal retire exactly the ledger entries they delete.
  // The ledger retires by entry identity; removal does not need the measured bytes.
  const sorted = (entries: readonly { id: string; profileId: string }[]) =>
    entries
      .filter((entry) => entry.id.startsWith("automation-"))
      .map((entry) => ({ id: entry.id, profileId: entry.profileId }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  const sharingEntries = async () =>
    sorted(await runProtectedSharing(stateDir, "protectedSharing.storageUsage", 4096, () => {}));
  await ok(await pub("owner", `${item}/publication`, { method: "PUT" }));
  await ok(await pub("second", `${item}/follow`, { method: "PUT" }));
  const charged = await sharingEntries();
  assert.deepEqual(
    charged.map((entry) => entry.profileId),
    [id("second"), id("owner")],
  );
  const unpublishedEntries = await runProtectedSharing(
    stateDir,
    "protectedSharing.unpublishAutomation",
    { profileId: id("owner"), automationId: automation.id, storageOverheadBytes: 4096 },
    () => {},
  );
  assert.deepEqual(sorted(unpublishedEntries ?? []), charged);
  assert.deepEqual(await sharingEntries(), []);

  // Removing a follower or the owner from Alcove removes their access.
  await ok(await pub("owner", `${item}/publication`, { method: "PUT" }));
  await ok(await pub("second", `${item}/follow`, { method: "PUT", body: { subscribed: true } }));
  await ok(await pub("outsider", `${item}/follow`, { method: "PUT", body: { subscribed: true } }));
  storageLimits.globalBytes = (await globalUsage()) + storageEntryOverheadBytes / 2;
  assert.equal((await pub("recipient", `${item}/follow`, { method: "PUT" })).status, 413);
  await removeMember("second");
  await t.test("member removal immediately releases a removed follower's quota", async () => {
    await ok(await pub("recipient", `${item}/follow`, { method: "PUT" }));
  });
  storageLimits.globalBytes = 50_000_000;
  await ok(await pub("recipient", `${item}/follow`, { method: "DELETE" }), 204);
  const exactEntries = async () =>
    (
      await runProtectedSharing(
        stateDir,
        "protectedSharing.storageUsage",
        storageEntryOverheadBytes,
        () => {},
      )
    )
      .filter((entry) => entry.id.startsWith("automation-"))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  const ownerEntries = await exactEntries();
  assert.deepEqual(
    ownerEntries.map((entry) => entry.profileId),
    [id("outsider"), id("owner")],
  );
  const ownerAdmission = (await listProtectedAdmissions(stateDir)).find(
    (entry) => entry.subject === subjects.owner,
  );
  assert.ok(ownerAdmission);
  // The committed receipt carries the exact quota entries of the publication and its follows;
  // the uncertain-commit recovery settles from the same receipt.
  const retired: { id: string; profileId: string }[] = [];
  const retiredChanges: StoredDataRetirement[] = [];
  await removeProtectedAdmission(
    stateDir,
    { id: ownerAdmission.id, issuer: "https://access.example", ownerSubject: subjects.admin },
    () => {},
    (_subject, _profileId, _automations, changes) => retiredChanges.push(...changes),
    () => {},
    {
      profileId: id("owner"),
      admissionRevision: ownerAdmission.revision,
      revalidate: async () => {},
      assertWritersStopped: () => {},
      enrollPublication: () => ({ finish: () => {} }),
      retireStorage: (entries) => retired.push(...entries),
      retainUncertainRemovalCommit: () => assert.fail("Removal should commit."),
    },
  );
  assert.deepEqual(sorted(retired), []);
  assert.deepEqual(
    retiredChanges.toSorted((a, b) => a.removed.id.localeCompare(b.removed.id)),
    ownerEntries.map((removed) => ({ removed })),
  );
  assert.equal(await access("outsider"), undefined);
  assert.deepEqual((await ok(await pub("outsider", "/automations/public"))).automations, []);
  assert.deepEqual(countRows(), [0, 0, 0]);
});

void test("deleting a published automation unpublishes it and removes its followers", async (t) => {
  const { app, stateDir, databasePath, call, ok, id } = await createSharingFixture(t);
  const capabilities = "sharing-v1, automations-public-v1, automation-delete-v1";
  const pub = (
    member: Member,
    pathname: string,
    init: { method?: string; body?: object; headers?: Record<string, string> } = {},
  ) => call(member, pathname, init, capabilities);
  const catalog = await ok(await pub("owner", "/automations/catalog"));
  const { automation } = await ok(
    await pub("owner", "/automations", {
      method: "POST",
      body: {
        name: "Synthetic doomed digest",
        instructions: "Summarize synthetic updates.",
        whenToNotify: "Only when useful.",
        agentId: catalog.defaultAgentId,
        model: { provider: "sparky", id: "synthetic" },
        schedule: { kind: "every", everyMs: 3_600_000 },
      },
    }),
    201,
  );
  const item = `/automations/${automation.id}`;
  const version = automation.version;
  await runProtectedSharing(
    stateDir,
    "protectedSharing.publishAutomation",
    {
      profileId: id("owner"),
      automationId: automation.id,
      now: 1_000,
      storageOverheadBytes: storageEntryOverheadBytes,
    },
    () => {},
  );
  seedLegacyPublication(databasePath, automation.id, id("recipient"));
  const member = (name: Member) => ({ profileId: id(name), assertCurrent() {} });
  await app.startAutomations(() => {});

  // The deletion plan retires the publication and follow ledger entries with the definition.
  const sorted = (entries: readonly { id: string; profileId: string }[]) =>
    entries
      .filter((entry) => entry.id.startsWith("automation-"))
      .map((entry) => ({ id: entry.id, profileId: entry.profileId }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  const charged = sorted(
    await runProtectedSharing(stateDir, "protectedSharing.storageUsage", 4096, () => {}),
  );
  assert.deepEqual(
    charged.map((entry) => entry.profileId),
    [id("recipient"), id("owner")],
  );
  const plan = await runOpenClawStateWorkerOperation(
    captureProtectedStateWorkerContext(stateDir),
    (scope) =>
      scope.execute({
        type: "protectedAutomationLifecycle.prepare",
        input: {
          command: {
            kind: "remove",
            profileId: id("owner"),
            automationId: automation.id,
            expectedRevision: Number(version),
          },
          entryOverheadBytes: 4096,
        },
      }),
  );
  assert.equal(plan.status, "prepared");
  assert.deepEqual(sorted(plan.status === "prepared" ? plan.write.retired : []), charged);

  const remove = (name: Member) =>
    pub(name, item, { method: "DELETE", headers: { "if-match": version } });
  assert.equal((await remove("recipient")).status, 404);
  await ok(await remove("owner"), 204);
  assert.equal(
    await canMemberReadAutomation(stateDir, member("recipient"), automation.id),
    undefined,
  );
  assert.deepEqual((await ok(await pub("recipient", "/automations/public"))).automations, []);
  assert.deepEqual(
    await runProtectedSharing(stateDir, "protectedSharing.storageUsage", 4096, () => {}),
    [],
  );
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      [
        "SELECT count(*) AS count FROM protected_automation_publications",
        "SELECT count(*) AS count FROM protected_automation_subscriptions",
        "SELECT count(*) AS count FROM protected_automation_members",
      ].map((query) => db.prepare(query).get()?.count),
      [0, 0, 0],
    );
  } finally {
    db.close();
  }
});
