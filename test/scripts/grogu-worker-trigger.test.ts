import { describe, expect, it, vi } from "vitest";
import { evaluatePolicy } from "../../grogu/policy.js";
import {
  renderWorkerTriggerScript,
  workerTriggerScriptSha256,
  workerTriggerTemplateSchema,
} from "../../grogu/worker-trigger-templates.js";
import type { DeferredCronNotifications } from "../../src/cron/service/state.js";
import { executeJobCore } from "../../src/cron/service/timer-execution.js";
import { applyTriggerNoFireResult } from "../../src/cron/service/timer-outcomes.js";
import type { CronJob } from "../../src/cron/types.js";

describe("deterministic private worker trigger", () => {
  it("persists unchanged cursor state and invokes zero agent/model phases", async () => {
    const marker = "GROGU_DETERMINISTIC_POLL_V1";
    const startedAt = Date.parse("2026-11-03T00:00:00.000Z");
    const template = workerTriggerTemplateSchema.parse({
      version: 1,
      templateId: "messages-metadata-v1",
      schemaSha256: "a".repeat(64),
      toolsAllow: ["seaglass__recent_messages"],
      args: { limit: 1, include_text: false },
      maxItems: 1,
      continuation: {
        delayMs: 60_000,
        intervalMs: 60_000,
        nativeSweepIntervalMs: 300_000,
        maxOpen: 8,
        maxFires: 2,
        ttlMs: 86_400_000,
      },
    });
    const triggerScript = renderWorkerTriggerScript(template);
    const job: CronJob = {
      id: "synthetic-worker",
      name: "Synthetic unchanged source",
      enabled: true,
      createdAtMs: startedAt,
      updatedAtMs: startedAt,
      schedule: { kind: "every", everyMs: 2_000, anchorMs: startedAt },
      sessionTarget: "isolated",
      wakeMode: "now",
      trigger: { script: triggerScript },
      payload: {
        kind: "agentTurn",
        model: "sparky/synthetic",
        message: `${marker}\nResearch only a new actionable delta.`,
        toolsAllow: [...template.toolsAllow],
      },
      delivery: { mode: "none" },
      state: {},
    };
    expect(
      evaluatePolicy({ messages: { queue: { byChannel: { telegram: "followup" } } } }, [job], {
        automaticModel: "sparky/synthetic",
        ownerOverrides: { configPaths: [], jobIds: [] },
        workerContracts: [
          {
            jobId: job.id,
            contractVersion: 1,
            templateId: template.templateId,
            schemaSha256: template.schemaSha256,
            triggerSha256: workerTriggerScriptSha256(triggerScript),
            toolsAllow: [...template.toolsAllow],
            markers: [marker],
          },
        ],
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
      expect(result.triggerEval?.fired).toBe(false);
      const deferredNotifications: DeferredCronNotifications = [];
      applyTriggerNoFireResult(
        state as never,
        job,
        {
          startedAt: startedAt + tick * 2_000,
          endedAt: startedAt + tick * 2_000 + 10,
          triggerEval: result.triggerEval!,
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
