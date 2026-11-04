import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGroguRuntimeFixture } from "./grogu-runtime.test-support.js";
import {
  countRequestImages,
  normalizeReportedUsage,
  safeModelError,
} from "./model-request-telemetry-metadata.js";
import { createRequestTelemetryClient } from "./model-request-telemetry-store.js";
import { createWireTelemetryObserver } from "./model-request-telemetry-wire.js";
import { createRequestTracker, measureHostGap } from "./model-request-telemetry.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixtures.splice(0).forEach((f) => f.cleanup());
});

describe("metadata-only request telemetry", () => {
  it("preserves timing, usage, queue context and host-gap attribution without retaining content", () => {
    let now = 0;
    const records: ReturnType<typeof createRequestTracker>["record"][] = [];
    const tracker = createRequestTracker(
      {
        provider: "sparky",
        model: "synthetic",
        sessionKey: "private-conversation-key",
        timeoutMs: 100,
      },
      {
        write: (r) => records.push(r),
        time: { wall: () => now, monotonic: () => now },
        gaps: [{ startedAtMs: 0, updatedAtMs: 5_000, schedulingGapMs: 4_000 }],
      },
    );
    tracker.queue(
      {
        queuedAhead: 4,
        queueActiveInteractive: 1,
        queueActiveUtility: 1,
        queueActiveScheduled: 2,
        queueInteractiveReserveAvailable: false,
        queueInteractiveReserveOccupied: true,
        queueInteractiveCooldownActive: false,
        queueNonInteractiveCooldownActive: true,
      },
      100,
      1,
    );
    now = 10;
    tracker.admitted({
      queuedAhead: 2,
      queueActiveInteractive: 2,
      queueActiveUtility: 0,
      queueActiveScheduled: 2,
      queueInteractiveReserveAvailable: false,
      queueInteractiveReserveOccupied: true,
      queueInteractiveCooldownActive: false,
      queueNonInteractiveCooldownActive: false,
    });
    now = 20;
    tracker.headers(new Response(null, { headers: { "cf-ray": "abcdef123456-SJC" } }), true);
    const observer = createWireTelemetryObserver(tracker, "text/event-stream");
    for (const text of [
      'data: {"choices":[{"delta":{"content":"private answer","reasoning_content":"private thought"}}]}\r',
      '\n\r\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
      "data: [DONE]\n\n",
    ]) {
      now += 10;
      observer.chunk(new TextEncoder().encode(text));
    }
    tracker.update({ prompt: "private prompt", url: "https://private.invalid/secret" }, false);
    observer.finish("eof");
    const record = records.at(-1)!;
    expect(record).toMatchObject({
      queueWaitMs: 10,
      queueActiveInteractive: 2,
      queueActiveUtility: 0,
      queueActiveScheduled: 2,
      queueInteractiveReserveAvailable: false,
      queueInteractiveReserveOccupied: true,
      queueInteractiveCooldownActive: false,
      queueNonInteractiveCooldownActive: false,
      timeToHeadersMs: 10,
      inputTokens: 10,
      cacheReadTokens: 5,
      outputTokens: 2,
      outcome: "protocol_complete",
      hostGapCount: 1,
    });
    expect(JSON.stringify(records)).not.toMatch(/private|secret/);
    expect(record.sessionHash).toMatch(/^[a-f0-9]{24}$/);
    tracker.finish({ outcome: "duplicate" });
    expect(records.at(-1)).toBe(record);
  });

  it("keeps unknown errors hashed and distinguishes incomplete wire streams from provider errors", () => {
    const error = Object.assign(new Error("private full error body"), {
      name: "private-error-name",
      code: "private-error-code",
    });
    expect(safeModelError(error)).toMatchObject({
      errorName: "OtherError",
      errorCode: null,
      errorCodeHash: expect.any(String),
    });
    expect(JSON.stringify(safeModelError(error))).not.toContain("private");
    const tracker = createRequestTracker({ kind: "http_attempt" }, { write: () => {} });
    tracker.headers(new Response(null));
    const observer = createWireTelemetryObserver(tracker, "text/event-stream");
    observer.chunk(
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"private"}}]}\n\ndata: [DONE]\n\n',
      ),
    );
    observer.finish("eof");
    expect(tracker.record.outcome).toBe("incomplete_stream");
    const provider = createRequestTracker({ kind: "http_attempt" }, { write: () => {} });
    const failed = createWireTelemetryObserver(provider, "application/json");
    failed.chunk(
      new TextEncoder().encode(
        '{"error":{"code":"private-code","type":"invalid_request_error","message":"private body"}}',
      ),
    );
    failed.finish("eof");
    expect(provider.record).toMatchObject({
      outcome: "provider_error",
      providerErrorCode: null,
      providerErrorType: "invalid_request_error",
    });
  });

  it("bounds wire parsing and does not count missing terminal usage as observed zero", () => {
    const tracker = createRequestTracker({}, { write: () => {} });
    const observer = createWireTelemetryObserver(tracker, "text/event-stream");
    observer.chunk(new TextEncoder().encode(`data: ${"x".repeat(65_537)}\n\n`));
    observer.finish("eof");
    expect(tracker.record.wireParserTruncated).toBe(true);
    expect(normalizeReportedUsage({ input: 0, output: 0 }, { successful: false })).toBeNull();
    expect(normalizeReportedUsage({ input: 2, output: 3, cacheRead: 4 })).toMatchObject({
      inputTokens: 6,
      outputTokens: 3,
    });
    expect(
      countRequestImages({
        input: [{ type: "input_image" }, { content: [{ type: "image_url" }] }],
      }),
    ).toBe(2);
    expect(
      measureHostGap({ wall: 0, monotonic: 0 }, { wall: 10_000, monotonic: 1_000 }),
    ).toMatchObject({ schedulingGapMs: 9_000, possibleSuspensionMs: 9_000 });
  });

  it("persists asynchronously in the real worker and reopens the existing SQLite schema with private permissions", async () => {
    const f = createGroguRuntimeFixture();
    fixtures.push(f);
    const directory = path.join(f.directory, "telemetry");
    let client = createRequestTelemetryClient(directory);
    const tracker = createRequestTracker(
      { kind: "model_call", provider: "sparky", model: "synthetic" },
      { write: (r) => client.write(r) },
    );
    tracker.finish({ outcome: "completed" });
    try {
      const records = await client.read();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: tracker.record.id,
        terminal: true,
        outcome: "completed",
      });
      expect(fs.statSync(path.join(directory, "requests.sqlite")).mode & 0o077).toBe(0);
    } finally {
      await client.close();
    }
    client = createRequestTelemetryClient(directory);
    try {
      expect(await client.read()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("drains a pending terminal snapshot after a failed batch without requiring another model request", async () => {
    vi.useFakeTimers();
    const failedBatch = createDeferredCore<unknown>();
    const run = vi.spyOn(WorkerTaskPool.prototype, "run").mockResolvedValue([]);
    run.mockImplementationOnce(() => failedBatch.promise);
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createRequestTelemetryClient("/synthetic/telemetry");
    const tracker = createRequestTracker(
      { provider: "sparky", model: "synthetic" },
      { write: (record) => client.write(record) },
    );
    tracker.finish({ outcome: "completed" });
    const drain = client.read();
    failedBatch.reject(new Error("private worker diagnostic"));
    await expect(drain).rejects.toThrow("private worker diagnostic");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      action: "write",
      records: [{ id: tracker.record.id, terminal: true, outcome: "completed" }],
    });
    expect(client.droppedWrites).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private worker diagnostic");
    await client.close();
  });
});
