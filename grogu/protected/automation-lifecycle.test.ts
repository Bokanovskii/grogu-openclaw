import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { root } from "../../src/infra/fs-safe.js";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../../src/state/openclaw-state-worker-store.js";
import type {
  ProtectedAutomationMemberRetirementAuthority,
  ProtectedAutomationRetirementUncertainCommit,
} from "../../src/state/protected-automation-lifecycle.types.js";
import {
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
} from "../../src/state/protected-automation-operations.js";
import type { ProtectedAutomationResultAdmission } from "../../src/state/protected-automation-results.types.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import {
  addProtectedSubject,
  bindProtectedProfile,
  listProtectedAdmissions,
  removeProtectedAdmission,
} from "./admission-store.js";
import { createProtectedAgentCatalog } from "./agents.js";
import {
  listProtectedAutomationLifecycleRuns,
  listProtectedAutomationOwnerInbox,
  readProtectedAutomationLastScheduledAttempt,
  readProtectedAutomationLifecycleStorageUsage,
  readProtectedAutomationRunChat,
  writeProtectedAutomationLifecycle,
  writeProtectedAutomationLifecycleForOwner,
  readProtectedAutomationInterruptedRunForOwner,
  type ProtectedAutomationLifecycleAuthority,
  type ProtectedAutomationLifecycleCommand,
  type ProtectedAutomationLifecycleUncertainCommit,
  type ProtectedAutomationLifecycleOwnerAuthority,
} from "./automation-lifecycle-store.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import { createProtectedAutomationStorageRecoveryOwner } from "./automation-storage-recovery.js";
import {
  createProtectedAutomationRecord,
  readOwnedProtectedAutomationStorageRecord,
  saveProtectedAutomationPatch,
} from "./automations-store.js";
import { createProtectedAutomationCatalog } from "./automations.js";
import { createStorageAdmission, storageEntryOverheadBytes } from "./capacity.js";
import { createProtectedChats } from "./chats.js";
import {
  readProtectedFeedbackStorageUsage,
  submitProtectedFeedbackReport,
} from "./feedback-store.js";
import { runProtectedSharing } from "./sharing-store.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";
import {
  createStoredDataReplacementReservation,
  createStoredDataBatchReplacementReservation,
  createStoredDataReservation,
  retireStoredData,
  storedDataEntryKey,
  type StoredDataLedger,
} from "./storage-entry-quota.js";

const issuer = "https://synthetic.example";
type WithoutOwner<Command> = Command extends unknown
  ? Omit<Command, "profileId" | "automationId">
  : never;

function queuedAdmission(definitionRevision: number, contextAccess: "member" | "isolated") {
  return { status: "committed", admission: { definitionRevision, contextAccess } };
}

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: Pick<ProtectedAutomationDraft, "contextAccess" | "pacing"> = {},
) {
  const home = path.resolve(".artifacts", `automation-lifecycle-${randomUUID()}`);
  const stateDir = path.join(home, "state");
  const keyPath = path.join(home, "key");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const previous = {
    state: process.env.OPENCLAW_STATE_DIR,
    key: process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE,
  };
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath };
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    if (previous.state === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous.state;
    }
    if (previous.key === undefined) {
      delete process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
    } else {
      process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = previous.key;
    }
    await rm(home, { recursive: true, force: true });
  });
  await prepareProtectedSharedState(stateDir, () => {});
  const member = async () => {
    const subject = randomUUID();
    await addProtectedSubject(stateDir, { issuer, subject });
    const profile = await ensureCanonicalUserProfileForVerifiedIdentity(
      { issuer, subject },
      { env },
    );
    await bindProtectedProfile(stateDir, { issuer, subject, profileId: profile.id });
    return { id: profile.id, subject };
  };
  const ownerMember = await member();
  const otherMember = await member();
  const ownerId = ownerMember.id;
  const otherId = otherMember.id;
  const definition: ProtectedAutomationDraft = {
    name: "Synthetic lifecycle",
    instructions: "Summarize synthetic material.",
    whenToNotify: "When useful.",
    agentId: "research",
    model: { provider: "sparky", id: "00000000-0000-4000-8000-000000000001" },
    thinking: "low",
    schedule: { kind: "every", everyMs: 60_000 },
    ...options,
  };
  const context = captureProtectedStateWorkerContext(stateDir);
  const mutationAuthority = { profileId: ownerId, assertCurrent: () => {}, admitStorage: () => {} };
  const created = await createProtectedAutomationWithAdmission(
    context,
    { profileId: ownerId, definition, now: 1 },
    mutationAuthority,
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    throw new Error("Synthetic automation was not created.");
  }
  const automationId = created.automation.id;
  const enabled = await patchProtectedAutomationWithAdmission(
    context,
    {
      profileId: ownerId,
      automationId,
      expectedRevision: 1,
      definition,
      enabled: true,
      now: 2,
    },
    mutationAuthority,
  );
  assert.equal(enabled.status, "updated");
  if (enabled.status !== "updated") {
    throw new Error("Synthetic automation was not enabled.");
  }
  return {
    member,
    stateDir,
    ownerId,
    otherId,
    automationId,
    revision: enabled.automation.definitionRevision,
    ownerSubject: ownerMember.subject,
    operatorSubject: otherMember.subject,
    definition,
  };
}

function authority(profileId: string) {
  const ledger: StoredDataLedger = {
    globalBytes: 0,
    users: new Map(),
    storedEntries: new Map(),
    retiredStoredEntries: new Map(),
  };
  let quota = Number.MAX_SAFE_INTEGER;
  let revoked = false;
  let revokeOnReserve = false;
  let failRetirement = false;
  let pending = 0;
  const uncertain: ProtectedAutomationLifecycleUncertainCommit[] = [];
  // Followers charge their own receipt to their own authority; unknown or over-quota ones are skipped.
  const recipients = new Map<string, ProtectedAutomationLifecycleAuthority>();
  const assertCurrent = () => {
    if (revoked) {
      throw new Error("Synthetic authority revoked.");
    }
  };
  const options = {
    account: ledger,
    profileId,
    charge: (bytes: number) => {
      if (ledger.globalBytes + bytes > quota) {
        throw new Error("Synthetic quota exceeded.");
      }
      ledger.globalBytes += bytes;
      ledger.users.set(profileId, (ledger.users.get(profileId) ?? 0) + bytes);
    },
    refund: (bytes: number) => {
      ledger.globalBytes -= bytes;
      ledger.users.set(profileId, (ledger.users.get(profileId) ?? 0) - bytes);
    },
    begin: () => {
      pending++;
    },
    finish: () => {
      pending--;
    },
  };
  const admission: ProtectedAutomationLifecycleAuthority = {
    profileId,
    assertCurrent,
    revalidate: async () => assertCurrent(),
    enrollPublication: () => ({ finish: () => {} }),
    reserveStorage: async (bytes) => {
      const reservation = createStoredDataReservation({ ...options, bytes });
      if (revokeOnReserve) {
        revoked = true;
      }
      return reservation;
    },
    reserveReplacement: async (change) =>
      createStoredDataReplacementReservation({ ...options, change }),
    reserveBatchReplacement: async (change) =>
      createStoredDataBatchReplacementReservation({ ...options, change }),
    reserveRecipient: async (recipientId, change) => {
      const recipient = recipients.get(recipientId);
      if (!recipient) {
        return undefined;
      }
      try {
        if (change.previous) {
          const previous = change.previous;
          const held = await recipient.reserveReplacement({ previous, current: change.current });
          return {
            settle: () => held.settle(change.current),
            release: () => held.release(previous),
          };
        }
        const held = await recipient.reserveStorage(change.current.bytes);
        return {
          settle: () => held.settle({ created: true, entries: [change.current] }),
          release: () => held.release(),
        };
      } catch {
        return undefined;
      }
    },
    retireStorage: (entries) => {
      if (failRetirement) {
        throw new Error("Synthetic retirement settlement failed.");
      }
      for (const removed of entries) {
        retireStoredData(ledger, { removed });
      }
    },
    retainUncertainCommit: (handle) => uncertain.push(handle),
  };
  const resultAdmission: ProtectedAutomationResultAdmission = {
    profileId,
    assertCurrent,
    revalidate: admission.revalidate,
    enrollPublication: admission.enrollPublication,
    reserveStorage: admission.reserveStorage,
    retainUncertainCommit: () => {
      throw new Error("Unexpected uncertain result write.");
    },
  };
  return {
    admission,
    resultAdmission,
    ledger,
    uncertain,
    recipients,
    quota: (value: number) => {
      quota = value;
    },
    revokeOnReserve: () => {
      revokeOnReserve = true;
    },
    restore: () => {
      revoked = false;
      revokeOnReserve = false;
    },
    failRetirement: (value: boolean) => {
      failRetirement = value;
    },
    pending: () => pending,
  };
}

void test("enabling and starting a provisioned automation reuse prepared storage", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId).admission;
  let scans = 0;
  let background = Promise.resolve();
  const admit = createStorageAdmission({
    stateDir: f.stateDir,
    usersRoot: await root(f.stateDir),
    maxFileBytes: 1024,
    limits: { userBytes: 32 * 1024 * 1024, globalBytes: 32 * 1024 * 1024, freeFloorBytes: 1 },
    chats: { capacityEntries: async () => [], transcriptBytes: async () => 0 },
    storedDataUsage: async () => {
      scans++;
      return readProtectedAutomationLifecycleStorageUsage(f.stateDir, owner.assertCurrent);
    },
    idleMeasurement: {
      assertCurrent: owner.assertCurrent,
      track: (work) => {
        background = work;
      },
    },
  });
  const storage = (kind: "automation" | "create" | "turn") =>
    admit(f.ownerId, owner.assertCurrent, kind);
  const lifecycle = {
    ...owner,
    reserveStorage: (bytes: number) =>
      admit.reserveStoredData(f.ownerId, owner.assertCurrent, bytes),
    retireStorage: (entries: Parameters<typeof owner.retireStorage>[0]) =>
      admit.retiredStoredData(entries.map((removed) => ({ removed }))),
  };
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      lifecycle,
    );
  const catalog = createProtectedAutomationCatalog({
    agents: { defaultAgentId: f.definition.agentId, agents: [] },
    models: [
      { ...f.definition.model, label: "Synthetic", thinking: { levels: ["low"], default: "low" } },
    ],
  });
  assert.ok(catalog);
  const cold = await storage("automation");
  cold.release();
  await background;
  const readsBeforePatch = scans;
  const saved = await saveProtectedAutomationPatch(
    f.stateDir,
    {
      automationId: f.automationId,
      expectedVersion: String(f.revision),
      patch: { enabled: true },
      catalog,
      retainedAgent: (id) => ({ id }),
    },
    owner,
    {
      revalidate: owner.revalidate,
      schedulerAvailable: true,
      admitStorage: () => storage("automation"),
      provision: async () => {
        assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
        assert.equal(
          scans,
          readsBeforePatch,
          "provision and enable share the prepared measurement",
        );
      },
    },
  );
  assert.equal(saved.status, "updated");
  await background;
  const readsBeforeRun = scans;
  const runId = randomUUID();
  const chatId = randomUUID();
  const revision = Number(saved.automation.version);
  assert.deepEqual(
    await write({
      kind: "queue",
      runId,
      definitionRevision: revision,
      contextAccess: "member",
      trigger: "manual",
      scheduledAtMs: 10,
      now: 10,
    }),
    queuedAdmission(revision, "member"),
  );
  assert.deepEqual(await write({ kind: "start", runId, chatId, now: 11 }), { status: "committed" });
  const create = await storage("create");
  create.recordCreatedChat(chatId, "synthetic-run");
  const turn = await storage("turn");
  create.release();
  assert.equal(
    scans,
    readsBeforeRun,
    "no foreground or intervening background scan before the run",
  );
  assert.equal(turn.scanMs, 0);
  t.diagnostic(
    `Automation fixture: cold scan ${cold.scanMs.toFixed(2)} ms; first run turn scan ${turn.scanMs.toFixed(2)} ms, queue ${turn.queueMs.toFixed(2)} ms`,
  );
  turn.release();
  await background;
});

void test("isolated automation results require a matching active run", async (t) => {
  const f = await fixture(t, { contextAccess: "isolated" });
  const owner = authority(f.ownerId);
  const runId = randomUUID();
  const chatId = randomUUID();
  const result = {
    automationId: f.automationId,
    centralOwnerProfileId: f.ownerId,
    definitionRevision: f.revision,
    jobId: f.automationId,
    runId,
    runAtMs: 10,
    completedAtMs: 15,
    automationName: f.definition.name,
    privateFinalText: "Synthetic isolated result.",
    transcript: { sessionKey: "synthetic-isolated-run", sessionId: chatId },
  };
  const save = (input: Parameters<typeof commitProtectedAutomationFinishedResult>[1] = result) =>
    commitProtectedAutomationFinishedResult(f.stateDir, input, owner.resultAdmission);
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    );

  assert.deepEqual(await save(), { status: "conflict" });
  assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
  assert.deepEqual(await save(), { status: "conflict" });
  assert.deepEqual(
    await write({
      kind: "queue",
      runId,
      definitionRevision: f.revision,
      contextAccess: "isolated",
      trigger: "manual",
      scheduledAtMs: 10,
      now: 10,
    }),
    queuedAdmission(f.revision, "isolated"),
  );
  assert.deepEqual(await save(), { status: "conflict" });
  assert.deepEqual(await write({ kind: "start", runId, chatId, now: 11 }), {
    status: "committed",
  });
  assert.deepEqual(await save({ ...result, runId: randomUUID() }), { status: "conflict" });
  assert.deepEqual(
    await save({ ...result, transcript: { ...result.transcript, sessionId: randomUUID() } }),
    { status: "conflict" },
  );
  const saved = await save();
  assert.equal(saved.status, "created");
  if (saved.status !== "created") {
    throw new Error("Synthetic isolated result was not created.");
  }
  assert.deepEqual(
    await write({
      kind: "finish",
      runId,
      now: 15,
      outcome: { status: "succeeded", resultId: saved.id },
    }),
    { status: "committed" },
  );
  assert.deepEqual(await save({ ...result, runId: randomUUID() }), { status: "conflict" });
  for (let index = 0; index < 50; index++) {
    const now = 100 + index;
    assert.deepEqual(
      await write({
        kind: "refuse",
        runId: randomUUID(),
        definitionRevision: f.revision,
        trigger: "manual",
        scheduledAtMs: now,
        now,
        errorCode: "quota_exceeded",
      }),
      { status: "committed" },
    );
  }
  const retained = await listProtectedAutomationLifecycleRuns(
    f.stateDir,
    f.automationId,
    owner.admission,
  );
  assert.ok(retained);
  assert.equal(
    retained.some((entry) => entry.id === runId),
    false,
  );
  assert.deepEqual(await readProtectedAutomationResultStorageUsage(f.stateDir, () => {}), []);
  const skipped = retained.find((entry) => entry.status === "skipped");
  assert.ok(skipped);
  assert.deepEqual(
    await save({
      ...result,
      runId: skipped.id,
      runAtMs: skipped.scheduledAtMs,
      completedAtMs: skipped.scheduledAtMs + 1,
    }),
    { status: "conflict" },
  );
});

void test("isolated automation edits wait until the active run settles", async (t) => {
  const f = await fixture(t, { contextAccess: "isolated" });
  const owner = authority(f.ownerId);
  const runId = randomUUID();
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    );
  const patch = () =>
    patchProtectedAutomationWithAdmission(
      captureProtectedStateWorkerContext(f.stateDir),
      {
        profileId: f.ownerId,
        automationId: f.automationId,
        expectedRevision: f.revision,
        definition: { ...f.definition, instructions: "Updated synthetic instructions." },
        now: 20,
      },
      { profileId: f.ownerId, assertCurrent: () => {}, admitStorage: () => {} },
    );

  assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
  assert.deepEqual(
    await write({
      kind: "queue",
      runId,
      definitionRevision: f.revision,
      contextAccess: "isolated",
      trigger: "manual",
      scheduledAtMs: 10,
      now: 10,
    }),
    queuedAdmission(f.revision, "isolated"),
  );
  assert.deepEqual(await patch(), { status: "automation_busy" });
  assert.deepEqual(await write({ kind: "start", runId, chatId: randomUUID(), now: 11 }), {
    status: "committed",
  });
  assert.deepEqual(await patch(), { status: "automation_busy" });
  assert.deepEqual(
    await write({
      kind: "finish",
      runId,
      now: 15,
      outcome: { status: "failed", errorCode: "turn_failed" },
    }),
    { status: "committed" },
  );
  assert.equal((await patch()).status, "updated");
});

void test("isolated automation creation refuses identities with retained run history", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      { kind: "provision", profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    ),
    { status: "committed" },
  );
  const chatId = randomUUID();
  const lifecycleId = randomUUID();
  const resultId = randomUUID();
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: f.stateDir });
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      "INSERT INTO protected_automation_run_chats (automation_id, profile_id, chat_id, charged_bytes) VALUES (?, ?, ?, 1)",
    ).run(chatId, f.ownerId, randomUUID());
    db.prepare(
      "INSERT INTO protected_automation_run_lifecycle (id, automation_id, profile_id, definition_revision, trigger, scheduled_at_ms, queued_at_ms, status, charged_bytes) VALUES (?, ?, ?, 1, 'manual', 1, 1, 'queued', 0)",
    ).run(randomUUID(), lifecycleId, f.ownerId);
    db.prepare(
      "INSERT INTO protected_automation_runs (id, automation_id, central_owner_profile_id, job_id, run_at_ms, native_run_id, version, definition_revision, completed_at_ms, payload_json, charged_bytes) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 2, '{}', 0)",
    ).run(randomUUID(), resultId, f.ownerId, randomUUID(), randomUUID(), randomUUID());
  } finally {
    db.close();
  }
  const context = captureProtectedStateWorkerContext(f.stateDir);
  const mutation = { profileId: f.ownerId, assertCurrent: () => {}, admitStorage: () => {} };
  for (const automationId of [chatId, lifecycleId, resultId]) {
    await assert.rejects(
      createProtectedAutomationWithAdmission(
        context,
        {
          profileId: f.ownerId,
          automationId,
          definition: { ...f.definition, contextAccess: "isolated" },
          now: 3,
        },
        mutation,
      ),
      /retained run history/u,
    );
  }
});

void test("isolated creation retains its lease and storage until a failed receipt settles", async (t) => {
  const f = await fixture(t);
  const automationId = randomUUID();
  const recovery = createProtectedAutomationStorageRecoveryOwner(() => {});
  let pending = 0;
  let charged = 0;
  let committed = 0;
  let failSettlement = true;
  const storage = {
    chargeAutomationCreate(bytes: number) {
      charged += bytes;
    },
    settleAutomationCreate(bytes: number, created: boolean) {
      if (created && failSettlement) {
        throw new Error("Synthetic creation receipt settlement failed.");
      }
      if (created) {
        committed += bytes;
      } else {
        charged -= bytes;
      }
    },
    retainPendingWrite() {
      pending++;
      return () => {
        pending--;
      };
    },
    assertResult() {},
  };
  const create = () =>
    createProtectedAutomationRecord(
      f.stateDir,
      {
        profileId: f.ownerId,
        automationId,
        definition: { ...f.definition, contextAccess: "isolated" },
        now: 3,
      },
      { profileId: f.ownerId, assertCurrent() {} },
      storage,
      {
        hasRunHistory: async () => false,
        enrollPublication: recovery.enrollPublication,
        retainUncertainCreateCommit: recovery.retainUncertainCreateCommit,
        reconcile() {},
      },
    );
  await assert.rejects(
    create(),
    (error: unknown) => error instanceof SqliteWorkerError && error.code === "outcome-unknown",
  );
  assert.equal(recovery.status().pending, 1);
  assert.equal(pending, 1);
  assert.ok(charged > 0);
  assert.equal(committed, 0);
  await assert.rejects(create(), /requires storage recovery/u);
  assert.equal(pending, 1);
  failSettlement = false;
  assert.deepEqual(await recovery.reconcile(), { resolved: 1, pending: 0 });
  assert.equal(committed, charged);
  assert.equal(pending, 0);
  assert.equal((await create())?.id, automationId);
  assert.equal(
    (
      await readOwnedProtectedAutomationStorageRecord(f.stateDir, automationId, {
        profileId: f.ownerId,
        assertCurrent() {},
      })
    )?.definition.contextAccess,
    "isolated",
  );
});

void test("stale member runs cannot queue against a recreated isolated automation", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  const usersDir = path.join(f.stateDir, "users");
  await mkdir(usersDir);
  const chats = createProtectedChats({
    stateDir: f.stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([]),
    usersRoot: await root(usersDir),
    maxFileBytes: 64_000,
  });
  const chatAuthority = { profileId: f.ownerId, assertCurrent() {} };
  const stale = await readOwnedProtectedAutomationStorageRecord(
    f.stateDir,
    f.automationId,
    chatAuthority,
  );
  assert.ok(stale);
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      {
        kind: "remove",
        profileId: f.ownerId,
        automationId: f.automationId,
        expectedRevision: stale.definitionRevision,
      },
      { ...owner.admission, retireDefinition() {} },
    ),
    { status: "committed" },
  );
  const recreated = await createProtectedAutomationRecord(
    f.stateDir,
    {
      profileId: f.ownerId,
      automationId: f.automationId,
      definition: { ...f.definition, contextAccess: "isolated" },
      now: 20,
    },
    chatAuthority,
    {
      chargeAutomationCreate() {},
      settleAutomationCreate() {},
      retainPendingWrite: () => () => {},
      assertResult() {},
    },
    {
      hasRunHistory: (id) => chats.hasAutomationRunHistory(chatAuthority, id),
      enrollPublication: () => ({ finish() {} }),
      retainUncertainCreateCommit: () => assert.fail("Unexpected uncertain creation."),
      reconcile() {},
    },
  );
  assert.ok(recreated);
  const enabled = await patchProtectedAutomationWithAdmission(
    captureProtectedStateWorkerContext(f.stateDir),
    {
      profileId: f.ownerId,
      automationId: f.automationId,
      expectedRevision: Number(recreated.version),
      definition: { ...f.definition, contextAccess: "isolated" },
      enabled: true,
      now: 21,
    },
    { ...chatAuthority, admitStorage() {} },
  );
  assert.equal(enabled.status, "updated");
  if (enabled.status !== "updated") {
    throw new Error("Synthetic isolated automation was not enabled.");
  }
  assert.equal(enabled.automation.definitionRevision, stale.definitionRevision);
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      { kind: "provision", profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    ),
    { status: "committed" },
  );
  for (const trigger of ["manual", "scheduled"] as const) {
    assert.deepEqual(
      await writeProtectedAutomationLifecycle(
        f.stateDir,
        {
          kind: "queue",
          profileId: f.ownerId,
          automationId: f.automationId,
          runId: randomUUID(),
          definitionRevision: stale.definitionRevision,
          contextAccess: stale.definition.contextAccess ?? "member",
          trigger,
          scheduledAtMs: 30,
          now: 30,
        },
        owner.admission,
      ),
      { status: "definition-changed" },
    );
  }
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      {
        kind: "queue",
        profileId: f.ownerId,
        automationId: f.automationId,
        runId: randomUUID(),
        definitionRevision: enabled.automation.definitionRevision,
        contextAccess: "isolated",
        trigger: "manual",
        scheduledAtMs: 31,
        now: 31,
      },
      owner.admission,
    ),
    queuedAdmission(enabled.automation.definitionRevision, "isolated"),
  );
});

void test("queue reports a definition change after preparation without creating a run", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      { kind: "provision", profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    ),
    { status: "committed" },
  );
  let validations = 0;
  const admission: ProtectedAutomationLifecycleAuthority = {
    ...owner.admission,
    revalidate: async () => {
      await owner.admission.revalidate();
      if (++validations === 2) {
        const updated = await patchProtectedAutomationWithAdmission(
          captureProtectedStateWorkerContext(f.stateDir),
          {
            profileId: f.ownerId,
            automationId: f.automationId,
            expectedRevision: f.revision,
            definition: { ...f.definition, name: "Updated during queue admission" },
            enabled: true,
            now: 20,
          },
          { profileId: f.ownerId, assertCurrent() {}, admitStorage() {} },
        );
        assert.equal(updated.status, "updated");
      }
    },
  };
  assert.deepEqual(
    await writeProtectedAutomationLifecycle(
      f.stateDir,
      {
        kind: "queue",
        profileId: f.ownerId,
        automationId: f.automationId,
        runId: randomUUID(),
        definitionRevision: f.revision,
        contextAccess: "member",
        trigger: "manual",
        scheduledAtMs: 21,
        now: 21,
      },
      admission,
    ),
    { status: "definition-changed" },
  );
  assert.deepEqual(
    await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, owner.admission),
    [],
  );
  assert.deepEqual(owner.uncertain, []);
});

void test("isolated creation waits for deletion before checking orphaned run chats", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  const usersDir = path.join(f.stateDir, "users");
  await mkdir(usersDir);
  const chats = createProtectedChats({
    stateDir: f.stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([]),
    usersRoot: await root(usersDir),
    maxFileBytes: 64_000,
  });
  const chatAuthority = { profileId: f.ownerId, assertCurrent() {} };
  await chats.create(chatAuthority, "Synthetic run", undefined, undefined, {
    chatId: randomUUID(),
    automationId: f.automationId,
  });
  const removalStarted = Promise.withResolvers<void>();
  const releaseRemoval = Promise.withResolvers<void>();
  const creationStarted = Promise.withResolvers<void>();
  t.after(() => releaseRemoval.resolve());
  let held = false;
  const removal = writeProtectedAutomationLifecycle(
    f.stateDir,
    {
      kind: "remove",
      profileId: f.ownerId,
      automationId: f.automationId,
      expectedRevision: f.revision,
    },
    {
      ...owner.admission,
      retireDefinition() {},
      async revalidate() {
        if (!held) {
          held = true;
          removalStarted.resolve();
          await releaseRemoval.promise;
        }
      },
    },
  );
  await removalStarted.promise;
  const creation = createProtectedAutomationRecord(
    f.stateDir,
    {
      profileId: f.ownerId,
      automationId: f.automationId,
      definition: { ...f.definition, contextAccess: "isolated" },
      now: 20,
    },
    chatAuthority,
    {
      chargeAutomationCreate: () => assert.fail("History must be checked before charging."),
      settleAutomationCreate: () => assert.fail("No creation should be settled."),
      retainPendingWrite: () => () => {},
      assertResult() {},
    },
    {
      hasRunHistory: (id) => chats.hasAutomationRunHistory(chatAuthority, id),
      enrollPublication() {
        creationStarted.resolve();
        return { finish() {} };
      },
      retainUncertainCreateCommit: () => assert.fail("No native create should be admitted."),
      reconcile() {},
    },
  );
  void creation.catch(() => {});
  await creationStarted.promise;
  releaseRemoval.resolve();
  assert.deepEqual(await removal, { status: "committed" });
  await assert.rejects(creation, { code: "automation_history_conflict" });
});

void test("restores scheduled failure backoff and ignores manual or replaced runs", async (t) => {
  const f = await fixture(t, { pacing: { minMs: 60_000, maxMs: 360_000 } });
  const owner = authority(f.ownerId);
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    );
  const cursor = async () =>
    (await readProtectedAutomationLastScheduledAttempt(f.stateDir, f.automationId, owner.admission))
      ?.check;
  const queue = async (trigger: "scheduled" | "manual", now: number) => {
    const runId = randomUUID();
    assert.equal(
      (
        await write({
          kind: "queue",
          runId,
          definitionRevision: f.revision,
          contextAccess: "member",
          trigger,
          scheduledAtMs: now,
          now,
        })
      ).status,
      "committed",
    );
    return runId;
  };
  const fail = async (runId: string, now: number) =>
    assert.equal(
      (
        await write({
          kind: "finish",
          runId,
          now,
          outcome: { status: "failed", errorCode: "provider_busy" },
        })
      ).status,
      "committed",
    );
  await write({ kind: "provision" });
  for (const at of [10, 60_011, 120_012]) {
    await fail(await queue("scheduled", at), at + 1);
  }
  const expected = {
    version: String(f.revision),
    atMs: 420_013,
    reason: "backoff",
    consecutiveFailures: 3,
  };
  await closeOpenClawStateDatabaseByPathAsync(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: f.stateDir }),
  );
  assert.deepEqual(await cursor(), expected);
  await fail(await queue("manual", 130_000), 130_001);
  assert.deepEqual(await cursor(), expected);
  const stale = await queue("scheduled", expected.atMs);
  const paused = await patchProtectedAutomationWithAdmission(
    captureProtectedStateWorkerContext(f.stateDir),
    {
      profileId: f.ownerId,
      automationId: f.automationId,
      expectedRevision: f.revision,
      definition: f.definition,
      enabled: false,
      now: expected.atMs + 1,
    },
    { profileId: f.ownerId, assertCurrent() {}, admitStorage() {} },
  );
  assert.equal(paused.status, "updated");
  await fail(stale, expected.atMs + 2);
  assert.deepEqual(await cursor(), expected);
});

void test("paused automations allow manual lifecycle runs but refuse scheduled runs", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    );
  assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
  const scheduledRunId = randomUUID();
  assert.deepEqual(
    await write({
      kind: "queue",
      runId: scheduledRunId,
      definitionRevision: f.revision,
      contextAccess: "member",
      trigger: "scheduled",
      scheduledAtMs: 10,
      now: 10,
    }),
    queuedAdmission(f.revision, "member"),
  );
  const paused = await patchProtectedAutomationWithAdmission(
    captureProtectedStateWorkerContext(f.stateDir),
    {
      profileId: f.ownerId,
      automationId: f.automationId,
      expectedRevision: f.revision,
      definition: f.definition,
      enabled: false,
      now: 11,
    },
    { profileId: f.ownerId, assertCurrent: () => {}, admitStorage: () => {} },
  );
  assert.equal(paused.status, "updated");
  if (paused.status !== "updated") {
    throw new Error("Synthetic automation was not paused.");
  }
  const chatId = randomUUID();
  assert.deepEqual(await write({ kind: "start", runId: scheduledRunId, chatId, now: 12 }), {
    status: "disabled",
  });
  assert.deepEqual(
    await write({
      kind: "finish",
      runId: scheduledRunId,
      now: 12,
      outcome: { status: "skipped", errorCode: "automation_disabled" },
    }),
    { status: "committed" },
  );
  const queue = {
    kind: "queue" as const,
    runId: randomUUID(),
    definitionRevision: paused.automation.definitionRevision,
    contextAccess: "member" as const,
    scheduledAtMs: 13,
    now: 13,
  };
  assert.deepEqual(await write({ ...queue, trigger: "scheduled" }), { status: "disabled" });
  assert.deepEqual(
    await write({ ...queue, trigger: "manual" }),
    queuedAdmission(queue.definitionRevision, "member"),
  );
  assert.deepEqual(await write({ ...queue, runId: randomUUID(), trigger: "manual" }), {
    status: "busy",
  });
  assert.deepEqual(await write({ kind: "start", runId: queue.runId, chatId, now: 14 }), {
    status: "committed",
  });
  const result = await commitProtectedAutomationFinishedResult(
    f.stateDir,
    {
      automationId: f.automationId,
      centralOwnerProfileId: f.ownerId,
      definitionRevision: queue.definitionRevision,
      jobId: f.automationId,
      runId: queue.runId,
      runAtMs: queue.scheduledAtMs,
      completedAtMs: 15,
      automationName: f.definition.name,
      privateFinalText: "Synthetic paused-run result.",
      transcript: { sessionKey: "synthetic-paused-run", sessionId: chatId },
    },
    owner.resultAdmission,
  );
  assert.equal(result.status, "created");
  if (result.status !== "created") {
    throw new Error("Synthetic paused-run result was not created.");
  }
  assert.deepEqual(
    await write({
      kind: "finish",
      runId: queue.runId,
      now: 15,
      outcome: { status: "succeeded", resultId: result.id },
    }),
    { status: "committed" },
  );
  const automation = await readOwnedProtectedAutomationStorageRecord(
    f.stateDir,
    f.automationId,
    owner.admission,
  );
  assert.equal(automation?.enabled, false);
});

void test("worker-backed lifecycle admission, sealed-result delivery, retention and quota settlement", async (t) => {
  const f = await fixture(t);
  const owner = authority(f.ownerId);
  let operatorCurrent = true;
  const assertOperator = () => {
    if (!operatorCurrent) {
      throw new Error("Synthetic service owner revoked.");
    }
  };
  const recovery = createProtectedAutomationStorageRecoveryOwner(assertOperator);
  const control: ProtectedAutomationLifecycleOwnerAuthority = {
    ...owner.admission,
    operator: { issuer, subject: f.operatorSubject, profileId: f.otherId },
    assertCurrent: assertOperator,
    revalidate: async () => assertOperator(),
    assertOwnerCurrent: assertOperator,
    assertRunStopped: () => {},
  };
  const writeAsOwner = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycleForOwner(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      control,
    );
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      {
        ...command,
        profileId: f.ownerId,
        automationId: f.automationId,
      },
      owner.admission,
    );
  const runId = randomUUID();
  const chatId = randomUUID();
  const queue: ProtectedAutomationLifecycleCommand = {
    kind: "queue",
    profileId: f.ownerId,
    automationId: f.automationId,
    runId,
    definitionRevision: f.revision,
    contextAccess: "member",
    trigger: "scheduled",
    scheduledAtMs: 1_000,
    now: 1_000,
  };

  await t.test("refuses quota and stale authority before creating charged rows", async () => {
    assert.deepEqual(await writeProtectedAutomationLifecycle(f.stateDir, queue, owner.admission), {
      status: "not-provisioned",
    });
    owner.quota(0);
    await assert.rejects(write({ kind: "provision" }), /quota exceeded/);
    assert.deepEqual(
      await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, owner.admission),
      [],
    );
    assert.equal(owner.ledger.globalBytes, 0);
    owner.quota(Number.MAX_SAFE_INTEGER);
    owner.revokeOnReserve();
    await assert.rejects(write({ kind: "provision" }), /authority revoked/);
    owner.restore();
    assert.equal(owner.ledger.globalBytes, 0);
    assert.equal(owner.pending(), 0);
    assert.equal(
      (
        await commitProtectedAutomationFinishedResult(
          f.stateDir,
          {
            automationId: f.automationId,
            centralOwnerProfileId: f.ownerId,
            definitionRevision: f.revision,
            jobId: f.automationId,
            runId: randomUUID(),
            runAtMs: 900,
            completedAtMs: 901,
            automationName: "Synthetic legacy result",
            privateFinalText: "Synthetic legacy text.",
            transcript: { sessionKey: "synthetic-legacy", sessionId: chatId },
          },
          owner.resultAdmission,
        )
      ).status,
      "created",
    );
    assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
  });

  await t.test(
    "owns one chat, excludes foreign reads, and requires a committed result before inbox delivery",
    async () => {
      const other = authority(f.otherId);
      assert.deepEqual(
        await writeProtectedAutomationLifecycle(
          f.stateDir,
          { ...queue, profileId: f.otherId },
          other.admission,
        ),
        { status: "not-owner" },
      );
      assert.equal(
        await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, other.admission),
        undefined,
      );
      assert.deepEqual(await listProtectedAutomationOwnerInbox(f.stateDir, other.admission), []);
      assert.deepEqual(
        await writeProtectedAutomationLifecycle(f.stateDir, queue, owner.admission),
        queuedAdmission(f.revision, "member"),
      );
      assert.deepEqual(
        await writeProtectedAutomationLifecycle(f.stateDir, queue, owner.admission),
        { status: "unchanged" },
      );
      assert.deepEqual(
        await writeProtectedAutomationLifecycle(
          f.stateDir,
          { ...queue, runId: randomUUID() },
          owner.admission,
        ),
        { status: "busy" },
      );
      assert.deepEqual(await write({ kind: "start", runId, chatId, now: 1_001 }), {
        status: "committed",
      });
      assert.deepEqual(await write({ kind: "deliver", runId, now: 1_003 }), {
        status: "result-missing",
      });
      assert.deepEqual(
        await write({
          kind: "finish",
          runId,
          now: 1_003,
          outcome: { status: "succeeded", resultId: randomUUID() },
        }),
        { status: "result-missing" },
      );

      const result = await commitProtectedAutomationFinishedResult(
        f.stateDir,
        {
          automationId: f.automationId,
          centralOwnerProfileId: f.ownerId,
          definitionRevision: f.revision,
          jobId: f.automationId,
          runId,
          runAtMs: 1_000,
          completedAtMs: 1_002,
          automationName: "Synthetic lifecycle",
          privateFinalText: "Synthetic private final text.",
          transcript: { sessionKey: "synthetic-session-key", sessionId: chatId },
        },
        owner.resultAdmission,
      );
      assert.equal(result.status, "created");
      if (result.status !== "created") {
        throw new Error("Synthetic result was not created.");
      }
      assert.deepEqual(
        await write({
          kind: "finish",
          runId,
          now: 1_003,
          outcome: { status: "succeeded", resultId: result.id },
        }),
        { status: "committed" },
      );
      assert.deepEqual(await write({ kind: "deliver", runId, now: 1_004 }), {
        status: "committed",
      });
      assert.deepEqual(await write({ kind: "deliver", runId, now: 1_005 }), {
        status: "unchanged",
      });
      assert.deepEqual(await listProtectedAutomationOwnerInbox(f.stateDir, owner.admission), [
        {
          runId,
          automationId: f.automationId,
          resultId: result.id,
          createdAtMs: 1_004,
        },
      ]);
      const [run] =
        (await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, owner.admission)) ??
        [];
      assert.equal(run?.runChatId, chatId);
      assert.equal(run?.status, "succeeded");
      const usage = [
        ...(await readProtectedAutomationLifecycleStorageUsage(f.stateDir, () => {})),
        ...(await readProtectedAutomationResultStorageUsage(f.stateDir, () => {})),
      ];
      assert.equal(
        owner.ledger.globalBytes,
        usage.reduce((sum, entry) => sum + entry.bytes, 0),
      );
    },
  );

  await t.test(
    "prunes the oldest run, result and inbox at 50, preserves the chat and scheduled cursor, and replaces quota at capacity",
    async () => {
      const active = randomUUID();
      assert.deepEqual(
        await write({
          kind: "queue",
          runId: active,
          definitionRevision: f.revision,
          contextAccess: "member",
          trigger: "manual",
          scheduledAtMs: 1_005,
          now: 1_005,
        }),
        queuedAdmission(f.revision, "member"),
      );
      assert.deepEqual(await write({ kind: "start", runId: active, chatId, now: 1_006 }), {
        status: "committed",
      });
      for (let index = 0; index < 50; index++) {
        const id = randomUUID();
        const now = 2_000 + index;
        assert.deepEqual(
          await write({
            kind: "refuse",
            runId: id,
            definitionRevision: f.revision,
            trigger: "manual",
            scheduledAtMs: now,
            now,
            errorCode: "quota_exceeded",
          }),
          { status: "committed" },
        );
      }
      assert.deepEqual(
        await readProtectedAutomationInterruptedRunForOwner(f.stateDir, f.automationId, control),
        { runId: active, queuedAtMs: 1_005, startedAtMs: 1_006 },
      );
      control.assertRunStopped = () => {
        throw new Error("Synthetic run still owns native work.");
      };
      await assert.rejects(
        writeAsOwner({
          kind: "finish",
          runId: active,
          now: 2_050,
          outcome: { status: "failed", errorCode: "interrupted" },
        }),
        /still owns native work/,
      );
      control.assertRunStopped = () => {};
      assert.deepEqual(
        await writeAsOwner({
          kind: "finish",
          runId: active,
          now: 2_050,
          outcome: { status: "failed", errorCode: "interrupted" },
        }),
        { status: "committed" },
      );
      const runs = await listProtectedAutomationLifecycleRuns(
        f.stateDir,
        f.automationId,
        owner.admission,
      );
      assert.equal(runs?.length, 50);
      assert.equal(
        runs?.some((run) => run.id === runId),
        false,
      );
      assert.deepEqual(await listProtectedAutomationOwnerInbox(f.stateDir, owner.admission), []);
      assert.deepEqual(await readProtectedAutomationResultStorageUsage(f.stateDir, () => {}), []);
      assert.deepEqual(
        await readProtectedAutomationRunChat(f.stateDir, f.automationId, owner.admission),
        { runChatId: chatId },
      );
      assert.deepEqual(
        await readProtectedAutomationLastScheduledAttempt(
          f.stateDir,
          f.automationId,
          owner.admission,
        ),
        {
          scheduledAtMs: 1_000,
          run: null,
        },
      );
      const bytes = owner.ledger.globalBytes;
      owner.quota(bytes);
      const id = randomUUID();
      assert.deepEqual(
        await write({
          kind: "queue",
          runId: id,
          definitionRevision: f.revision,
          contextAccess: "member",
          trigger: "manual",
          scheduledAtMs: 3_000,
          now: 3_000,
        }),
        queuedAdmission(f.revision, "member"),
      );
      assert.deepEqual(
        await write({ kind: "start", runId: id, chatId: randomUUID(), now: 3_001 }),
        { status: "conflict" },
      );
      owner.quota(0);
      assert.deepEqual(
        await write({
          kind: "finish",
          runId: id,
          now: 3_001,
          outcome: { status: "skipped", errorCode: "quota_exceeded" },
        }),
        { status: "committed" },
      );
      assert.equal(owner.ledger.globalBytes, bytes);
      assert.equal(owner.pending(), 0);
      const refused = randomUUID();
      assert.deepEqual(
        await write({
          kind: "refuse",
          runId: refused,
          definitionRevision: f.revision,
          trigger: "manual",
          scheduledAtMs: 3_002,
          now: 3_002,
          errorCode: "quota_exceeded",
        }),
        { status: "committed" },
      );
      const [latest] =
        (await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, owner.admission)) ??
        [];
      assert.equal(latest?.id, refused);
      assert.equal(latest?.status, "skipped");
      assert.equal(latest?.errorCode, "quota_exceeded");
      assert.equal(owner.ledger.globalBytes, bytes);
      assert.deepEqual(
        await commitProtectedAutomationFinishedResult(
          f.stateDir,
          {
            automationId: f.automationId,
            centralOwnerProfileId: f.ownerId,
            definitionRevision: f.revision,
            jobId: f.automationId,
            runId: randomUUID(),
            runAtMs: 3_003,
            completedAtMs: 3_004,
            automationName: "Synthetic unrelated run",
            privateFinalText: "Synthetic text.",
            transcript: { sessionKey: "synthetic-unrelated", sessionId: chatId },
          },
          owner.resultAdmission,
        ),
        { status: "retention-required" },
      );
    },
  );

  await t.test(
    "unfenced member removal refuses before mutation and cannot manufacture an inactive-member refusal",
    async () => {
      const admissions = await listProtectedAdmissions(f.stateDir);
      const member = admissions.find((entry) => entry.subject === f.ownerSubject);
      assert.ok(member);
      const storage = await readProtectedAutomationLifecycleStorageUsage(
        f.stateDir,
        assertOperator,
      );
      await assert.rejects(
        removeProtectedAdmission(
          f.stateDir,
          { id: member.id, issuer, ownerSubject: f.operatorSubject },
          assertOperator,
          () => {},
          () => {},
        ),
        /requires fenced automation storage retirement authority/,
      );
      assert.equal(
        (await listProtectedAdmissions(f.stateDir)).find((entry) => entry.id === member.id)?.status,
        "approved",
      );
      assert.deepEqual(
        await readProtectedAutomationLifecycleStorageUsage(f.stateDir, assertOperator),
        storage,
      );
      const refusal = {
        kind: "refuse" as const,
        runId: randomUUID(),
        definitionRevision: f.revision - 1,
        trigger: "manual" as const,
        scheduledAtMs: 4_000,
        now: 4_000,
        errorCode: "member_inactive" as const,
      };
      const before = owner.ledger.globalBytes;
      assert.deepEqual(await write(refusal), { status: "not-owner" });
      await assert.rejects(
        writeAsOwner({
          kind: "queue",
          runId: randomUUID(),
          definitionRevision: f.revision,
          contextAccess: "member",
          trigger: "manual",
          scheduledAtMs: 4_000,
          now: 4_000,
        }),
        /cannot execute or publish/,
      );
      assert.deepEqual(await writeAsOwner(refusal), { status: "not-owner" });
      assert.equal(owner.ledger.globalBytes, before);
      assert.equal(
        await readProtectedAutomationInterruptedRunForOwner(f.stateDir, f.automationId, control),
        null,
      );
    },
  );

  await t.test(
    "atomically retires member storage and definitions, rolls back denied commits, and recovers committed retirement",
    async () => {
      owner.quota(Number.MAX_SAFE_INTEGER);
      const publication = randomUUID();
      assert.deepEqual(
        await write({
          kind: "queue",
          runId: publication,
          definitionRevision: f.revision,
          contextAccess: "member",
          trigger: "manual",
          scheduledAtMs: 5_000,
          now: 5_000,
        }),
        queuedAdmission(f.revision, "member"),
      );
      assert.deepEqual(await write({ kind: "start", runId: publication, chatId, now: 5_001 }), {
        status: "committed",
      });
      const result = await commitProtectedAutomationFinishedResult(
        f.stateDir,
        {
          automationId: f.automationId,
          centralOwnerProfileId: f.ownerId,
          definitionRevision: f.revision,
          jobId: f.automationId,
          runId: publication,
          runAtMs: 5_000,
          completedAtMs: 5_002,
          automationName: "Synthetic removal",
          privateFinalText: "Synthetic removal result.",
          transcript: { sessionKey: "synthetic-removal", sessionId: chatId },
        },
        owner.resultAdmission,
      );
      assert.equal(result.status, "created");
      if (result.status !== "created") {
        throw new Error("Synthetic removal result was not created.");
      }
      assert.deepEqual(
        await write({
          kind: "finish",
          runId: publication,
          now: 5_003,
          outcome: { status: "succeeded", resultId: result.id },
        }),
        { status: "committed" },
      );
      assert.deepEqual(await write({ kind: "deliver", runId: publication, now: 5_004 }), {
        status: "committed",
      });
      const other = authority(f.otherId);
      const context = captureProtectedStateWorkerContext(f.stateDir);
      const otherAutomation = await createProtectedAutomationWithAdmission(
        context,
        {
          profileId: f.otherId,
          definition: f.definition,
          now: 5_000,
        },
        { profileId: f.otherId, assertCurrent: assertOperator, admitStorage: () => {} },
      );
      assert.equal(otherAutomation.status, "created");
      if (otherAutomation.status !== "created") {
        throw new Error("Synthetic foreign automation was not created.");
      }
      assert.deepEqual(
        await writeProtectedAutomationLifecycle(
          f.stateDir,
          {
            kind: "provision",
            profileId: f.otherId,
            automationId: otherAutomation.automation.id,
          },
          other.admission,
        ),
        { status: "committed" },
      );
      const member = (await listProtectedAdmissions(f.stateDir)).find(
        (entry) => entry.subject === f.ownerSubject,
      );
      assert.ok(member);
      const input = { id: member.id, issuer, ownerSubject: f.operatorSubject };
      const report = await submitProtectedFeedbackReport(f.stateDir, {
        profileId: f.ownerId,
        memberLabel: "Synthetic member",
        chatId: randomUUID(),
        responseId: randomUUID(),
        submissionId: randomUUID(),
        category: "other",
        description: "Synthetic retained report",
        now: 5_005,
        storageOverheadBytes: 4096,
        chatReference: {
          title: "Synthetic retained chat",
          eventCount: 2,
          digest: "a".repeat(64),
          capturedAt: 5_005,
          files: [],
        },
      });
      assert.equal(report.kind, "created");
      if (report.kind !== "created") {
        throw new Error("Synthetic removal report was not created.");
      }
      const feedback = await readProtectedFeedbackStorageUsage(f.stateDir, 4096, assertOperator);
      for (const entry of feedback) {
        owner.ledger.storedEntries.set(storedDataEntryKey(entry), entry);
        owner.ledger.globalBytes += entry.bytes;
        owner.ledger.users.set(
          entry.profileId,
          (owner.ledger.users.get(entry.profileId) ?? 0) + entry.bytes,
        );
      }
      const description = feedback.find((entry) => entry.id === `report:${report.report.id}`);
      assert.ok(description);
      const before = [
        ...(await readProtectedAutomationLifecycleStorageUsage(f.stateDir, assertOperator)),
        ...(await readProtectedAutomationResultStorageUsage(f.stateDir, assertOperator)),
      ];
      const handles: ProtectedAutomationRetirementUncertainCommit[] = [];
      const definitions: string[] = [];
      let notifications = 0;
      recovery.close();
      const retirement: ProtectedAutomationMemberRetirementAuthority = {
        profileId: f.ownerId,
        admissionRevision: member.revision,
        revalidate: async () => assertOperator(),
        assertWritersStopped: (profileId) => assert.equal(profileId, f.ownerId),
        enrollPublication: recovery.enrollMaintenance,
        retireStorage: owner.admission.retireStorage,
        retainUncertainRemovalCommit: (handle) => {
          handles.push(handle);
          recovery.retainUncertainRemovalCommit(handle);
        },
      };
      const remove = (scope = retirement) =>
        removeProtectedAdmission(
          f.stateDir,
          input,
          assertOperator,
          (_subject, _profileId, retired, changes = []) => {
            definitions.push(...retired.map((entry) => entry.id));
            for (const change of changes) {
              retireStoredData(owner.ledger, change);
            }
          },
          () => {
            notifications++;
          },
          scope,
        );
      await assert.rejects(
        remove({ ...retirement, admissionRevision: member.revision + 1 }),
        /target changed/,
      );
      await assert.rejects(
        remove({
          ...retirement,
          profileId: f.otherId,
          assertWritersStopped: (profileId) => assert.equal(profileId, f.otherId),
        }),
        /target changed/,
      );
      const nativeInput = {
        ...input,
        now: 6_000,
        storageOverheadBytes: 4096,
        retireAutomationStorage: true as const,
        expectedProfileId: f.ownerId,
        expectedRevision: member.revision,
      };
      let deniedCommit = false;
      await assert.rejects(
        runOpenClawStateWorkerOperation(
          context,
          (worker) =>
            worker.execute({ type: "protectedAccess.removeAdmission", input: nativeInput }),
          {
            assertCurrent: assertOperator,
            createAdmission: () => ({
              nativeLocations: [context.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertOperator();
                if (request.stage === "commit") {
                  deniedCommit = true;
                  throw new Error("Synthetic removal commit denied.");
                }
                grant();
              }),
            }),
          },
        ),
        /removal commit denied/,
      );
      assert.equal(deniedCommit, true);
      assert.equal(
        (await listProtectedAdmissions(f.stateDir)).find((entry) => entry.id === member.id)?.status,
        "approved",
      );
      assert.deepEqual(
        [
          ...(await readProtectedAutomationLifecycleStorageUsage(f.stateDir, assertOperator)),
          ...(await readProtectedAutomationResultStorageUsage(f.stateDir, assertOperator)),
        ],
        before,
      );
      owner.failRetirement(true);
      await assert.rejects(
        remove(),
        (error: unknown) => error instanceof SqliteWorkerError && error.code === "outcome-unknown",
      );
      assert.equal(handles.length, 1);
      const handle = handles[0]!;
      assert.equal((await handle.retained.settled).kind, "completed");
      assert.equal(handle.admission.committed !== undefined, true);
      assert.throws(() => recovery.reopen(), /requires recovery/);
      operatorCurrent = false;
      await assert.rejects(recovery.reconcile(), /service owner revoked/);
      assert.equal(recovery.status().pending, 1);
      operatorCurrent = true;
      owner.failRetirement(false);
      assert.deepEqual(await recovery.reconcile(), { resolved: 1, pending: 0 });
      recovery.assertSettled();
      recovery.reopen();
      assert.equal(owner.ledger.globalBytes, description.bytes + 4096 + 64);
      assert.deepEqual(await readProtectedFeedbackStorageUsage(f.stateDir, 4096, assertOperator), [
        ...owner.ledger.storedEntries.values(),
      ]);
      assert.equal(owner.pending(), 0);
      assert.deepEqual(
        await readProtectedAutomationLifecycleStorageUsage(f.stateDir, () => {}),
        before.filter((entry) => entry.profileId === f.otherId),
      );
      assert.deepEqual(
        await readProtectedAutomationResultStorageUsage(f.stateDir, assertOperator),
        [],
      );
      const remaining = await executeOpenClawStateWorker(context, {
        type: "protectedAutomations.storageUsage",
        input: { profileId: f.ownerId },
      });
      assert.deepEqual(
        remaining.entries.map((entry) => ({ id: entry.id, profileId: entry.profileId })),
        [{ id: otherAutomation.automation.id, profileId: f.otherId }],
      );
      assert.deepEqual(definitions, [f.automationId]);
      assert.equal(notifications, 1);
      const removed = (await listProtectedAdmissions(f.stateDir)).find(
        (entry) => entry.id === member.id,
      );
      assert.ok(removed);
      assert.equal(removed.status, "removed");
      recovery.close();
      await assert.rejects(remove(), /target changed/);
      const repaired = await remove({ ...retirement, admissionRevision: removed.revision });
      assert.equal(
        repaired && typeof repaired === "object" ? repaired.status : undefined,
        "removed",
      );
      assert.equal(
        (await listProtectedAdmissions(f.stateDir)).find((entry) => entry.id === member.id)?.status,
        "removed",
      );
      assert.equal(owner.ledger.globalBytes, description.bytes + 4096 + 64);
      recovery.assertSettled();
      recovery.reopen();
      assert.deepEqual(
        await writeAsOwner({
          kind: "refuse",
          runId: randomUUID(),
          definitionRevision: f.revision,
          trigger: "manual",
          scheduledAtMs: 7_000,
          now: 7_000,
          errorCode: "member_inactive",
        }),
        { status: "not-owner" },
      );
      assert.deepEqual(
        await listProtectedAutomationLifecycleRuns(f.stateDir, f.automationId, owner.admission),
        undefined,
      );
    },
  );
});

// Published automation with followers: the owner owns runs and results, each recipient owns and
// pays for its own inbox receipt.
async function receiptFixture(
  t: { after(fn: () => Promise<void>): void },
  contextAccess?: ProtectedAutomationDraft["contextAccess"],
) {
  const f = await fixture(t, { contextAccess });
  const owner = authority(f.ownerId);
  const chatId = randomUUID();
  let clock = 1_000;
  const write = (command: WithoutOwner<ProtectedAutomationLifecycleCommand>) =>
    writeProtectedAutomationLifecycle(
      f.stateDir,
      { ...command, profileId: f.ownerId, automationId: f.automationId },
      owner.admission,
    );
  const sharing = {
    profileId: f.ownerId,
    automationId: f.automationId,
    storageOverheadBytes: storageEntryOverheadBytes,
  };
  assert.deepEqual(await write({ kind: "provision" }), { status: "committed" });
  const published = await runProtectedSharing(
    f.stateDir,
    "protectedSharing.publishAutomation",
    { ...sharing, now: 3 },
    () => {},
  );
  if (contextAccess === "isolated") {
    assert.ok(published?.created);
  } else {
    const db = new DatabaseSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: f.stateDir }));
    try {
      db.prepare("UPDATE protected_automations SET visibility = 'shared' WHERE id = ?").run(
        f.automationId,
      );
      db.prepare(
        "INSERT INTO protected_automation_publications (automation_id, published_at) VALUES (?, 3)",
      ).run(f.automationId);
    } finally {
      db.close();
    }
  }
  const newFollower = async () => {
    const member = await f.member();
    const auth = authority(member.id);
    owner.recipients.set(member.id, auth.admission);
    return { id: member.id, auth };
  };
  const follow = async (who: { id: string }, subscribed: boolean) => {
    if (contextAccess === "isolated") {
      assert.ok(
        (
          await runProtectedSharing(
            f.stateDir,
            "protectedSharing.followAutomation",
            { ...sharing, profileId: who.id, subscribed, now: (clock += 1) },
            () => {},
          )
        )?.created,
      );
    } else {
      const db = new DatabaseSync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: f.stateDir }),
      );
      try {
        db.prepare(
          "INSERT INTO protected_automation_members (automation_id, profile_id, role, added_at) VALUES (?, ?, 'follower', ?)",
        ).run(f.automationId, who.id, (clock += 1));
        if (subscribed) {
          db.prepare(
            "INSERT INTO protected_automation_subscriptions (automation_id, profile_id, subscribed_at) VALUES (?, ?, ?)",
          ).run(f.automationId, who.id, clock);
        }
      } finally {
        db.close();
      }
    }
  };
  const unfollow = (who: { id: string }) =>
    runProtectedSharing(
      f.stateDir,
      "protectedSharing.unfollowAutomation",
      { ...sharing, profileId: who.id },
      () => {},
    );
  const unpublish = () =>
    runProtectedSharing(f.stateDir, "protectedSharing.unpublishAutomation", sharing, () => {});
  // A finished run with a saved result, ready to deliver.
  const run = async () => {
    const runId = randomUUID();
    const now = (clock += 10);
    assert.deepEqual(
      await write({
        kind: "queue",
        runId,
        definitionRevision: f.revision,
        contextAccess: contextAccess ?? "member",
        trigger: "manual",
        scheduledAtMs: now,
        now,
      }),
      queuedAdmission(f.revision, contextAccess ?? "member"),
    );
    assert.deepEqual(await write({ kind: "start", runId, chatId, now: now + 1 }), {
      status: "committed",
    });
    const saved = await commitProtectedAutomationFinishedResult(
      f.stateDir,
      {
        automationId: f.automationId,
        centralOwnerProfileId: f.ownerId,
        definitionRevision: f.revision,
        jobId: f.automationId,
        runId,
        runAtMs: now,
        completedAtMs: now + 2,
        automationName: f.definition.name,
        privateFinalText: "Synthetic private result.",
        transcript: { sessionKey: `synthetic-${runId}`, sessionId: chatId },
      },
      owner.resultAdmission,
    );
    assert.equal(saved.status, "created");
    if (saved.status !== "created") {
      throw new Error("Synthetic result was not created.");
    }
    assert.deepEqual(
      await write({
        kind: "finish",
        runId,
        now: now + 3,
        outcome: { status: "succeeded", resultId: saved.id },
      }),
      { status: "committed" },
    );
    return {
      runId,
      resultId: saved.id,
      runAtMs: now,
      completedAtMs: now + 2,
      deliveredAtMs: now + 4,
    };
  };
  const deliver = (finished: { runId: string; deliveredAtMs: number }) =>
    write({ kind: "deliver", runId: finished.runId, now: finished.deliveredAtMs });
  const inbox = async (profileId: string) =>
    (
      await listProtectedAutomationOwnerInbox(f.stateDir, {
        profileId,
        revalidate: async () => {},
        assertCurrent: () => {},
      })
    )
      .map((entry) => entry.runId)
      .toSorted();
  const receipts = async (profileId: string) =>
    (await readProtectedAutomationLifecycleStorageUsage(f.stateDir, () => {})).filter(
      (entry) =>
        entry.profileId === profileId && entry.id.startsWith("protected-automation-inbox:"),
    );
  return {
    f,
    owner,
    write,
    newFollower,
    follow,
    unfollow,
    unpublish,
    run,
    deliver,
    inbox,
    receipts,
  };
}

void test("follower results require a current grant and an isolated finished run", async (t) => {
  const r = await receiptFixture(t, "isolated");
  const follower = await r.newFollower();
  const run = await r.run();
  const read = (profileId: string, id?: string) =>
    executeOpenClawStateWorker(captureProtectedStateWorkerContext(r.f.stateDir), {
      type: "protectedAutomationResults.publicRuns",
      input: { profileId, automationId: r.f.automationId, id },
    });
  assert.equal(await read(follower.id), undefined);
  await r.follow(follower, false);
  const expected = {
    id: run.resultId,
    runAtMs: run.runAtMs,
    completedAtMs: run.completedAtMs,
    text: "Synthetic private result.",
  };
  assert.deepEqual(await read(follower.id), [expected]);
  assert.deepEqual(await read(follower.id, run.resultId), [expected]);
  assert.deepEqual(await read(follower.id, randomUUID()), []);
  await r.unfollow(follower);
  assert.equal(await read(follower.id), undefined);
  await r.follow(follower, false);
  await r.unpublish();
  assert.equal(await read(follower.id), undefined);
});

void test("follower results refuse legacy member-context runs", async (t) => {
  const legacy = await receiptFixture(t, "member");
  const legacyFollower = await legacy.newFollower();
  await legacy.follow(legacyFollower, false);
  const privateRun = await legacy.run();
  assert.equal(
    await executeOpenClawStateWorker(captureProtectedStateWorkerContext(legacy.f.stateDir), {
      type: "protectedAutomationResults.publicRuns",
      input: {
        profileId: legacyFollower.id,
        automationId: legacy.f.automationId,
        id: privateRun.resultId,
      },
    }),
    undefined,
  );
});

void test("each subscribed follower owns and pays for its own receipt of an isolated run", async (t) => {
  const r = await receiptFixture(t, "isolated");
  const subscribed = await r.newFollower();
  const optedOut = await r.newFollower();
  const full = await r.newFollower();
  await r.follow(subscribed, true);
  await r.follow(optedOut, true);
  const setNotifications = (enabled: boolean) =>
    runProtectedSharing(
      r.f.stateDir,
      "protectedSharing.automationSubscription",
      { profileId: optedOut.id, automationId: r.f.automationId, subscribed: enabled, now: 500 },
      () => {},
    );
  assert.equal(await setNotifications(false), true);
  await r.follow(full, true);
  full.auth.quota(0);
  const finished = await r.run();

  assert.deepEqual(await r.deliver(finished), { status: "committed" });
  assert.deepEqual(await r.inbox(r.f.ownerId), [finished.runId]);
  assert.deepEqual(await r.inbox(subscribed.id), [finished.runId]);
  // Not subscribed, or unable to pay: left out without blocking the owner or anyone else.
  assert.deepEqual(await r.inbox(optedOut.id), []);
  assert.deepEqual(await r.inbox(full.id), []);
  const [receipt, ...extra] = await r.receipts(subscribed.id);
  assert.ok(receipt);
  assert.deepEqual(extra, []);
  assert.equal(receipt.id, `protected-automation-inbox:${finished.runId}`);
  assert.equal(subscribed.auth.ledger.globalBytes, receipt.bytes);
  assert.equal(full.auth.ledger.globalBytes, 0);
  assert.equal(optedOut.auth.ledger.globalBytes, 0);
  assert.equal(subscribed.auth.pending(), 0);
  assert.deepEqual(await r.deliver(finished), { status: "unchanged" });
  assert.equal(subscribed.auth.ledger.globalBytes, receipt.bytes);
  assert.equal(await setNotifications(true), true);
  const next = await r.run();
  assert.deepEqual(await r.deliver(next), { status: "committed" });
  assert.deepEqual(await r.inbox(optedOut.id), [next.runId]);
});

void test("a retried delivery reaches the subscribers present at its successful commit", async (t) => {
  const r = await receiptFixture(t, "isolated");
  const early = await r.newFollower();
  await r.follow(early, true);
  const finished = await r.run();

  r.owner.quota(0);
  await assert.rejects(r.deliver(finished), /quota exceeded/);
  assert.equal(early.auth.ledger.globalBytes, 0);
  assert.equal(early.auth.pending(), 0);
  assert.deepEqual(await r.inbox(early.id), []);

  const late = await r.newFollower();
  await r.follow(late, true);
  r.owner.quota(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await r.deliver(finished), { status: "committed" });
  assert.deepEqual(await r.inbox(early.id), [finished.runId]);
  assert.deepEqual(await r.inbox(late.id), [finished.runId]);
});

void test("unfollowing or unpublishing removes receipts and they never come back", async (t) => {
  const r = await receiptFixture(t, "isolated");
  const leaver = await r.newFollower();
  const stayer = await r.newFollower();
  await r.follow(leaver, true);
  await r.follow(stayer, true);
  const first = await r.run();
  assert.deepEqual(await r.deliver(first), { status: "committed" });

  await r.unfollow(leaver);
  assert.deepEqual(await r.inbox(leaver.id), []);
  assert.deepEqual(await r.receipts(leaver.id), []);
  assert.deepEqual(await r.inbox(stayer.id), [first.runId]);
  await r.follow(leaver, true);
  assert.deepEqual(await r.inbox(leaver.id), []);
  const second = await r.run();
  assert.deepEqual(await r.deliver(second), { status: "committed" });
  assert.deepEqual(await r.inbox(leaver.id), [second.runId]);

  await r.unpublish();
  assert.deepEqual(await r.inbox(leaver.id), []);
  assert.deepEqual(await r.inbox(stayer.id), []);
  assert.deepEqual(await r.receipts(stayer.id), []);
  assert.deepEqual(await r.inbox(r.f.ownerId), [first.runId, second.runId].toSorted());
});

void test("retention retires a pruned run's receipts for every recipient", async (t) => {
  const r = await receiptFixture(t, "isolated");
  const follower = await r.newFollower();
  await r.follow(follower, true);
  const finished = await r.run();
  assert.deepEqual(await r.deliver(finished), { status: "committed" });
  assert.deepEqual(await r.inbox(follower.id), [finished.runId]);
  for (let index = 0; index < 50; index++) {
    const now = 10_000 + index;
    assert.deepEqual(
      await r.write({
        kind: "refuse",
        runId: randomUUID(),
        definitionRevision: r.f.revision,
        trigger: "manual",
        scheduledAtMs: now,
        now,
        errorCode: "quota_exceeded",
      }),
      { status: "committed" },
    );
  }
  assert.deepEqual(await r.inbox(follower.id), []);
  assert.deepEqual(await r.inbox(r.f.ownerId), []);
  assert.deepEqual(await r.receipts(follower.id), []);
});

void test("followers get no receipt for an automation that is not isolated", async (t) => {
  const r = await receiptFixture(t);
  const follower = await r.newFollower();
  await r.follow(follower, true);
  const finished = await r.run();
  assert.deepEqual(await r.deliver(finished), { status: "committed" });
  assert.deepEqual(await r.inbox(r.f.ownerId), [finished.runId]);
  assert.deepEqual(await r.inbox(follower.id), []);
  assert.equal(follower.auth.ledger.globalBytes, 0);
});
