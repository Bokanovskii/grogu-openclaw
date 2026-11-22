import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import {
  bindProtectedAutomationJobWithAdmission,
  createProtectedAutomationWithAdmission,
} from "../../src/state/protected-automation-operations.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import { addProtectedSubject, bindProtectedProfile } from "./admission-store.js";

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

  const created = await createProtectedAutomationWithAdmission(
    context(),
    { profileId: ownerProfileId, definition, now: Date.now() },
    authority(ownerProfileId),
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
    definitionRevision: created.automation.definitionRevision,
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
        { ...bindingInput, definitionRevision: 2, now: Date.now() },
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
  assert.equal(storedBinding?.definitionRevision, 1);
  assert.ok(Number.isSafeInteger(storedBinding?.createdAt));
  assert.ok(Number.isSafeInteger(storedBinding?.updatedAt));

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
