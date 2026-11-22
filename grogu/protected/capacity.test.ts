import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { loadSubagentRunsForChildSessionFromSqlite } from "../../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import { createSessionEntryWithTranscript } from "../../src/config/sessions/session-accessor.js";
import { hasTranscriptArchiveInDatabase } from "../../src/config/sessions/session-accessor.sqlite-archive-read.js";
import { readSessionEntryReadOnlyInWorker } from "../../src/config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import { withOpenClawStateDatabaseReadOnly } from "../../src/state/openclaw-state-db-readonly.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { createProtectedAgentCatalog } from "./agents.js";
import { createStorageAdmission, measureProtectedStorage } from "./capacity.js";
import { createProtectedChats } from "./chats.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

void test("Family capacity charges encrypted bytes for existing files and new writes", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-capacity-profile";
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId,
    encryption,
    maxBytes: 1024,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const data = Buffer.alloc(256, 0x61);
  await files.create("probe.bin", data);
  const directory = path.join(stateDir, createHash("sha256").update(profileId).digest("hex"));
  const physicalBytes = (await stat(path.join(directory, "probe.bin"))).size;
  assert.ok(physicalBytes > data.length);
  let hasChat = false;
  const admission = (userBytes: number) =>
    createStorageAdmission({
      stateDir,
      usersRoot,
      encryption,
      maxFileBytes: 1024,
      limits: { userBytes, globalBytes: userBytes, freeFloorBytes: 1 },
      chats: {
        async capacityEntries() {
          return hasChat
            ? [{ profileId, id: "one", sessionKey: "synthetic", updatedAt: 1, transient: false }]
            : [];
        },
        async transcriptBytes() {
          return 0;
        },
      },
    })(profileId, () => {}, "turn");
  const chargedPathOverhead = 3 * 4096;
  const tooSmall = await admission(16_384 + chargedPathOverhead + data.length);
  try {
    await assert.rejects(async () => tooSmall.files(files).create("chats/one/file.bin", data), {
      code: "quota_exceeded",
      message:
        "Storage limit reached. Delete stored data to free space, or contact the server operator.",
    });
    await assert.rejects(files.stat("chats/one/file.bin"), { code: "not-found" });
  } finally {
    tooSmall.release();
  }
  const exactWrite = await admission(16_384 + chargedPathOverhead + physicalBytes);
  try {
    await exactWrite.files(files).create("chats/one/file.bin", data);
  } finally {
    exactWrite.release();
  }
  hasChat = true;
  const existingAndTurn = 32_768 + 4096 + 4096 + physicalBytes + 16_384;
  await assert.rejects(admission(existingAndTurn - 1), { code: "quota_exceeded" });
  const exactExisting = await admission(existingAndTurn);
  exactExisting.release();
});

void test("concurrent chat admissions share quota without returning storage_busy", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-concurrent-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { userBytes: 70_000, globalBytes: 70_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const reservations = await Promise.all([
    admission("synthetic-profile", () => {}, "create"),
    admission("synthetic-profile", () => {}, "create"),
  ]);
  try {
    assert.equal(reservations.length, 2);
  } finally {
    for (const reservation of reservations) {
      reservation.release();
    }
  }
});

void test("automation definitions remain charged in the shared reservation ledger", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-automation-profile";
  const definition = {
    name: "Synthetic automation",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  } satisfies ProtectedAutomationDraft;
  const currentDefinition = { ...definition, instructions: "x".repeat(3_000) };
  const nextDefinition = { ...currentDefinition, instructions: "short" };
  const currentDefinitionBytes = Buffer.byteLength(JSON.stringify(currentDefinition), "utf8");
  const createBytes = Buffer.byteLength(JSON.stringify(definition), "utf8") + 4096;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: {
      userBytes: 16_384 + currentDefinitionBytes + 4096 + createBytes - 1_000,
      globalBytes: 16_384 + currentDefinitionBytes + 4096 + createBytes - 1_000,
      freeFloorBytes: 1,
    },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      return {
        totalDefinitionBytes: currentDefinitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: currentDefinitionBytes,
        profileRecords: 1,
        profiles: [{ profileId, definitionBytes: currentDefinitionBytes, records: 1 }],
        entries: [
          {
            id: "measured-automation",
            profileId,
            definitionBytes: currentDefinitionBytes,
          },
        ],
      };
    },
  });
  const turn = await admission(profileId, () => {}, "turn");
  const automation = await admission(profileId, () => {}, "automation");
  const blockedCreate = await admission(profileId, () => {}, "automation");
  try {
    automation.chargeAutomationPatch(currentDefinition, nextDefinition);
    assert.throws(() => blockedCreate.chargeAutomationCreate(definition), {
      code: "quota_exceeded",
    });
    automation.settleAutomationPatch(currentDefinition, nextDefinition, true);
    const admittedCreate = await admission(profileId, () => {}, "automation");
    try {
      assert.doesNotThrow(() => admittedCreate.chargeAutomationCreate(definition));
    } finally {
      admittedCreate.release();
    }
  } finally {
    blockedCreate.release();
    automation.release();
    turn.release();
  }
});

void test("retired definitions release measured and reserved bytes without double refunds", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-retirement-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const retiredProfileId = "synthetic-retired-profile";
  const thirdProfileId = "synthetic-retry-profile";
  const measuredDefinition = {
    name: "Measured private draft",
    instructions: "x".repeat(3_000),
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  } satisfies ProtectedAutomationDraft;
  const postMeasurementDefinition = {
    ...measuredDefinition,
    name: "New private draft",
    instructions: "Summarize synthetic test material.",
  };
  const measured = {
    id: "measured-automation",
    profileId: retiredProfileId,
    definitionBytes: Buffer.byteLength(JSON.stringify(measuredDefinition), "utf8"),
  };
  const created = {
    id: "created-after-measurement",
    profileId: retiredProfileId,
    definitionBytes: Buffer.byteLength(JSON.stringify(postMeasurementDefinition), "utf8"),
  };
  const measuredBytes = measured.definitionBytes + 4096;
  const createdBytes = created.definitionBytes + 4096;
  const limit = 16 * 1024 + measuredBytes + createdBytes + 32 * 1024 - 1;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { globalBytes: limit, userBytes: limit, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      return {
        totalDefinitionBytes: measured.definitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: measured.definitionBytes,
        profileRecords: 1,
        profiles: [
          {
            profileId: retiredProfileId,
            definitionBytes: measured.definitionBytes,
            records: 1,
          },
        ],
        entries: [measured],
      };
    },
  });
  const turn = await admission("synthetic-active-profile", () => {}, "turn");
  const automation = await admission(retiredProfileId, () => {}, "automation");
  try {
    automation.chargeAutomationCreate(postMeasurementDefinition);
    automation.settleAutomationCreate(postMeasurementDefinition, true, created.id);
    await assert.rejects(
      admission(thirdProfileId, () => {}, "create"),
      {
        code: "quota_exceeded",
      },
    );

    admission.deletedAutomations([measured, created]);
    admission.deletedAutomations([measured, created]);

    const retry = await admission(thirdProfileId, () => {}, "create");
    const noDuplicateCredit = await admission(thirdProfileId, () => {}, "automation");
    try {
      assert.throws(() => noDuplicateCredit.charge(measuredBytes + createdBytes), {
        code: "quota_exceeded",
      });
    } finally {
      noDuplicateCredit.release();
      retry.release();
    }
  } finally {
    automation.release();
    turn.release();
  }
});

void test("automation retirement reconciles with an in-progress storage measurement", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-scan-race-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-retired-profile";
  const measured = {
    id: "measured-automation",
    profileId,
    definitionBytes: 4_000,
  };
  const absentFromSnapshot = {
    id: "already-retired-automation",
    profileId,
    definitionBytes: measured.definitionBytes,
  };
  const bytes = measured.definitionBytes + 4096;
  const measureStarted = Promise.withResolvers<void>();
  const finishMeasure = Promise.withResolvers<void>();
  const limit = 16 * 1024 + bytes + 32 * 1024 - 1;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { globalBytes: limit, userBytes: limit, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      measureStarted.resolve();
      await finishMeasure.promise;
      return {
        totalDefinitionBytes: measured.definitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: measured.definitionBytes,
        profileRecords: 1,
        profiles: [{ profileId, definitionBytes: measured.definitionBytes, records: 1 }],
        entries: [measured],
      };
    },
  });
  const pendingTurn = admission("synthetic-active-profile", () => {}, "turn");
  await measureStarted.promise;
  admission.deletedAutomations([measured, absentFromSnapshot]);
  finishMeasure.resolve();
  const turn = await pendingTurn;
  try {
    const retry = await admission("synthetic-retry-profile", () => {}, "create");
    const noAbsentCredit = await admission("synthetic-retry-profile", () => {}, "automation");
    try {
      assert.throws(() => noAbsentCredit.charge(bytes), { code: "quota_exceeded" });
    } finally {
      noAbsentCredit.release();
      retry.release();
    }
  } finally {
    turn.release();
  }
});

void test("transient children are charged and recovered across registration crash windows", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-capacity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir);
  const usersRoot = await root(usersDir);
  const chats = createProtectedChats({
    stateDir,
    maxChatsPerUser: 10,
    agentCatalog: createProtectedAgentCatalog(),
    usersRoot,
    maxFileBytes: 100_000,
  });
  const profileId = randomUUID();
  const authority = { profileId, assertCurrent: () => {} };
  const parent = await chats.create(authority);
  const parentSessionKey = chats.scope(authority, parent.id).sessionKey;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    limits: { globalBytes: 1_000_000, userBytes: 70_000, freeFloorBytes: 1 },
    chats,
    maxFileBytes: 100_000,
  });
  (await admit(profileId, authority.assertCurrent, "turn")).release();

  const childId = randomUUID();
  const sessionKey = `agent:protected:subagent:${randomUUID()}`;
  const childScope = {
    agentId: chats.agentId,
    env: chats.env,
    storePath: chats.storePath,
    sessionKey,
  };
  const entry: InternalSessionEntry = {
    sessionId: childId,
    lifecycleRevision: randomUUID(),
    updatedAt: Date.now(),
    createdVia: "spawn",
    parentSessionKey,
    spawnedBy: parentSessionKey,
    transientLifetime: {
      kind: "request",
      profileId,
      parentSessionKey,
      parentSessionId: parent.id,
    },
  };
  const registeredScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const registeredEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const changedScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const changedEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const corruptScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const corruptEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "--eval",
      `
        const { createSessionEntryWithTranscript, appendTranscriptEvent } =
          await import("./src/config/sessions/session-accessor.js");
        const { acquireProtectedStateOwner } = await import("./grogu/protected/state-owner.js");
        const { bindSubagentRunRecord } =
          await import("./src/agents/subagents/registry/subagent-registry.store.codec.js");
        const { writeSubagentRunValuesInDatabase } =
          await import("./src/agents/subagents/registry/subagent-registry.store.kernel.js");
        const { runOpenClawStateWriteTransaction } =
          await import("./src/state/openclaw-state-db.js");
        const scope = JSON.parse(process.env.PROOF_CHILD_SCOPE);
        const entry = JSON.parse(process.env.PROOF_CHILD_ENTRY);
        const registeredScope = JSON.parse(process.env.PROOF_REGISTERED_SCOPE);
        const registeredEntry = JSON.parse(process.env.PROOF_REGISTERED_ENTRY);
        const changedScope = JSON.parse(process.env.PROOF_CHANGED_SCOPE);
        const changedEntry = JSON.parse(process.env.PROOF_CHANGED_ENTRY);
        const corruptScope = JSON.parse(process.env.PROOF_CORRUPT_SCOPE);
        const corruptEntry = JSON.parse(process.env.PROOF_CORRUPT_ENTRY);
        const owner = await acquireProtectedStateOwner(process.env.OPENCLAW_STATE_DIR);
        if (!owner) throw new Error("Could not own child state");
        const created = await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }));
        if (!created.ok) throw new Error("Child creation failed");
        await appendTranscriptEvent({ ...scope, sessionId: entry.sessionId },
          { type: "custom", id: "child-proof", data: "x".repeat(10_000) });
        const registered = await createSessionEntryWithTranscript(registeredScope,
          () => ({ ok: true, entry: registeredEntry }));
        if (!registered.ok) throw new Error("Registered child creation failed");
        const changed = await createSessionEntryWithTranscript(changedScope,
          () => ({ ok: true, entry: changedEntry }));
        if (!changed.ok) throw new Error("Changed child creation failed");
        const corrupt = await createSessionEntryWithTranscript(corruptScope,
          () => ({ ok: true, entry: corruptEntry }));
        if (!corrupt.ok) throw new Error("Corrupt child creation failed");
        const run = {
          runId: "synthetic-owned-run",
          childSessionKey: registeredScope.sessionKey,
          childSessionIdentity: {
            sessionId: registeredEntry.sessionId,
            lifecycleRevision: registeredEntry.lifecycleRevision,
          },
          requesterSessionKey: entry.parentSessionKey,
          requesterDisplayKey: entry.parentSessionKey,
          task: "", cleanup: "delete", expectsCompletionMessage: false,
          spawnMode: "run", createdAt: Date.now(),
          execution: { status: "running", suppressSessionEffects: true },
          completion: { required: false },
          delivery: { status: "not_required" },
          cleanupHandled: true,
        };
        const stale = {
          ...run,
          runId: "synthetic-stale-run",
          childSessionKey: changedScope.sessionKey,
          childSessionIdentity: {
            sessionId: changedEntry.sessionId,
            lifecycleRevision: "different-generation",
          },
        };
        const corruptRow = bindSubagentRunRecord({
          ...run,
          runId: "synthetic-corrupt-run",
          childSessionKey: corruptScope.sessionKey,
          childSessionIdentity: {
            sessionId: corruptEntry.sessionId,
            lifecycleRevision: corruptEntry.lifecycleRevision,
          },
        });
        const corruptPayload = JSON.parse(corruptRow.payload_json);
        corruptPayload.requesterSessionKey = "another-parent";
        corruptRow.payload_json = JSON.stringify(corruptPayload);
        runOpenClawStateWriteTransaction((database) =>
          writeSubagentRunValuesInDatabase(database,
            [bindSubagentRunRecord(run), bindSubagentRunRecord(stale), corruptRow], []));
        process.exit(0);
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        PROOF_CHILD_SCOPE: JSON.stringify(childScope),
        PROOF_CHILD_ENTRY: JSON.stringify(entry),
        PROOF_REGISTERED_SCOPE: JSON.stringify(registeredScope),
        PROOF_REGISTERED_ENTRY: JSON.stringify(registeredEntry),
        PROOF_CHANGED_SCOPE: JSON.stringify(changedScope),
        PROOF_CHANGED_ENTRY: JSON.stringify(changedEntry),
        PROOF_CORRUPT_SCOPE: JSON.stringify(corruptScope),
        PROOF_CORRUPT_ENTRY: JSON.stringify(corruptEntry),
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const childFiles = await createAuthorizedUserFiles({
    usersRoot,
    profileId,
    assertCurrent: authority.assertCurrent,
    maxBytes: 100_000,
  });
  try {
    await childFiles.write(`chats/${childId}/child.txt`, "x".repeat(80_000));
  } finally {
    childFiles.dispose();
  }
  const measurement = await measureProtectedStorage(
    { usersRoot, chats, maxFileBytes: 100_000 },
    profileId,
    authority.assertCurrent,
    false,
  );
  assert.equal(measurement.chatCount, 1);
  assert.equal(measurement.lastChatActivityAt, parent.updatedAt);
  await assert.rejects(admit(profileId, authority.assertCurrent, "turn"), {
    code: "quota_exceeded",
  });
  (await admit(randomUUID(), authority.assertCurrent, "turn")).release();

  await assert.rejects(
    chats.recoverTransient(() => {}),
    /Exclusive service state ownership/u,
  );
  const stateOwner = await acquireProtectedStateOwner(stateDir);
  assert.ok(stateOwner);
  try {
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 2,
      skipped: 2,
    });
    const remainingFiles = await createAuthorizedUserFiles({
      usersRoot,
      profileId,
      assertCurrent: stateOwner.assertCurrent,
      maxBytes: 100_000,
    });
    try {
      await assert.rejects(remainingFiles.stat(`chats/${childId}/child.txt`), {
        code: "not-found",
      });
    } finally {
      remainingFiles.dispose();
    }
    const remaining = withOpenClawStateDatabaseReadOnly(
      (database) => loadSubagentRunsForChildSessionFromSqlite(registeredScope.sessionKey, database),
      { env: chats.env },
    );
    assert.equal(remaining.length, 0);
    const changedRuns = withOpenClawStateDatabaseReadOnly(
      (database) => loadSubagentRunsForChildSessionFromSqlite(changedScope.sessionKey, database),
      { env: chats.env },
    );
    assert.equal(changedRuns.length, 1);
    assert.equal(
      (await readSessionEntryReadOnlyInWorker({ ...changedScope, projection: "full" }))?.sessionId,
      changedEntry.sessionId,
    );
    assert.equal(
      (await readSessionEntryReadOnlyInWorker({ ...corruptScope, projection: "full" }))?.sessionId,
      corruptEntry.sessionId,
    );
    assert.equal((await chats.read(authority, parent.id)).id, parent.id);
    const archive = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        hasTranscriptArchiveInDatabase(database, {
          logicalAgentId: chats.agentId,
          sessionId: childId,
          sessionKey,
        }),
      { agentId: chats.agentId, env: chats.env, path: chats.storePath },
    );
    assert.ok(archive.found);
    assert.equal(archive.value, false);
    await assert.rejects(admit(profileId, authority.assertCurrent, "turn"), {
      code: "quota_exceeded",
    });
    const ambiguousKey = `agent:protected:subagent:${randomUUID()}`;
    const ambiguousId = randomUUID();
    const ambiguousEntry: InternalSessionEntry = {
      ...entry,
      sessionId: ambiguousId,
      lifecycleRevision: randomUUID(),
      transientLifetime: {
        kind: "request",
        profileId: randomUUID(),
        parentSessionKey,
        parentSessionId: parent.id,
      },
    };
    const ambiguousScope = { ...childScope, sessionKey: ambiguousKey };
    const ambiguous = await createSessionEntryWithTranscript(ambiguousScope, () => ({
      ok: true,
      entry: ambiguousEntry,
    }));
    assert.ok(ambiguous.ok);
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 0,
      skipped: 3,
    });
    const retained = await readSessionEntryReadOnlyInWorker({
      ...ambiguousScope,
      projection: "full",
    });
    assert.equal(retained?.sessionId, ambiguousId);

    const invalidKey = `agent:protected:subagent:${randomUUID()}`;
    const invalidId = randomUUID();
    const invalidScope = { ...childScope, sessionKey: invalidKey };
    const invalid = await createSessionEntryWithTranscript(invalidScope, () => ({
      ok: true,
      entry: {
        ...entry,
        sessionId: invalidId,
        lifecycleRevision: randomUUID(),
        transientLifetime: { ...entry.transientLifetime!, parentSessionId: "" },
      },
    }));
    assert.ok(invalid.ok);
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 0,
      skipped: 4,
    });
    const invalidRetained = await readSessionEntryReadOnlyInWorker({
      ...invalidScope,
      projection: "full",
    });
    assert.equal(invalidRetained?.sessionId, invalidId);
  } finally {
    stateOwner.release();
  }
});
