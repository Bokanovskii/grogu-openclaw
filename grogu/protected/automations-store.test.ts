import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import {
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../src/state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import {
  bindProtectedAutomationJobWithAdmission,
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
} from "../../src/state/protected-automation-operations.js";
import { readStoredDefinition } from "../../src/state/protected-automation-storage-codec.js";
import type {
  ProtectedAutomationCommittedBytes,
  ProtectedAutomationStoredBytes,
} from "../../src/state/protected-automations.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { addProtectedSubject, bindProtectedProfile } from "./admission-store.js";
import {
  readProtectedAutomationStorageUsage,
  createProtectedAutomationRecord,
} from "./automations-store.js";
import { createStorageAdmission } from "./capacity.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";

void test("protected automation records are private, bound to revisions, and survive process restart", async (t) => {
  const stateDir = path.resolve(".artifacts", `automation-records-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const issuer = "https://synthetic.example";
  const addMember = async (subject: string) => {
    assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "added");
    const profile = await ensureCanonicalUserProfileForVerifiedIdentity(
      { issuer, subject },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );
    assert.equal(
      await bindProtectedProfile(stateDir, { issuer, subject, profileId: profile.id }),
      true,
    );
    return profile.id;
  };
  const ownerProfileId = await addMember(randomUUID());
  const otherProfileId = await addMember(randomUUID());
  const context = () =>
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const authority = (profileId: string) => ({
    profileId,
    assertCurrent: () => {},
  });
  const definition: ProtectedAutomationDraft = {
    name: "Synthetic morning summary",
    instructions: "Summarize synthetic test material.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "research",
    model: { provider: "sparky", id: "00000000-0000-4000-8000-000000000001" },
    thinking: "low",
    schedule: { kind: "every", everyMs: 60_000 },
  };

  const admitted: ProtectedAutomationStoredBytes[] = [];
  const committed: ProtectedAutomationCommittedBytes[] = [];
  await assert.rejects(
    createProtectedAutomationWithAdmission(
      context(),
      { profileId: ownerProfileId, definition, now: Date.now() },
      {
        ...authority(ownerProfileId),
        admitStorage: () => {
          throw new Error("Synthetic storage refusal");
        },
      },
    ),
    /Synthetic storage refusal/u,
  );
  assert.deepEqual(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.list",
      input: { profileId: ownerProfileId },
    }),
    [],
  );
  const created = await createProtectedAutomationWithAdmission(
    context(),
    { profileId: ownerProfileId, definition, now: Date.now() },
    {
      ...authority(ownerProfileId),
      admitStorage: (facts) => admitted.push(facts),
      onStorageCommitted: (facts) => committed.push(facts),
    },
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    return;
  }
  assert.match(
    created.automation.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(created.automation.visibility, "private");
  assert.equal(created.automation.definitionRevision, 1);
  assert.equal(created.automation.enabled, false);
  assert.equal(created.automation.relation, "owner");
  const definitionBytes = Buffer.byteLength(JSON.stringify(definition), "utf8");
  assert.deepEqual(admitted, [
    {
      automationId: created.automation.id,
      currentStoredBytes: 0,
      nextStoredBytes: definitionBytes,
    },
  ]);
  assert.deepEqual(committed, [{ ...admitted[0], committedStoredBytes: definitionBytes }]);
  assert.equal(
    (await readProtectedAutomationStorageUsage(stateDir, ownerProfileId, () => {}))
      .profileDefinitionBytes,
    definitionBytes,
  );
  const updatedDefinition = { ...definition, instructions: "Updated synthetic instructions." };
  const updatedBytes = Buffer.byteLength(JSON.stringify(updatedDefinition), "utf8");
  const updated = await patchProtectedAutomationWithAdmission(
    context(),
    {
      profileId: ownerProfileId,
      automationId: created.automation.id,
      expectedRevision: 1,
      definition: updatedDefinition,
      now: Date.now(),
    },
    {
      ...authority(ownerProfileId),
      admitStorage: (facts) => admitted.push(facts),
      onStorageCommitted: (facts) => committed.push(facts),
    },
  );
  assert.equal(updated.status, "updated");
  assert.deepEqual(admitted[1], {
    automationId: created.automation.id,
    currentStoredBytes: definitionBytes,
    nextStoredBytes: updatedBytes,
  });
  assert.deepEqual(committed[1], { ...admitted[1], committedStoredBytes: updatedBytes });
  assert.deepEqual(
    (
      await executeOpenClawStateWorker(context(), {
        type: "protectedAutomations.list",
        input: { profileId: ownerProfileId },
      })
    ).map(({ id }) => id),
    [created.automation.id],
  );
  assert.deepEqual(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.list",
      input: { profileId: otherProfileId },
    }),
    [],
  );
  assert.deepEqual(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.list",
      input: { profileId: "inactive-member" },
    }),
    [],
  );
  assert.equal(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.read",
      input: { profileId: otherProfileId, automationId: created.automation.id },
    }),
    undefined,
  );
  assert.equal(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.read",
      input: { profileId: "inactive-member", automationId: created.automation.id },
    }),
    undefined,
  );
  assert.deepEqual(
    await createProtectedAutomationWithAdmission(
      context(),
      { profileId: "inactive-member", definition, now: Date.now() },
      authority("inactive-member"),
    ),
    { status: "member_inactive" },
  );

  const jobId = `cron_${randomUUID()}`;
  const bindingInput = {
    profileId: ownerProfileId,
    automationId: created.automation.id,
    jobId,
    definitionRevision: 2,
  };
  const binding = await bindProtectedAutomationJobWithAdmission(
    context(),
    { ...bindingInput, now: Date.now() },
    authority(ownerProfileId),
  );
  assert.equal(binding.status, "bound");
  assert.equal(
    (
      await bindProtectedAutomationJobWithAdmission(
        context(),
        { ...bindingInput, definitionRevision: 3, now: Date.now() },
        authority(ownerProfileId),
      )
    ).status,
    "definition_revision_mismatch",
  );
  assert.equal(
    (
      await bindProtectedAutomationJobWithAdmission(
        context(),
        { ...bindingInput, profileId: otherProfileId, now: Date.now() },
        authority(otherProfileId),
      )
    ).status,
    "owner_mismatch",
  );
  assert.equal(
    (
      await bindProtectedAutomationJobWithAdmission(
        context(),
        { ...bindingInput, jobId: `cron_${randomUUID()}`, now: Date.now() },
        authority(ownerProfileId),
      )
    ).status,
    "binding_conflict",
  );
  const storedBinding = await executeOpenClawStateWorker(context(), {
    type: "protectedAutomations.readJobBinding",
    input: { jobId },
  });
  assert.equal(storedBinding?.jobId, jobId);
  assert.equal(storedBinding?.automationId, created.automation.id);
  assert.equal(storedBinding?.centralOwnerProfileId, ownerProfileId);
  assert.equal(storedBinding?.definitionRevision, 2);
  assert.ok(Number.isSafeInteger(storedBinding?.createdAt));
  assert.ok(Number.isSafeInteger(storedBinding?.updatedAt));

  const usage = await readProtectedAutomationStorageUsage(stateDir, ownerProfileId, () => {});
  const createBytes = Buffer.byteLength(JSON.stringify(definition), "utf8") + 4096;
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const admission = createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    encryption,
    maxFileBytes: 1024,
    limits: {
      globalBytes: usage.totalDefinitionBytes + usage.totalRecords * 4096 + 16 * 1024 + createBytes,
      userBytes:
        usage.profileDefinitionBytes + usage.profileRecords * 4096 + 16 * 1024 + createBytes,
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
    automationUsage: readProtectedAutomationStorageUsage.bind(null, stateDir),
  });
  const heldTurn = await admission(ownerProfileId, () => {}, "turn");
  try {
    const failedCreate = await admission("inactive-member", () => {}, "automation");
    try {
      assert.equal(
        await createProtectedAutomationRecord(
          stateDir,
          { profileId: "inactive-member", definition, now: Date.now() },
          authority("inactive-member"),
          failedCreate,
        ),
        undefined,
      );
    } finally {
      failedCreate.release();
    }
    const retryCreate = await admission(ownerProfileId, () => {}, "automation");
    try {
      const retried = await createProtectedAutomationRecord(
        stateDir,
        { profileId: ownerProfileId, definition, now: Date.now() },
        authority(ownerProfileId),
        retryCreate,
      );
      assert.equal(retried?.name, definition.name);
    } finally {
      retryCreate.release();
    }
  } finally {
    heldTurn.release();
  }

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "--eval",
      [
        'import { captureOpenClawStateWorkerContext } from "./src/state/openclaw-state-worker-context.ts";',
        'import { executeOpenClawStateWorker } from "./src/state/openclaw-state-worker-store.ts";',
        "const context = captureOpenClawStateWorkerContext({",
        "  env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },",
        "});",
        "const record = await executeOpenClawStateWorker(context, {",
        '  type: "protectedAutomations.read",',
        "  input: {",
        "    profileId: process.env.AUTOMATION_PROFILE_ID,",
        "    automationId: process.env.AUTOMATION_ID,",
        "  },",
        "});",
        "console.log(JSON.stringify(record));",
      ].join("\n"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        AUTOMATION_PROFILE_ID: ownerProfileId,
        AUTOMATION_ID: created.automation.id,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).id, created.automation.id);
});

void test("encrypted automation writes admit and settle actual stored bytes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-automation-storage-"));
  const stateDir = path.join(home, "state");
  const keyPath = path.join(home, "key");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const previousKey = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath,
  };
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
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
  const issuer = "https://synthetic.example";
  const subject = randomUUID();
  assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "added");
  const profile = await ensureCanonicalUserProfileForVerifiedIdentity({ issuer, subject }, { env });
  assert.equal(
    await bindProtectedProfile(stateDir, { issuer, subject, profileId: profile.id }),
    true,
  );
  const definition: ProtectedAutomationDraft = {
    name: "Synthetic encrypted automation",
    instructions: "Summarize synthetic material.",
    whenToNotify: "Only when useful.",
    agentId: "research",
    model: { provider: "sparky", id: "00000000-0000-4000-8000-000000000001" },
    thinking: "low",
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const context = captureProtectedStateWorkerContext(stateDir);
  const admitted: ProtectedAutomationStoredBytes[] = [];
  const committed: ProtectedAutomationCommittedBytes[] = [];
  const authority = {
    profileId: profile.id,
    assertCurrent: () => {},
    admitStorage: (facts: ProtectedAutomationStoredBytes) => admitted.push(facts),
    onStorageCommitted: (facts: ProtectedAutomationCommittedBytes) => committed.push(facts),
  };
  await assert.rejects(
    createProtectedAutomationWithAdmission(
      context,
      { profileId: profile.id, definition, now: 1 },
      {
        ...authority,
        admitStorage: () => {
          throw new Error("storage refused");
        },
      },
    ),
    /storage refused/u,
  );
  let revoked = false;
  const aborted: ProtectedAutomationStoredBytes[] = [];
  await assert.rejects(
    createProtectedAutomationWithAdmission(
      context,
      { profileId: profile.id, definition, now: 1 },
      {
        profileId: profile.id,
        assertCurrent: () => {
          if (revoked) {
            throw new Error("member authority revoked");
          }
        },
        admitStorage: () => {
          revoked = true;
        },
        onStorageAborted: (facts) => aborted.push(facts),
      },
    ),
    /member authority revoked/u,
  );
  assert.equal(aborted.length, 1);
  assert.deepEqual(
    await executeOpenClawStateWorker(context, {
      type: "protectedAutomations.list",
      input: { profileId: profile.id },
    }),
    [],
  );
  const created = await createProtectedAutomationWithAdmission(
    context,
    { profileId: profile.id, definition, now: 2 },
    authority,
  );
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    return;
  }
  const readStored = () => {
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT definition_json, length(CAST(definition_json AS BLOB)) AS bytes FROM protected_automations WHERE id = ?",
        )
        .get(created.automation.id);
    } finally {
      database.close();
    }
  };
  const stored = readStored();
  assert.ok(
    stored && typeof stored.definition_json === "string" && typeof stored.bytes === "number",
  );
  assert.equal(stored.definition_json.includes(definition.instructions), false);
  assert.equal(admitted[0]?.currentStoredBytes, 0);
  assert.equal(admitted[0]?.nextStoredBytes, stored.bytes);
  assert.equal(committed[0]?.committedStoredBytes, stored.bytes);
  const changedDefinition = { ...definition, instructions: "An updated synthetic instruction." };
  const result = await patchProtectedAutomationWithAdmission(
    context,
    {
      profileId: profile.id,
      automationId: created.automation.id,
      expectedRevision: 1,
      definition: changedDefinition,
      now: 3,
    },
    authority,
  );
  assert.equal(result.status, "updated");
  const updated = readStored();
  assert.equal(admitted[1]?.currentStoredBytes, stored.bytes);
  assert.equal(admitted[1]?.nextStoredBytes, updated?.bytes);
  assert.equal(committed[1]?.committedStoredBytes, updated?.bytes);
  assert.equal(
    (
      await executeOpenClawStateWorker(context, {
        type: "protectedAutomations.read",
        input: { profileId: profile.id, automationId: created.automation.id },
      })
    )?.definition.instructions,
    changedDefinition.instructions,
  );
  const readFromDatabase = () =>
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        const row = db
          .prepare("SELECT id, definition_json FROM protected_automations WHERE id = ?")
          .get(created.automation.id);
        assert.ok(row && typeof row.id === "string" && typeof row.definition_json === "string");
        return JSON.parse(
          readStoredDefinition(db, { id: row.id, definition_json: row.definition_json }),
        );
      },
      { path: resolveOpenClawStateSqlitePath(env), env },
    );
  assert.deepEqual(readFromDatabase(), changedDefinition);
  assert.deepEqual(
    await withOpenClawStateDatabaseReadSnapshot(async () => readFromDatabase(), {
      path: resolveOpenClawStateSqlitePath(env),
      env,
    }),
    changedDefinition,
  );
});
