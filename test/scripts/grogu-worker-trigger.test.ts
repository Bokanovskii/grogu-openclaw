import { describe, expect, it, vi } from "vitest";
import { evaluatePolicy } from "../../grogu/policy.js";
import type { DeferredCronNotifications } from "../../src/cron/service/state.js";
import { executeJobCore } from "../../src/cron/service/timer-execution.js";
import { applyJobResult } from "../../src/cron/service/timer-outcomes.js";
import type { CronJob } from "../../src/cron/types.js";

describe("deterministic private worker trigger", () => {
  it("persists unchanged cursor state and invokes zero agent/model phases", async () => {
    const marker = "GROGU_DETERMINISTIC_POLL_V1";
    const startedAt = Date.parse("2026-11-03T00:00:00.000Z");
    const job: CronJob = {
      id: "synthetic-worker",
      name: "Synthetic unchanged source",
      enabled: true,
      createdAtMs: startedAt,
      updatedAtMs: startedAt,
      schedule: { kind: "every", everyMs: 2_000, anchorMs: startedAt },
      sessionTarget: "isolated",
      wakeMode: "now",
      trigger: { script: "return { fire: false, state: { cursor: 'stable' } };" },
      payload: {
        kind: "agentTurn",
        model: "sparky/synthetic",
        message: `${marker}\nResearch only a new actionable delta.`,
      },
      delivery: { mode: "none" },
      state: {},
    };
    expect(
      evaluatePolicy({ messages: { queue: { byChannel: { telegram: "followup" } } } }, [job], {
        automaticModel: "sparky/synthetic",
        ownerOverrides: { configPaths: [], jobIds: [] },
        workerContracts: [{ jobId: job.id, markers: [marker] }],
      }),
    ).toEqual([]);

    const runIsolatedAgentJob = vi.fn();
    const observedStates: unknown[] = [];
    const state = {
      deps: {
        nowMs: () => startedAt,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        evaluateCronTrigger: vi.fn(async ({ state: triggerState }) => {
          observedStates.push(triggerState);
          return { kind: "ok" as const, fire: false, state: { cursor: "stable" } };
        }),
        runIsolatedAgentJob,
      },
    };

    for (let tick = 0; tick < 3; tick += 1) {
      const result = await executeJobCore(state as never, job);
      expect(result.status).toBe("ok");
      const deferredNotifications: DeferredCronNotifications = [];
      applyJobResult(
        state as never,
        job,
        {
          ...result,
          startedAt: startedAt + tick * 2_000,
          endedAt: startedAt + tick * 2_000 + 10,
        },
        { deferredNotifications },
      );
      expect(deferredNotifications).toEqual([]);
    }

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(observedStates).toEqual([undefined, { cursor: "stable" }, { cursor: "stable" }]);
    expect(job.state.triggerState).toEqual({ cursor: "stable" });
  });
});
