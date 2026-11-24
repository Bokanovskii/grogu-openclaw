import type {
  ProtectedAutomationPacing,
  ProtectedAutomationSchedule,
} from "../../packages/gateway-protocol/src/protected.js";
import { computeNextRunAtMs } from "../../src/cron/schedule.js";
import {
  GatewayScheduler,
  type GatewayScheduledJob,
  type GatewaySchedulerClock,
} from "../../src/infra/gateway-scheduler.js";
import {
  resolveProtectedAutomationCheck,
  type ProtectedAutomationCheckDecision,
} from "../../src/state/protected-automation-pacing.js";

export type ProtectedScheduledAutomation = {
  id: string;
  version: string;
  updatedAt: number;
  lastScheduledAt?: number;
} & (
  | { schedule: ProtectedAutomationSchedule; pacing?: undefined }
  | {
      schedule: Extract<ProtectedAutomationSchedule, { kind: "every" }>;
      pacing: ProtectedAutomationPacing;
    }
);

type ScheduledEntry = {
  automation: ProtectedScheduledAutomation;
  timer?: GatewayScheduledJob;
  next?: { atMs: number; reason?: ProtectedAutomationCheckDecision["reason"] };
};

/** Owns wakeups only; the run owner rechecks authority and version before starting. */
export function createProtectedAutomationScheduler(
  run: (
    automation: ProtectedScheduledAutomation,
    scheduledAt: number,
  ) => Promise<void | ProtectedAutomationCheckDecision>,
  clock?: GatewaySchedulerClock,
) {
  const scheduler = new GatewayScheduler({ clock });
  const jobs = new Map<string, ScheduledEntry>();

  const plan = (
    entry: ScheduledEntry,
    after: number,
    accepted?: ProtectedAutomationCheckDecision,
    failedAfter?: number,
  ) => {
    const { automation } = entry;
    const decision = automation.pacing
      ? accepted?.version === automation.version
        ? accepted
        : resolveProtectedAutomationCheck(
            automation,
            after,
            { status: failedAfter === undefined ? "succeeded" : "failed" },
            failedAfter ?? 0,
          )
      : undefined;
    const schedule =
      automation.schedule.kind === "every"
        ? { ...automation.schedule, anchorMs: automation.updatedAt }
        : automation.schedule;
    const atMs = decision?.atMs ?? computeNextRunAtMs(schedule, after);
    if (atMs === undefined) {
      throw new Error("Protected automation has no next scheduled run.");
    }
    entry.timer = scheduler.schedule({
      id: `protected-automation:${automation.id}`,
      atMs,
      run: async () => {
        entry.next = undefined;
        let next: ProtectedAutomationCheckDecision | void = undefined;
        let completed = false;
        try {
          next = await run(automation, atMs);
          completed = true;
        } finally {
          if (jobs.get(automation.id) === entry && !scheduler.signal.aborted) {
            plan(
              entry,
              Math.max(atMs, scheduler.now()),
              next && next.atMs > atMs ? next : undefined,
              completed ? undefined : (decision?.consecutiveFailures ?? 0),
            );
          }
        }
      },
    });
    entry.next = decision ? { atMs, reason: decision.reason } : { atMs };
  };

  return {
    update(automation: ProtectedScheduledAutomation, accepted?: ProtectedAutomationCheckDecision) {
      const previous = jobs.get(automation.id);
      previous?.timer?.cancel();
      const entry = { automation };
      jobs.set(automation.id, entry);
      plan(entry, Math.max(automation.updatedAt, automation.lastScheduledAt ?? 0), accepted);
    },
    remove(id: string) {
      jobs.get(id)?.timer?.cancel();
      jobs.delete(id);
    },
    nextCheck(id: string, version: string) {
      const entry = jobs.get(id);
      return !scheduler.signal.aborted && entry?.automation.version === version
        ? (entry.next ?? null)
        : null;
    },
    beginClose: () => scheduler.beginClose(),
    stop: () => scheduler.stop(),
  };
}
