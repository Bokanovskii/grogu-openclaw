import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import { readUserProfileSnapshot } from "../../src/state/user-profile-reads.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import {
  addProtectedSubject,
  bindProtectedAdmission,
  bindProtectedProfile,
  listProtectedAdmissions,
  removeProtectedAdmission,
} from "./admission-store.js";
import { createProtectedAgentCatalog } from "./agents.js";
import {
  writeProtectedAutomationLifecycle,
  type ProtectedAutomationLifecycleAuthority,
} from "./automation-lifecycle-store.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import { createProtectedAutomationStorageRecoveryOwner } from "./automation-storage-recovery.js";
import { readProtectedAutomationStorageUsage } from "./automations-store.js";
import { createStorageAdmission } from "./capacity.js";
import { createProtectedChats } from "./chats.js";
import { maintainProtectedAutomations } from "./maintain-automations.js";
import { parseRuntimeSettings, protectedMaxFileBytes, sparkyRef } from "./settings.js";
import { acquireProtectedStateOwner } from "./state-owner.js";
import {
  provisionProtectedStorageKeyAndMigrate,
  requireProtectedStorageEncryption,
} from "./storage-key.js";
import { protectedStorageMeasurement } from "./storage-measurement.js";

void test("offline automation maintenance preserves member ownership, retries, revisions and quotas", async (t) => {
  const home = path.resolve(".artifacts", `automation-maintenance-${randomUUID()}`);
  const stateDir = path.join(home, "state");
  for (const directory of [home, stateDir, path.join(home, "config"), path.join(home, "secrets")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const environment = {
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(home, "config", "openclaw.json"),
    OPENCLAW_PROTECTED_STORAGE_KEY_FILE: path.join(home, "secrets", "storage-key"),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(environment));
    await closeOpenClawAgentDatabasesAsync(stateDir);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(home, { recursive: true, force: true });
  });
  const settings = parseRuntimeSettings({
    origin: "https://chat.bokanovski.com",
    accessIssuer: "https://synthetic.cloudflareaccess.com",
    accessAudience: "a".repeat(64),
    port: 19789,
    stateDir,
    allowedSubjects: [],
    sparkySecret: sparkyRef,
    storageLimits: {
      globalBytes: 32 * 1024 * 1024,
      userBytes: 16 * 1024 * 1024,
      freeFloorBytes: 1,
    },
  });
  await writeFile(path.join(home, "config", "protected.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  const setupOwner = await acquireProtectedStateOwner(stateDir);
  assert.ok(setupOwner);
  const addMember = async (email: string, bound = true) => {
    const subject = randomUUID();
    const identity = { issuer: settings.accessIssuer, subject };
    assert.equal(await addProtectedSubject(stateDir, identity), "added");
    assert.ok(
      await bindProtectedAdmission(
        stateDir,
        { ...identity, email },
        setupOwner.assertCurrent,
        () => {},
      ),
    );
    const profile = await ensureCanonicalUserProfileForVerifiedIdentity(identity, {
      env: environment,
    });
    if (bound) {
      assert.ok(await bindProtectedProfile(stateDir, { ...identity, profileId: profile.id }));
    }
    return { profileId: profile.id, subject };
  };
  let member;
  let other;
  try {
    await provisionProtectedStorageKeyAndMigrate(setupOwner.assertCurrent);
    member = await addMember("member@example.test");
    other = await addMember("other@example.test");
    await addMember("unbound@example.test", false);
    const removed = await addMember("removed@example.test");
    const admission = (await listProtectedAdmissions(stateDir)).find(
      (entry) => entry.profileId === removed.profileId,
    );
    assert.ok(admission);
    await removeProtectedAdmission(
      stateDir,
      {
        id: admission.id,
        issuer: settings.accessIssuer,
        ownerSubject: randomUUID(),
      },
      setupOwner.assertCurrent,
      () => {},
      () => {},
    );
    const revoked = await addMember("revoked@example.test");
    await updateCanonicalUserProfileAccess(
      { action: "revoke", profileId: revoked.profileId },
      { env: environment },
    );
  } finally {
    setupOwner.release();
  }
  const membersBefore = await listProtectedAdmissions(stateDir);
  const profilesBefore = await readUserProfileSnapshot(undefined, { env: environment });
  const command = async (input: unknown, configuration = settings) => {
    // Each CLI invocation starts with fresh workers, unlike this shared-process fixture.
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(environment));
    await closeOpenClawAgentDatabasesAsync(stateDir);
    return maintainProtectedAutomations(configuration, input);
  };
  const inspect = (email = "member@example.test", automationId?: string) =>
    command({ operation: "inspect", email, ...(automationId ? { automationId } : {}) });
  const cli = (text: string) =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "automations", "--json"],
      { env: process.env, input: text, encoding: "utf8", timeout: 30_000 },
    );
  const held = await acquireProtectedStateOwner(stateDir);
  assert.ok(held);
  try {
    const locked = cli(JSON.stringify({ operation: "inspect", email: "member@example.test" }));
    assert.equal(locked.status, 1, locked.stderr);
    assert.equal(JSON.parse(locked.stderr).error, "state_busy");
  } finally {
    held.release();
  }
  for (const email of [
    "missing@example.test",
    "unbound@example.test",
    "removed@example.test",
    "revoked@example.test",
  ]) {
    await assert.rejects(inspect(email), /member|profile/i);
  }
  await assert.rejects(
    command({ operation: "inspect", email: "member@example.test", script: "ignored" }),
    /Supply one/,
  );
  const definition = {
    name: "Synthetic digest",
    instructions: "Summarize synthetic information.",
    whenToNotify: "When a useful update appears.",
    agentId: "grogu",
    model: { provider: "sparky", id: "qwen3.8-flash-next" },
    contextAccess: "isolated",
    schedule: { kind: "every", everyMs: 1_800_000 },
  };
  const automationId = randomUUID();
  const create = { operation: "create", email: "member@example.test", automationId, definition };
  await assert.rejects(
    command({
      ...create,
      definition: {
        ...definition,
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "America/Los_Angeles" },
      },
    }),
    /repeat/,
  );
  const createdReply = cli(JSON.stringify(create));
  assert.equal(createdReply.status, 0, createdReply.stderr);
  const created: Awaited<ReturnType<typeof maintainProtectedAutomations>> = JSON.parse(
    createdReply.stdout,
  );
  assert.ok("automation" in created && created.automation);
  assert.equal(created.automation.id, automationId);
  assert.equal(created.automation.enabled, false);
  assert.equal(created.automation.version, "1");
  assert.equal(created.automation.thinking, "medium");
  const usage = () => readProtectedAutomationStorageUsage(stateDir, member.profileId, () => {});
  const used = await usage();
  assert.equal(used.profileRecords, 1);
  assert.ok(used.profileDefinitionBytes > Buffer.byteLength(JSON.stringify(definition)));
  const retried = await command(create);
  assert.equal("status" in retried && retried.status, "exists");
  assert.deepEqual(await usage(), used);
  await assert.rejects(
    command({ ...create, definition: { ...definition, name: "Different" } }),
    /different definition/,
  );
  await assert.rejects(command({ ...create, email: "other@example.test" }), /another record/);
  await assert.rejects(inspect("other@example.test", automationId), /No owned/);
  const otherCreated = await command({
    ...create,
    email: "other@example.test",
    automationId: randomUUID(),
  });
  assert.ok("automation" in otherCreated);
  const otherBefore = await inspect("other@example.test");
  const patch = {
    operation: "patch",
    email: "member@example.test",
    automationId,
    expectedVersion: "1",
    patch: { enabled: true },
  };
  const enabledReply = cli(JSON.stringify(patch));
  assert.equal(enabledReply.status, 0, enabledReply.stderr);
  const enabled: Awaited<ReturnType<typeof maintainProtectedAutomations>> = JSON.parse(
    enabledReply.stdout,
  );
  assert.ok("automation" in enabled && enabled.automation);
  assert.equal(enabled.automation.enabled, true);
  assert.equal(enabled.automation.version, "2");
  await assert.rejects(command(patch), /not patched/);
  const runOwner = await acquireProtectedStateOwner(stateDir);
  assert.ok(runOwner);
  const encryption = requireProtectedStorageEncryption();
  const recovery = createProtectedAutomationStorageRecoveryOwner(runOwner.assertCurrent);
  const resultIds: string[] = [];
  const runIds: string[] = [];
  try {
    const usersRoot = await root(path.join(stateDir, "users"));
    const chats = createProtectedChats({
      stateDir,
      usersRoot,
      maxChatsPerUser: 100,
      maxFileBytes: protectedMaxFileBytes,
      agentCatalog: createProtectedAgentCatalog(),
    });
    const storage = createStorageAdmission({
      ...protectedStorageMeasurement({
        stateDir,
        usersRoot,
        chats,
        maxFileBytes: protectedMaxFileBytes,
        encryption,
      }),
      limits: settings.storageLimits,
    });
    const common = {
      profileId: member.profileId,
      assertCurrent: runOwner.assertCurrent,
      revalidate: async () => runOwner.assertCurrent(),
      enrollPublication: recovery.enrollPublication,
      reserveStorage: (bytes: number) =>
        storage.reserveStoredData(member.profileId, runOwner.assertCurrent, bytes),
    };
    const lifecycle: ProtectedAutomationLifecycleAuthority = {
      ...common,
      reserveReplacement: (change) =>
        storage.reserveStoredDataReplacement(member.profileId, runOwner.assertCurrent, change),
      reserveBatchReplacement: (change) =>
        storage.reserveStoredDataBatchReplacement(member.profileId, runOwner.assertCurrent, change),
      reserveRecipient: async () => assert.fail("Synthetic jobs have no followers"),
      retireStorage: (entries) =>
        storage.retiredStoredData(entries.map((removed) => ({ removed }))),
      retainUncertainCommit: recovery.retainUncertainCommit,
    };
    const reference = { profileId: member.profileId, automationId };
    const chatId = randomUUID();
    for (let index = 1; index <= 6; index++) {
      const runId = randomUUID();
      runIds.push(runId);
      assert.equal(
        (
          await writeProtectedAutomationLifecycle(
            stateDir,
            {
              ...reference,
              kind: "queue",
              runId,
              definitionRevision: 2,
              contextAccess: "isolated",
              trigger: "scheduled",
              scheduledAtMs: index * 100,
              now: index * 100,
            },
            lifecycle,
          )
        ).status,
        "committed",
      );
      assert.equal(
        (
          await writeProtectedAutomationLifecycle(
            stateDir,
            {
              ...reference,
              kind: "start",
              runId,
              chatId,
              now: index * 100 + 1,
            },
            lifecycle,
          )
        ).status,
        "committed",
      );
      const result = await commitProtectedAutomationFinishedResult(
        stateDir,
        {
          automationId,
          centralOwnerProfileId: member.profileId,
          definitionRevision: 2,
          jobId: automationId,
          runId,
          runAtMs: index * 100,
          completedAtMs: index * 100 + 2,
          automationName: definition.name,
          privateFinalText: `Synthetic result ${index}`,
          transcript: { sessionKey: "synthetic-maintenance-run", sessionId: chatId },
        },
        { ...common, retainUncertainCommit: recovery.retainUncertainResultCommit },
      );
      assert.equal(result.status, "created");
      if (result.status !== "created") {
        assert.fail("Synthetic result was not saved");
      }
      resultIds.push(result.id);
      assert.equal(
        (
          await writeProtectedAutomationLifecycle(
            stateDir,
            {
              ...reference,
              kind: "finish",
              runId,
              now: index * 100 + 3,
              outcome: { status: "succeeded", resultId: result.id },
            },
            lifecycle,
          )
        ).status,
        "committed",
      );
    }
    recovery.assertSettled();
  } finally {
    encryption.dispose();
    runOwner.release();
  }
  const settled = await command({
    ...patch,
    expectedVersion: "2",
    patch: {
      enabled: false,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/Los_Angeles" },
    },
  });
  assert.ok("automation" in settled && settled.automation);
  assert.equal(settled.automation.version, "3");
  assert.equal(settled.automation.enabled, false);
  const tiny = { ...settings, storageLimits: { ...settings.storageLimits, userBytes: 1 } };
  await assert.rejects(
    command({ ...create, automationId: randomUUID() }, tiny),
    /storage|space|quota/i,
  );
  const result = cli(JSON.stringify({ operation: "inspect", email: " MEMBER@example.test " }));
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.profileId, member.profileId);
  assert.equal(snapshot.automations.length, 1);
  assert.equal(snapshot.automations[0].id, automationId);
  assert.equal(snapshot.automations[0].version, "3");
  assert.equal(snapshot.automations[0].enabled, false);
  assert.deepEqual(
    snapshot.automations[0].runs.map((run: { id: string }) => run.id),
    runIds.slice(1).toReversed(),
  );
  assert.deepEqual(
    snapshot.automations[0].results.map((run: { id: string }) => run.id),
    resultIds.slice(1).toReversed(),
  );
  assert.equal(snapshot.automations[0].runs[0].definitionRevision, 2);
  assert.equal(snapshot.automations[0].results[0].text, "Synthetic result 6");
  assert.ok(!result.stdout.includes(other.profileId));
  assert.deepEqual(await inspect("other@example.test"), otherBefore);
  assert.deepEqual(await listProtectedAdmissions(stateDir), membersBefore);
  assert.deepEqual(await readUserProfileSnapshot(undefined, { env: environment }), profilesBefore);
  const invalid = cli("{");
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error, "invalid_input");
});
