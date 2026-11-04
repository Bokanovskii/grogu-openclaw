import { describe, expect, it } from "vitest";
import {
  parseManagedWorkerTriggers,
  planManagedJobPatch,
  readUpdatedManagedJob,
} from "../../grogu/bootstrap.js";
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
  it("accepts only explicit deterministic worker trigger bindings", () => {
    const parsed = parseManagedWorkerTriggers([
      {
        logicalName: "gmail",
        id: "job-gmail",
        template: {
          version: 1,
          source: "gmail",
          tool: {
            server: "gmail",
            name: "gmail_search",
            schemaSha256: "a".repeat(64),
            args: {
              query: "newer_than:1d",
              max: 1,
              include_body: false,
              sanitize_content: true,
            },
          },
          result: {
            complete: "structuredContent.exit_code",
            completeValue: 0,
            guards: [
              { path: "isError", equals: false },
              { path: "structuredContent.tool", equals: "gmail_search" },
              { path: "structuredContent.risk", equals: "read" },
            ],
            items: "structuredContent.messages",
            cursor: "structuredContent.cursor",
            fields: {
              id: "message_id",
              secondaryId: "thread_id",
              timestamp: "timestamp",
            },
          },
          maxItems: 1,
          continuation: {
            delayMs: 60_000,
            intervalMs: 60_000,
            maxOpen: 8,
            maxFires: 3,
            ttlMs: 86_400_000,
          },
        },
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      logicalName: "gmail",
      id: "job-gmail",
      contractVersion: 1,
      trigger: { script: expect.stringContaining("MCP[template.tool.server]") },
    });
    expect(() =>
      parseManagedWorkerTriggers([
        {
          logicalName: "gmail",
          id: "job-gmail",
          trigger: { script: "return { fire: false };" },
        },
      ]),
    ).toThrow(/Invalid or duplicate/);
  });

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
