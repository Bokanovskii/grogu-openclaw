import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import { createProtectedAutomationWithAdmission } from "../../src/state/protected-automation-operations.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import {
  addProtectedSubject,
  bindProtectedProfile,
  listProtectedAdmissions,
  removeProtectedAdmission,
} from "./admission-store.js";
import { runProtectedSharing } from "./sharing-store.js";

void test("public catalog projects only current isolated publications for active members", async (t) => {
  const stateDir = path.resolve(".artifacts", `public-automation-catalog-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://synthetic.example";
  const member = async () => {
    const subject = randomUUID();
    assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "added");
    const profile = await ensureCanonicalUserProfileForVerifiedIdentity(
      { issuer, subject },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );
    assert.equal(
      await bindProtectedProfile(stateDir, { issuer, subject, profileId: profile.id }),
      true,
    );
    return { subject, profileId: profile.id };
  };
  const owner = await member();
  const follower = await member();
  const viewer = await member();
  const context = () =>
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const draft: ProtectedAutomationDraft = {
    name: "Synthetic catalog",
    instructions: "Summarize synthetic material.",
    whenToNotify: "When useful.",
    agentId: "research",
    model: { provider: "sparky", id: "private-model-id" },
    thinking: "low",
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const create = async (definition: ProtectedAutomationDraft) => {
    const result = await createProtectedAutomationWithAdmission(
      context(),
      { profileId: owner.profileId, definition, now: 100 },
      { profileId: owner.profileId, assertCurrent: () => {} },
    );
    assert.equal(result.status, "created");
    if (result.status !== "created") {
      throw new Error("Synthetic automation was not created.");
    }
    return result.automation.id;
  };
  const isolated = await create({
    ...draft,
    contextAccess: "isolated",
    pacing: { minMs: 60_000, maxMs: 120_000 },
  });
  await create({ ...draft, contextAccess: "isolated", name: "Unpublished" });
  const legacy = await create(draft);
  const memberContext = await create({ ...draft, contextAccess: "member" });
  const sharing = <K extends Parameters<typeof runProtectedSharing>[1]>(
    type: K,
    input: Parameters<typeof runProtectedSharing<K>>[2],
  ) => runProtectedSharing(stateDir, type, input, () => {});
  const publication = (automationId: string) => ({
    profileId: owner.profileId,
    automationId,
    now: 200,
    storageOverheadBytes: 0,
  });
  for (const automationId of [isolated, legacy, memberContext]) {
    assert.ok(await sharing("protectedSharing.publishAutomation", publication(automationId)));
  }
  const catalog = (profileId: string, automationId?: string) =>
    sharing("protectedSharing.publicAutomations", { profileId, automationId });
  const expected = {
    id: isolated,
    name: draft.name,
    instructions: draft.instructions,
    whenToNotify: draft.whenToNotify,
    schedule: draft.schedule,
    state: "paused",
    nextCheckAt: null,
    owner: { personId: owner.profileId, displayName: "Family member" },
    publishedAt: 200,
    followers: 0,
    following: false,
    subscribed: false,
  };
  assert.deepEqual(await catalog(follower.profileId), [expected]);
  assert.deepEqual(await catalog(owner.profileId, legacy), []);
  assert.deepEqual(await catalog("inactive"), []);
  const follow = { profileId: follower.profileId, automationId: isolated, storageOverheadBytes: 0 };
  assert.ok(
    await sharing("protectedSharing.followAutomation", { ...follow, now: 300, subscribed: true }),
  );
  assert.deepEqual(await catalog(follower.profileId), [
    { ...expected, followers: 1, following: true, subscribed: true },
  ]);
  assert.equal(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.read",
      input: { profileId: follower.profileId, automationId: isolated },
    }),
    undefined,
  );
  await sharing("protectedSharing.unfollowAutomation", follow);
  assert.deepEqual(await catalog(follower.profileId), [expected]);
  assert.ok(await sharing("protectedSharing.followAutomation", { ...follow, now: 400 }));
  await sharing("protectedSharing.unpublishAutomation", publication(isolated));
  assert.deepEqual(await catalog(follower.profileId), []);
  assert.ok(
    await sharing("protectedSharing.publishAutomation", { ...publication(isolated), now: 500 }),
  );
  assert.deepEqual(await catalog(follower.profileId), [{ ...expected, publishedAt: 500 }]);
  assert.ok(await sharing("protectedSharing.followAutomation", { ...follow, now: 600 }));
  await assert.rejects(
    runProtectedSharing(
      stateDir,
      "protectedSharing.publicAutomations",
      { profileId: follower.profileId },
      () => {
        throw new Error("Synthetic authority retired");
      },
    ),
    /Synthetic authority retired/u,
  );

  const admission = (await listProtectedAdmissions(stateDir)).find(
    (entry) => entry.subject === follower.subject,
  );
  assert.ok(admission);
  await removeProtectedAdmission(
    stateDir,
    { id: admission.id, issuer, ownerSubject: owner.subject },
    () => {},
    () => {},
    () => {},
  );
  assert.deepEqual(await catalog(follower.profileId), []);
  assert.deepEqual(await catalog(viewer.profileId), [{ ...expected, publishedAt: 500 }]);
  assert.equal(
    await executeOpenClawStateWorker(context(), {
      type: "protectedAutomations.read",
      input: { profileId: follower.profileId, automationId: isolated },
    }),
    undefined,
  );
  const ownerAdmission = (await listProtectedAdmissions(stateDir)).find(
    (entry) => entry.subject === owner.subject,
  );
  assert.ok(ownerAdmission);
  await removeProtectedAdmission(
    stateDir,
    { id: ownerAdmission.id, issuer, ownerSubject: viewer.subject },
    () => {},
    () => {},
    () => {},
    {
      profileId: owner.profileId,
      admissionRevision: ownerAdmission.revision,
      revalidate: async () => {},
      assertWritersStopped: () => {},
      enrollPublication: () => ({ finish: () => {} }),
      retireStorage: () => {},
      retainUncertainRemovalCommit: () => assert.fail("Removal should commit."),
    },
  );
  assert.deepEqual(await catalog(viewer.profileId), []);
});
