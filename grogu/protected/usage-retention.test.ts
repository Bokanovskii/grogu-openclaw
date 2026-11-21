import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createGatewaySchedulerClock } from "../../src/test-utils/gateway-scheduler-clock.js";
import { startProtectedUsageRetention } from "./usage-retention.js";
import { listProtectedUsage, recordProtectedUsage } from "./usage-store.js";

void test("usage is counted once and idle retention joins before shutdown", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-usage-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const resources: { retention?: Awaited<ReturnType<typeof startProtectedUsageRetention>> } = {};
  t.after(async () => {
    await resources.retention?.stop();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const start = Date.UTC(2026, 0, 1);
  const input = {
    runId: "synthetic-run",
    profileId: "synthetic-profile",
    model: "synthetic-model",
    messages: 2,
    tokens: 10,
    failed: false,
    now: start,
  };
  await recordProtectedUsage(stateDir, input);
  await recordProtectedUsage(stateDir, input);
  const clock = createGatewaySchedulerClock(start + 89 * 24 * 60 * 60_000);
  const retention = await startProtectedUsageRetention(stateDir, clock.clock);
  resources.retention = retention;
  assert.deepEqual(await listProtectedUsage(stateDir, input.profileId, clock.clock.now()), [
    {
      day: "2026-01-01",
      messages: 2,
      tokens: 10,
      models: ["synthetic-model"],
      errors: 0,
      missingUsage: 0,
      missingMessages: 0,
    },
  ]);
  void clock.advanceBy(24 * 60 * 60_000);
  await retention.stop();
  assert.deepEqual(
    await listProtectedUsage(stateDir, input.profileId, start + 89 * 24 * 60 * 60_000),
    [],
  );
});
