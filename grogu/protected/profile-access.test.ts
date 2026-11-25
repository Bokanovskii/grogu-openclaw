import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";

void test("binds an approved identity on admission but not for a logged-out session", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "profile-access-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    await rm(stateDir, { recursive: true, force: true });
  });
  const context = () => captureOpenClawStateWorkerContext({ env });
  const identity = { issuer: "https://access.example.test", subject: randomUUID() };
  const profile = await ensureCanonicalUserProfileForVerifiedIdentity(identity, { env });
  const session = {
    profileId: profile.id,
    sessionHash: randomUUID(),
    expiresAt: Date.now() + 60_000,
  };
  const admit = () =>
    updateCanonicalUserProfileAccess(
      { action: "admit", ...session, protectedIdentity: identity },
      { env },
    );
  const rows = () =>
    executeOpenClawStateWorker(context(), {
      type: "protectedAccess.listAdmissions",
      input: undefined,
    });
  await executeOpenClawStateWorker(context(), {
    type: "protectedAccess.addSubject",
    input: { ...identity, now: Date.now() },
  });
  assert.equal((await rows())[0]?.profileId, undefined);
  assert.equal(await admit(), true);
  const bound = (await rows())[0];
  assert.equal(bound?.profileId, profile.id);
  assert.equal(typeof bound?.lastActiveAt, "number");
  assert.equal(
    await updateCanonicalUserProfileAccess({ action: "logout", ...session }, { env }),
    true,
  );
  assert.equal(await admit(), false);
  assert.deepEqual((await rows())[0], bound);
});
