import type { ProtectedAutomationSchedule } from "../../packages/gateway-protocol/src/protected.js";
import { computeNextRunAtMs } from "../../src/cron/schedule.js";
import {
  GatewayScheduler,
  type GatewayScheduledJob,
  type GatewaySchedulerClock,
} from "../../src/infra/gateway-scheduler.js";

export type ProtectedScheduledAutomation = {
  id: string;
  version: string;
  schedule: ProtectedAutomationSchedule;
  updatedAt: number;
  lastScheduledAt?: number;
};

type ScheduledEntry = {
  automation: ProtectedScheduledAutomation;
  timer?: GatewayScheduledJob;
  atMs?: number;
};

/** Owns wakeups only; the run owner rechecks authority and version before starting. */
export function createProtectedAutomationScheduler(
  run: (automation: ProtectedScheduledAutomation, scheduledAt: number) => Promise<void>,
  clock?: GatewaySchedulerClock,
) {
  const scheduler = new GatewayScheduler({ clock });
  const jobs = new Map<string, ScheduledEntry>();

  const plan = (entry: ScheduledEntry, after: number) => {
    const { automation } = entry;
    const schedule =
      automation.schedule.kind === "every"
        ? { ...automation.schedule, anchorMs: automation.updatedAt }
        : automation.schedule;
    const atMs = computeNextRunAtMs(schedule, after);
    if (atMs === undefined) {
      throw new Error("Protected automation has no next scheduled run.");
    }
    entry.timer = scheduler.schedule({
      id: `protected-automation:${automation.id}`,
      atMs,
      run: async () => {
        entry.atMs = undefined;
        try {
          await run(automation, atMs);
        } finally {
          if (jobs.get(automation.id) === entry && !scheduler.signal.aborted) {
            plan(entry, Math.max(atMs, scheduler.now()));
          }
        }
      },
    });
    entry.atMs = atMs;
  };

  return {
    update(automation: ProtectedScheduledAutomation) {
      const previous = jobs.get(automation.id);
      previous?.timer?.cancel();
      const entry = { automation };
      jobs.set(automation.id, entry);
      plan(entry, Math.max(automation.updatedAt, automation.lastScheduledAt ?? 0));
    },
    remove(id: string) {
      jobs.get(id)?.timer?.cancel();
      jobs.delete(id);
    },
    nextCheckAtMs(id: string, version: string) {
      const entry = jobs.get(id);
      return !scheduler.signal.aborted && entry?.automation.version === version
        ? (entry.atMs ?? null)
        : null;
    },
    beginClose: () => scheduler.beginClose(),
    stop: () => scheduler.stop(),
  };
}
