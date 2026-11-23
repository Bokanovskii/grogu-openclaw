import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createGatewaySchedulerClock } from "../../src/test-utils/gateway-scheduler-clock.js";
import { listProtectedTelemetry, readProtectedFeedbackStorageUsage } from "./feedback-store.js";
import { startProtectedUsageRetention } from "./usage-retention.js";
import { listProtectedUsage, pruneProtectedUsage, recordProtectedUsage } from "./usage-store.js";

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
  const runId = randomUUID();
  const input = {
    runId,
    profileId: "synthetic-profile",
    model: "synthetic-model",
    messages: 2,
    tokens: 10,
    failed: false,
    now: start,
    telemetry: {
      id: runId,
      profileId: "synthetic-profile",
      memberLabel: "Synthetic member",
      createdAt: start,
      agentId: "grogu",
      status: "complete" as const,
      chatId: randomUUID(),
      responseId: randomUUID(),
      errorCode: null,
      reasoningSummaryChars: 3,
      admissionMs: 1,
      providerStartMs: 2,
      firstOutputMs: 3,
      firstVisibleMs: 4,
      completionMs: 5,
      files: [],
      requests: [
        {
          requestId: randomUUID(),
          provider: "sparky",
          model: "synthetic",
          outcome: "complete",
          usageSource: "provider",
          wallDurationMs: 2,
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
        },
      ],
      storageOverheadBytes: 0,
    },
  };
  await recordProtectedUsage(stateDir, input);
  await recordProtectedUsage(stateDir, input);
  const telemetryAtCreation = await listProtectedTelemetry(stateDir, { now: start, days: 1 });
  assert.equal(telemetryAtCreation.totals.runs, 1, "duplicate run receipts do not double count");
  assert.equal(telemetryAtCreation.totals.inputTokens.total, 5);
  assert.ok(
    (await readProtectedFeedbackStorageUsage(stateDir, 0, () => {})).some(
      (entry) => entry.id === `run:${runId}`,
    ),
  );
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
  const expiryNow = clock.clock.now() + 1;
  await pruneProtectedUsage(stateDir, expiryNow);
  const expiredTelemetry = await listProtectedTelemetry(stateDir, {
    now: expiryNow,
    days: 90,
  });
  assert.equal(expiredTelemetry.totals.runs, 0);
  assert.equal(
    (await readProtectedFeedbackStorageUsage(stateDir, 0, () => {})).some(
      (entry) => entry.id === `run:${runId}`,
    ),
    false,
  );
});
