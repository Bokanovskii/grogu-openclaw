import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
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
import { readOwnedProtectedAutomationStorageRecord } from "./automations-store.js";
import {
  readProtectedFeedbackStorageUsage,
  submitProtectedFeedbackReport,
} from "./feedback-store.js";
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

async function fixture(t: { after(fn: () => Promise<void>): void }) {
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
      trigger: "scheduled",
      scheduledAtMs: 10,
      now: 10,
    }),
    { status: "committed" },
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
    scheduledAtMs: 13,
    now: 13,
  };
  assert.deepEqual(await write({ ...queue, trigger: "scheduled" }), { status: "disabled" });
  assert.deepEqual(await write({ ...queue, trigger: "manual" }), { status: "committed" });
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
        { status: "committed" },
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
          trigger: "manual",
          scheduledAtMs: 1_005,
          now: 1_005,
        }),
        { status: "committed" },
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
          trigger: "manual",
          scheduledAtMs: 3_000,
          now: 3_000,
        }),
        { status: "committed" },
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
          trigger: "manual",
          scheduledAtMs: 5_000,
          now: 5_000,
        }),
        { status: "committed" },
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
