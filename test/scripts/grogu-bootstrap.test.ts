import { describe, expect, it } from "vitest";
import { planManagedJobPatch, readUpdatedManagedJob } from "../../grogu/bootstrap.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";

const job: CronJob = {
  id: "synthetic-job",
  name: "Watchdog",
  enabled: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  configRevision: "synthetic-revision",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic prompt.", model: "synthetic/model" },
  state: {},
};

describe("revision-checked metadata bootstrap", () => {
  it("is idempotent and patches only changed fields while preserving a manual pause and model", () => {
    const before = structuredClone(job);
    expect(planManagedJobPatch("watchdog", job, { name: job.name })).toBeNull();
    expect(planManagedJobPatch("watchdog", job, { description: "New description" })).toEqual({
      id: job.id,
      expectedConfigRevision: job.configRevision,
      patch: { description: "New description" },
    });
    expect(job).toEqual(before);
  });

  it("refuses active work or missing revision evidence instead of guessing or canceling", () => {
    expect(() =>
      planManagedJobPatch(
        "watchdog",
        {
          ...job,
          state: { runningAtMs: 1 },
        },
        { name: "Renamed" },
      ),
    ).toThrow(/running/);
    expect(() =>
      planManagedJobPatch(
        "watchdog",
        {
          ...job,
          configRevision: undefined,
        },
        { name: "Renamed" },
      ),
    ).toThrow(/revision/);
  });

  it("accepts a committed update with a native delivery preview without widening job validation", () => {
    const updated = readUpdatedManagedJob({
      ...job,
      description: "Updated description",
      deliveryPreview: { label: "Unresolved route", detail: "Synthetic delivery diagnostic." },
    });
    expect(
      planManagedJobPatch("watchdog", updated, { description: "Updated description" }),
    ).toBeNull();
    expect(() =>
      readUpdatedManagedJob({ ...job, deliveryPreview: { label: "Incomplete" } }),
    ).toThrow();
    expect(() => readUpdatedManagedJob({ ...job, unexpected: true })).toThrow();
  });
});
