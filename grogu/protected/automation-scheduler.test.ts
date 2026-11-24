import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { resolveProtectedAutomationCheck } from "../../src/state/protected-automation-pacing.js";
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

void test("restores the accepted check without running a preflight and falls back after no work", async () => {
  const time = createGatewaySchedulerClock(600_000);
  const runs: number[] = [];
  const automation = {
    id: "adaptive",
    version: "2",
    schedule: { kind: "every" as const, everyMs: 120_000 },
    pacing: { minMs: 60_000, maxMs: 600_000 },
    updatedAt: 0,
  };
  const scheduler = createProtectedAutomationScheduler(async (_, atMs) => {
    runs.push(atMs);
    if (runs.length === 1) {
      return resolveProtectedAutomationCheck(
        automation,
        atMs,
        { status: "succeeded", proposedDelayMs: 240_000 },
        0,
      );
    }
    return undefined;
  }, time.clock);
  scheduler.update(automation, {
    version: "2",
    atMs: 720_000,
    reason: "model",
    consecutiveFailures: 0,
  });
  await time.advanceTo(719_999);
  assert.deepEqual(runs, []);
  await time.advanceTo(720_000);
  assert.deepEqual(scheduler.nextCheck("adaptive", "2"), { atMs: 960_000, reason: "model" });
  // A late wake that does no work must not immediately retry the old cursor.
  await time.advanceTo(970_000);
  assert.deepEqual(runs, [720_000, 960_000]);
  assert.deepEqual(scheduler.nextCheck("adaptive", "2"), { atMs: 1_090_000, reason: "fallback" });
  await scheduler.stop();
});

void test("a replaced schedule ignores the earlier run's decision", async () => {
  const time = createGatewaySchedulerClock();
  const finished = createDeferredCore();
  const automation = {
    id: "replaced",
    version: "1",
    schedule: { kind: "every" as const, everyMs: 120_000 },
    pacing: { minMs: 60_000, maxMs: 600_000 },
    updatedAt: 0,
  };
  const scheduler = createProtectedAutomationScheduler(async () => {
    await finished.promise;
    return { version: "1", atMs: 360_000, reason: "model" as const, consecutiveFailures: 0 };
  }, time.clock);
  scheduler.update(automation);
  const running = time.advanceTo(120_000);
  assert.equal(scheduler.nextCheck("replaced", "1"), null);
  scheduler.update(
    { ...automation, version: "2", updatedAt: 120_000 },
    { version: "1", atMs: 600_000, reason: "backoff", consecutiveFailures: 3 },
  );
  finished.resolve();
  await running;
  assert.deepEqual(scheduler.nextCheck("replaced", "2"), { atMs: 240_000, reason: "fallback" });
  scheduler.remove("replaced");
  assert.equal(time.armedAtMs, null);
  await scheduler.stop();
});

void test("bounds proposed delays and backs off failed checks without losing the fallback", () => {
  const automation = {
    version: "3",
    schedule: { everyMs: 90_000 },
    pacing: { minMs: 60_000, maxMs: 360_000 },
  };
  const ended = 1_000_000;
  for (const [proposedDelayMs, delay, reason] of [
    [1, 60_000, "model"],
    [3_600_000, 360_000, "model"],
    [Number.NaN, 90_000, "fallback"],
    [-1, 90_000, "fallback"],
  ] as const) {
    const decision = resolveProtectedAutomationCheck(
      automation,
      ended,
      { status: "succeeded", proposedDelayMs },
      3,
    );
    assert.deepEqual(decision, {
      version: "3",
      atMs: ended + delay,
      reason,
      consecutiveFailures: 0,
    });
  }
  let failures = 0;
  for (const delay of [90_000, 90_000, 300_000, 360_000, 360_000, 360_000]) {
    const decision = resolveProtectedAutomationCheck(
      automation,
      ended,
      { status: "failed" },
      failures,
    );
    assert.equal(decision.atMs, ended + delay);
    assert.equal(decision.reason, "backoff");
    failures = decision.consecutiveFailures;
  }
  assert.equal(failures, 5);
});
