import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import type {
  ProtectedAutomationLifecycleAuthority,
  ProtectedAutomationLifecycleCommand,
} from "../../src/state/protected-automation-lifecycle.types.js";
import { createProtectedAutomationWithAdmission } from "../../src/state/protected-automation-operations.js";
import type {
  PreparedProtectedAutomationFinishedResult,
  ProtectedAutomationResultAdmission,
  ProtectedAutomationResultPublicationOutcome,
  ProtectedAutomationResultStorageEntry,
  ProtectedAutomationResultUncertainCommit,
} from "../../src/state/protected-automation-results.types.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import { addProtectedSubject, bindProtectedProfile } from "./admission-store.js";
import {
  canReadProtectedIsolatedAutomationRunChat,
  writeProtectedAutomationLifecycle,
} from "./automation-lifecycle-store.js";
import { handleProtectedAutomationResultsRoute } from "./automation-results-http.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import { storageEntryOverheadBytes } from "./capacity.js";
import { ProtectedError } from "./errors.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";

const issuer = "https://synthetic.example";
const finalText = "Synthetic private final answer with enough text to notice in storage.";

async function createFixture(
  t: { after(fn: () => Promise<void>): void },
  contextAccess?: ProtectedAutomationDraft["contextAccess"],
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-automation-results-"));
  const stateDir = path.join(home, "state");
  const keyPath = path.join(home, "key");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const previousKey = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath };
  const databasePath = resolveOpenClawStateSqlitePath(env);
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    if (previousKey === undefined) {
      delete process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
    } else {
      process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = previousKey;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await rm(home, { recursive: true, force: true });
  });
  await prepareProtectedSharedState(stateDir, () => {});

  const addMember = async () => {
    const subject = randomUUID();
    assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "added");
    const profile = await ensureCanonicalUserProfileForVerifiedIdentity(
      { issuer, subject },
      { env },
    );
    assert.equal(
      await bindProtectedProfile(stateDir, { issuer, subject, profileId: profile.id }),
      true,
    );
    return profile.id;
  };
  const ownerId = await addMember();
  const otherId = await addMember();
  const definition: ProtectedAutomationDraft = {
    name: "Synthetic results automation",
    instructions: "Summarize synthetic material.",
    whenToNotify: "Only when useful.",
    agentId: "research",
    model: { provider: "sparky", id: "00000000-0000-4000-8000-000000000001" },
    thinking: "low",
    schedule: { kind: "every", everyMs: 60_000 },
    ...(contextAccess === undefined ? {} : { contextAccess }),
  };
  const created = await createProtectedAutomationWithAdmission(
    captureProtectedStateWorkerContext(stateDir),
    { profileId: ownerId, definition, now: 1 },
    { profileId: ownerId, assertCurrent: () => {}, admitStorage: () => {} },
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    throw new Error("Synthetic automation was not created.");
  }
  const automationId = created.automation.id;
  const rows = <Row>(query: string, ...values: string[]) => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return db.prepare(query).all(...values) as Row[];
    } finally {
      db.close();
    }
  };
  const finished = (
    overrides: Partial<PreparedProtectedAutomationFinishedResult> = {},
  ): PreparedProtectedAutomationFinishedResult => ({
    automationId,
    definitionRevision: 1,
    centralOwnerProfileId: ownerId,
    jobId: "synthetic-job",
    runAtMs: 1_000,
    runId: randomUUID(),
    completedAtMs: 2_000,
    automationName: definition.name,
    privateFinalText: finalText,
    transcript: { sessionKey: "synthetic-session-key", sessionId: randomUUID() },
    ...overrides,
  });
  const createAutomation = async (
    profileId: string,
    access: ProtectedAutomationDraft["contextAccess"],
    name: string,
  ) => {
    const additionalAutomation = await createProtectedAutomationWithAdmission(
      captureProtectedStateWorkerContext(stateDir),
      {
        profileId,
        definition: { ...definition, contextAccess: access, name },
        now: 2,
      },
      { profileId, assertCurrent: () => {}, admitStorage: () => {} },
    );
    assert.equal(additionalAutomation.status, "created");
    if (additionalAutomation.status !== "created") {
      throw new Error("Synthetic automation was not created.");
    }
    return additionalAutomation.automation.id;
  };
  return { stateDir, ownerId, otherId, automationId, rows, finished, definition, createAutomation };
}

function lifecycleAuthority(profileId: string): ProtectedAutomationLifecycleAuthority {
  return {
    profileId,
    revalidate: async () => {},
    assertCurrent() {},
    enrollPublication: () => ({ finish() {} }),
    reserveStorage: async () => ({ settle() {}, release() {} }),
    reserveReplacement: async () => ({ settle() {}, release() {} }),
    reserveBatchReplacement: async () => ({ settle() {}, release() {} }),
    reserveRecipient: async () => undefined,
    retireStorage() {},
    retainUncertainCommit() {},
  };
}

type WithoutLifecycleOwner<Command> = Command extends unknown
  ? Omit<Command, "profileId" | "automationId">
  : never;

async function recordRunChat(
  stateDir: string,
  profileId: string,
  automationId: string,
  chatId: string,
  contextAccess: "member" | "isolated",
  finish = true,
) {
  const authority = lifecycleAuthority(profileId);
  const runId = randomUUID();
  const write = (command: WithoutLifecycleOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(stateDir, { ...command, profileId, automationId }, authority);
  assert.equal((await write({ kind: "provision" })).status, "committed");
  assert.equal(
    (
      await write({
        kind: "queue",
        runId,
        definitionRevision: 1,
        contextAccess,
        trigger: "manual",
        scheduledAtMs: 10,
        now: 10,
      })
    ).status,
    "committed",
  );
  assert.equal((await write({ kind: "start", runId, chatId, now: 11 })).status, "committed");
  if (!finish) {
    return;
  }
  assert.equal(
    (
      await write({
        kind: "finish",
        runId,
        now: 12,
        outcome: { status: "failed", errorCode: "turn_failed" },
      })
    ).status,
    "committed",
  );
}

function admission(
  profileId: string,
  options: { onReserve?: () => void; failSettle?: boolean; closed?: boolean } = {},
) {
  let revoked = false;
  const calls = {
    reserved: [] as number[],
    settled: [] as ProtectedAutomationResultStorageEntry[][],
    released: 0,
    outcomes: [] as ProtectedAutomationResultPublicationOutcome[],
    retained: [] as ProtectedAutomationResultUncertainCommit[],
  };
  const authority: ProtectedAutomationResultAdmission = {
    profileId,
    revalidate: async () => {
      if (revoked) {
        throw new Error("Synthetic authority revoked.");
      }
    },
    assertCurrent: () => {
      if (revoked) {
        throw new Error("Synthetic authority revoked.");
      }
    },
    enrollPublication: () => {
      if (options.closed) {
        throw new Error("Synthetic admission closed.");
      }
      return { finish: (outcome) => calls.outcomes.push(outcome) };
    },
    reserveStorage: async (bytes) => {
      calls.reserved.push(bytes);
      options.onReserve?.();
      return {
        settle: ({ entries }) => {
          if (options.failSettle) {
            throw new Error("Synthetic settlement failure.");
          }
          calls.settled.push(entries);
        },
        release: () => {
          calls.released += 1;
        },
      };
    },
    retainUncertainCommit: (handle) => calls.retained.push(handle),
  };
  return {
    authority,
    calls,
    revoke: () => {
      revoked = true;
    },
  };
}

const readAuthority = (profileId: string) => ({
  profileId,
  assertCurrent: () => {},
  revalidate: async () => {},
});

void test("a finished run is stored sealed, charged once to its owner, and readable only by the owner", async (t) => {
  const fixture = await createFixture(t);
  const input = fixture.finished();
  const owner = admission(fixture.ownerId);
  const created = await commitProtectedAutomationFinishedResult(
    fixture.stateDir,
    input,
    owner.authority,
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    return;
  }

  const [row] = fixture.rows<{
    payload_json: string;
    stored: number;
    charged_bytes: number;
    central_owner_profile_id: string;
  }>(
    "SELECT payload_json, length(CAST(payload_json AS BLOB)) AS stored, charged_bytes, central_owner_profile_id FROM protected_automation_runs WHERE id = ?",
    created.id,
  );
  assert.ok(row);
  assert.equal(row.payload_json.includes(finalText), false);
  assert.equal(row.central_owner_profile_id, fixture.ownerId);
  const entries = [
    {
      id: `protected-automation-run:${created.id}`,
      profileId: fixture.ownerId,
      bytes: row.stored + storageEntryOverheadBytes,
    },
  ];
  assert.equal(row.charged_bytes, entries[0]!.bytes);
  assert.deepEqual(owner.calls.reserved, [entries[0]!.bytes]);
  assert.deepEqual(owner.calls.settled, [entries]);
  assert.equal(owner.calls.released, 0);
  assert.deepEqual(owner.calls.outcomes, ["settled"]);
  assert.deepEqual(
    await readProtectedAutomationResultStorageUsage(fixture.stateDir, () => {}),
    entries,
  );

  const run = {
    id: created.id,
    automationId: fixture.automationId,
    version: created.version,
    definitionRevision: 1,
    runId: input.runId,
    runAtMs: input.runAtMs,
    completedAtMs: input.completedAtMs,
    automationName: input.automationName,
    text: finalText,
  };
  const ownerRead = readAuthority(fixture.ownerId);
  assert.deepEqual(
    await handleProtectedAutomationResultsRoute(
      fixture.stateDir,
      { method: "GET", pathname: `/automations/${fixture.automationId}/runs` },
      ownerRead,
    ),
    { status: 200, body: { runs: [run] } },
  );
  assert.deepEqual(
    await handleProtectedAutomationResultsRoute(
      fixture.stateDir,
      { method: "GET", pathname: `/automations/${fixture.automationId}/runs/${created.id}` },
      ownerRead,
    ),
    { status: 200, body: { run } },
  );

  const notFound = (error: unknown) =>
    error instanceof ProtectedError && error.status === 404 && error.code === "not_found";
  const foreign = readAuthority(fixture.otherId);
  for (const pathname of [
    `/automations/${fixture.automationId}/runs`,
    `/automations/${fixture.automationId}/runs/${created.id}`,
  ]) {
    await assert.rejects(
      handleProtectedAutomationResultsRoute(fixture.stateDir, { method: "GET", pathname }, foreign),
      notFound,
    );
  }
  await assert.rejects(
    handleProtectedAutomationResultsRoute(
      fixture.stateDir,
      { method: "GET", pathname: `/automations/${randomUUID()}/runs` },
      ownerRead,
    ),
    notFound,
  );
  await assert.rejects(
    handleProtectedAutomationResultsRoute(
      fixture.stateDir,
      { method: "GET", pathname: `/automations/${fixture.automationId}/runs/${randomUUID()}` },
      ownerRead,
    ),
    notFound,
  );
  for (const request of [
    { method: "POST", pathname: `/automations/${fixture.automationId}/runs` },
    { method: "GET", pathname: `/automations/${fixture.automationId}` },
  ]) {
    assert.equal(
      await handleProtectedAutomationResultsRoute(fixture.stateDir, request, ownerRead),
      undefined,
    );
  }
});

void test("isolated run chat access follows recorded owner origin, not definition name", async (t) => {
  const fixture = await createFixture(t, "isolated");
  const isolatedRunChatId = randomUUID();
  await recordRunChat(
    fixture.stateDir,
    fixture.ownerId,
    fixture.automationId,
    isolatedRunChatId,
    "isolated",
  );

  const memberAutomationId = await fixture.createAutomation(
    fixture.ownerId,
    "member",
    "Synthetic isolated run",
  );
  const memberRunChatId = randomUUID();
  await recordRunChat(
    fixture.stateDir,
    fixture.ownerId,
    memberAutomationId,
    memberRunChatId,
    "member",
  );

  const foreignAutomationId = await fixture.createAutomation(
    fixture.otherId,
    "isolated",
    "Synthetic isolated run",
  );
  const foreignRunChatId = randomUUID();
  await recordRunChat(
    fixture.stateDir,
    fixture.otherId,
    foreignAutomationId,
    foreignRunChatId,
    "isolated",
  );

  const check = (input: {
    action: "list" | "history" | "send" | "status" | "search";
    currentChatId?: string;
    targetChatId: string;
  }) =>
    canReadProtectedIsolatedAutomationRunChat(
      fixture.stateDir,
      {
        action: input.action,
        currentChatId: input.currentChatId ?? randomUUID(),
        targetChatId: input.targetChatId,
      },
      readAuthority(fixture.ownerId),
    );

  assert.equal(await check({ action: "list", targetChatId: isolatedRunChatId }), true);
  assert.equal(await check({ action: "history", targetChatId: isolatedRunChatId }), true);

  const activeAutomationId = await fixture.createAutomation(
    fixture.ownerId,
    "isolated",
    "Another isolated run",
  );
  const activeRunChatId = randomUUID();
  await recordRunChat(
    fixture.stateDir,
    fixture.ownerId,
    activeAutomationId,
    activeRunChatId,
    "isolated",
    false,
  );
  assert.equal(await check({ action: "history", targetChatId: activeRunChatId }), true);

  assert.equal(await check({ action: "history", targetChatId: randomUUID() }), false);
  assert.equal(await check({ action: "history", targetChatId: foreignRunChatId }), false);
  assert.equal(await check({ action: "list", targetChatId: memberRunChatId }), false);
  assert.equal(await check({ action: "search", targetChatId: isolatedRunChatId }), false);
  assert.equal(
    await check({
      action: "history",
      currentChatId: isolatedRunChatId,
      targetChatId: isolatedRunChatId,
    }),
    false,
  );
  assert.equal(await check({ action: "send", targetChatId: isolatedRunChatId }), false);
});

void test("native run identity is idempotent, conflicts on changed content, and refuses non-owners before reserving", async (t) => {
  const fixture = await createFixture(t);
  const input = fixture.finished();
  const first = admission(fixture.ownerId);
  const created = await commitProtectedAutomationFinishedResult(
    fixture.stateDir,
    input,
    first.authority,
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    return;
  }

  const repeat = admission(fixture.ownerId);
  assert.deepEqual(
    await commitProtectedAutomationFinishedResult(fixture.stateDir, input, repeat.authority),
    { status: "duplicate", id: created.id, version: created.version },
  );
  const changed = admission(fixture.ownerId);
  assert.deepEqual(
    await commitProtectedAutomationFinishedResult(
      fixture.stateDir,
      { ...input, privateFinalText: `${finalText} changed` },
      changed.authority,
    ),
    { status: "conflict" },
  );
  const foreign = admission(fixture.otherId);
  assert.deepEqual(
    await commitProtectedAutomationFinishedResult(
      fixture.stateDir,
      { ...input, runId: randomUUID(), centralOwnerProfileId: fixture.otherId },
      foreign.authority,
    ),
    { status: "not-owner" },
  );
  for (const attempt of [repeat, changed, foreign]) {
    assert.deepEqual(attempt.calls.reserved, []);
    assert.deepEqual(attempt.calls.outcomes, ["settled"]);
  }
  assert.equal(
    fixture.rows(
      "SELECT id FROM protected_automation_runs WHERE automation_id = ?",
      fixture.automationId,
    ).length,
    1,
  );

  const later = fixture.finished({ runId: randomUUID(), completedAtMs: 3_000 });
  assert.equal(
    (
      await commitProtectedAutomationFinishedResult(
        fixture.stateDir,
        later,
        admission(fixture.ownerId).authority,
      )
    ).status,
    "created",
  );
  const listed = await handleProtectedAutomationResultsRoute(
    fixture.stateDir,
    { method: "GET", pathname: `/automations/${fixture.automationId}/runs` },
    readAuthority(fixture.ownerId),
  );
  assert.ok(listed);
  assert.deepEqual(
    (listed.body as { runs: { runId: string }[] }).runs.map((run) => run.runId),
    [later.runId, input.runId],
  );

  // Missing text is refused before any effect; an explicit empty string is a real empty result.
  const missing = admission(fixture.ownerId);
  await assert.rejects(
    commitProtectedAutomationFinishedResult(
      fixture.stateDir,
      { ...fixture.finished(), privateFinalText: undefined as unknown as string },
      missing.authority,
    ),
    TypeError,
  );
  assert.deepEqual(missing.calls.reserved, []);
  assert.deepEqual(missing.calls.outcomes, []);
  const empty = await commitProtectedAutomationFinishedResult(
    fixture.stateDir,
    fixture.finished({ runId: randomUUID(), privateFinalText: "" }),
    admission(fixture.ownerId).authority,
  );
  assert.equal(empty.status, "created");
  if (empty.status === "created") {
    const detail = await handleProtectedAutomationResultsRoute(
      fixture.stateDir,
      { method: "GET", pathname: `/automations/${fixture.automationId}/runs/${empty.id}` },
      readAuthority(fixture.ownerId),
    );
    assert.ok(detail);
    assert.equal((detail.body as { run: { text: string } }).run.text, "");
  }
});

void test("lost authority, a closed admission, or a failed settlement never lose a reservation or a result", async (t) => {
  const fixture = await createFixture(t);

  const closed = admission(fixture.ownerId, { closed: true });
  await assert.rejects(
    commitProtectedAutomationFinishedResult(fixture.stateDir, fixture.finished(), closed.authority),
    /admission closed/u,
  );
  assert.deepEqual(closed.calls.reserved, []);
  assert.deepEqual(closed.calls.outcomes, []);

  const revoking: { revoke?: () => void } = {};
  const lost = admission(fixture.ownerId, { onReserve: () => revoking.revoke?.() });
  revoking.revoke = lost.revoke;
  await assert.rejects(
    commitProtectedAutomationFinishedResult(fixture.stateDir, fixture.finished(), lost.authority),
    /authority revoked/u,
  );
  assert.equal(lost.calls.reserved.length, 1);
  assert.equal(lost.calls.released, 1);
  assert.deepEqual(lost.calls.settled, []);
  assert.deepEqual(lost.calls.outcomes, ["settled"]);
  assert.equal(fixture.rows("SELECT id FROM protected_automation_runs").length, 0);

  // The commit is durable but its quota settlement failed: keep custody, never refund or retry.
  const input = fixture.finished();
  const failing = admission(fixture.ownerId, { failSettle: true });
  await assert.rejects(
    commitProtectedAutomationFinishedResult(fixture.stateDir, input, failing.authority),
    (error) => error instanceof SqliteWorkerError && error.code === "outcome-unknown",
  );
  const [row] = fixture.rows<{ id: string; version: string }>(
    "SELECT id, version FROM protected_automation_runs",
  );
  assert.ok(row);
  assert.equal(failing.calls.released, 0);
  assert.equal(failing.calls.retained.length, 1);
  assert.equal(failing.calls.retained[0]!.expectedReceipt.id, row.id);
  assert.equal(failing.calls.retained[0]!.expectedReceipt.version, row.version);
  assert.deepEqual(failing.calls.outcomes, ["recovery-required"]);
});
