import assert from "node:assert/strict";
import { test } from "node:test";
import { createGatewaySchedulerClock } from "../../src/test-utils/gateway-scheduler-clock.js";
import { createProtectedAutomationScheduler } from "./automation-scheduler.js";

void test("coalesces overdue schedules and resumes the normal cadence after restart", async () => {
  const time = createGatewaySchedulerClock(5_000);
  const runs: number[] = [];
  const automation = {
    id: "synthetic",
    version: "1",
    schedule: { kind: "every" as const, everyMs: 1_000 },
    updatedAt: 1_000,
  };
  const scheduler = createProtectedAutomationScheduler(async (_, due) => {
    runs.push(due);
  }, time.clock);
  scheduler.update(automation);
  await time.advanceBy(0);
  assert.deepEqual(runs, [2_000]);
  assert.equal(time.armedAtMs, 6_000);
  await scheduler.stop();

  const restarted = createProtectedAutomationScheduler(async (_, due) => {
    runs.push(due);
  }, time.clock);
  restarted.update({ ...automation, lastScheduledAt: 5_000 });
  await time.advanceBy(0);
  assert.deepEqual(runs, [2_000]);
  await time.advanceBy(1_000);
  assert.deepEqual(runs, [2_000, 6_000]);
  await restarted.stop();
});
