import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { Value } from "typebox/value";
import {
  ProtectedChatShareResponseSchema,
  ProtectedShareClaimResponseSchema,
  ProtectedSharedChatResponseSchema,
  ProtectedSharedChatsResponseSchema,
} from "../../packages/gateway-protocol/src/protected-sharing.js";
import { ProtectedMeSchema } from "../../packages/gateway-protocol/src/protected.js";
import { appendTranscriptMessage } from "../../src/config/sessions/session-accessor.js";
import { closeSessionTranscriptReconcileWorkerPool } from "../../src/config/sessions/session-transcript-reconcile-pool.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { migrateProtectedSubjects } from "./admission-store.js";
import { createProtectedAgentCatalog } from "./agents.js";
import { chatArtifactsDirectory } from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import {
  canMemberReadChat,
  canMemberReadChatArtifact,
  runProtectedSharing,
} from "./sharing-store.js";

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

void test("chat links grant live read-only access until revoked", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-sharing-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const issuer = "https://access.example";
  const subjects = {
    admin: "00000000-0000-4000-8000-000000000001",
    owner: "00000000-0000-4000-8000-000000000002",
    recipient: "00000000-0000-4000-8000-000000000003",
    second: "00000000-0000-4000-8000-000000000004",
    outsider: "00000000-0000-4000-8000-000000000005",
    development: `service-token:${"d".repeat(32)}.access`,
  };
  type Member = keyof typeof subjects;
  const allowed = new Set<string>(Object.values(subjects));
  const expiresAt = Date.now() + 120_000;
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [...allowed] });
  const encryption = createStorageValueEncryption(randomBytes(32));
  const usersRoot = await root(usersDir);
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
    storageLimits: { globalBytes: 50_000_000, userBytes: 10_000_000, freeFloorBytes: 1 },
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
  const { people } = await ok(await call("admin", "/admin/people"));
  const personId = (name: Member) =>
    people.find((person: { subject?: string }) => person.subject === subjects[name]).id;
  await ok(
    await call("admin", `/admin/people/${personId("recipient")}/remove`, {
      method: "POST",
      body: {},
    }),
  );
  assert.deepEqual(countRows(), [1, 1]);
  assert.equal((await claim("second", nextShare.share.id)).status, 404);
  await ok(await call("second", `/shared/chats/${id("owner")}/${next.id}`));
  await ok(
    await call("admin", `/admin/people/${personId("owner")}/remove`, { method: "POST", body: {} }),
  );
  assert.equal((await call("second", `/shared/chats/${id("owner")}/${next.id}`)).status, 404);
  assert.deepEqual((await ok(await call("second", "/shared/chats"))).chats, []);
  assert.deepEqual(countRows(), [0, 0]);
});
