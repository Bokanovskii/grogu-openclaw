import { describe, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJobExecutionAuthority } from "./service/state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-dispatch-authorization-",
  fakeTimers: false,
});

describe("Cron dispatch authorization", () => {
  it("authorizes before triggers and passes owner-bound authority to trigger and agent execution", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const now = Date.now();
    const dueAt = now + 5_000;
    const makeRecurringJob = (id: string, nextRunAtMs: number) => {
      const job = createDueIsolatedJob({ id, nowMs: now, nextRunAtMs });
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs };
      return job;
    };
    const protectedTrigger = makeRecurringJob("protected-trigger", dueAt);
    protectedTrigger.trigger = { script: "return { fire: true }" };
    const ownerBound = makeRecurringJob("owner-bound", dueAt);
    ownerBound.trigger = { script: "return { fire: true }" };
    const jobs = [
      protectedTrigger,
      makeRecurringJob("ordinary-control", dueAt),
      makeRecurringJob("protected-run-now", now + 60_000),
      ownerBound,
    ];
    await writeCronStoreSnapshot({ storePath, jobs });

    const protectedJobIds = new Set(["protected-trigger", "protected-run-now"]);
    const memberAccess = new Map([...protectedJobIds].map((id) => [id, true]));
    const terminalEvents = new Map(
      jobs.map((job) => [job.id, createDeferredCore<CronEvent>()] as const),
    );
    const dispatchChecks: string[] = [];
    const triggerEvaluations: string[] = [];
    const assertInvocationCurrent = vi.fn();
    const ownerAuthority: CronJobExecutionAuthority = {
      toolsAllow: ["research_topics"],
      toolBindings: { research_topics: { profileId: "profile-owner" } },
      assertInvocationCurrent,
    };
    const onEvent = vi.fn((event: CronEvent) => {
      if (event.action === "started" && protectedJobIds.has(event.jobId)) {
        memberAccess.set(event.jobId, false);
      }
      if (event.action === "finished") {
        terminalEvents.get(event.jobId)?.resolve(event);
      }
    });
    const runIsolatedAgentJob = vi.fn(
      async ({
        job,
        executionAuthority,
      }: {
        job: { id: string };
        executionAuthority?: CronJobExecutionAuthority;
      }) => ({
        status: "ok" as const,
        summary: job.id,
        ...(executionAuthority ? { executionAuthority } : {}),
      }),
    );
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const cron = new CronService({
      scheduler,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent,
      resolveJobExecutionAuthority: async ({ job }) => {
        dispatchChecks.push(job.id);
        if (protectedJobIds.has(job.id) && !memberAccess.get(job.id)) {
          throw new Error("automation membership revoked");
        }
        return job.id === "owner-bound" ? ownerAuthority : undefined;
      },
      evaluateCronTrigger: async ({ job, executionAuthority }) => {
        triggerEvaluations.push(job.id);
        if (job.id === "owner-bound") {
          expect(executionAuthority).toBe(ownerAuthority);
        }
        return { kind: "evaluated", fire: true };
      },
    });

    try {
      await cron.start();
      await clock.advanceBy(dueAt - now);
      const protectedFinished = await terminalEvents.get("protected-trigger")?.promise;
      const ordinaryFinished = await terminalEvents.get("ordinary-control")?.promise;
      const ownerFinished = await terminalEvents.get("owner-bound")?.promise;

      const runNow = await cron.enqueueRun("protected-run-now", "force");
      const runNowFinished = await terminalEvents.get("protected-run-now")?.promise;

      expect(protectedFinished).toMatchObject({
        action: "finished",
        status: "error",
        error: expect.stringContaining("automation membership revoked"),
      });
      expect(ordinaryFinished).toMatchObject({ action: "finished", status: "ok" });
      expect(ownerFinished).toMatchObject({ action: "finished", status: "ok" });
      expect(runNow).toMatchObject({ ok: true, enqueued: true });
      expect(runNowFinished).toMatchObject({
        action: "finished",
        status: "error",
        error: expect.stringContaining("automation membership revoked"),
      });
      expect(dispatchChecks.toSorted()).toEqual(
        ["protected-trigger", "ordinary-control", "protected-run-now", "owner-bound"].toSorted(),
      );
      expect(triggerEvaluations).toEqual(["owner-bound"]);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: "ordinary-control" }),
        }),
      );
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: "owner-bound" }),
          executionAuthority: ownerAuthority,
        }),
      );
      expect(assertInvocationCurrent).toHaveBeenCalled();
    } finally {
      cron.stop();
      await scheduler.stop();
      await cleanup();
    }
  });
});
