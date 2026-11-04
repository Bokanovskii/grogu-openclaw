import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Model } from "../llm/types.js";
import { loadGroguPrivateProfile } from "./grogu-private-profile.js";
import {
  modelRequestMetadataSnapshot,
  safeModelError,
  telemetryCode,
  telemetryFinite,
  telemetryHash,
  telemetryIdentifier,
  telemetryRound,
  telemetryUuid,
  type ModelRequestRecord,
} from "./model-request-telemetry-metadata.js";
import {
  createRequestTelemetryClient,
  resolveModelTelemetryDirectory,
} from "./model-request-telemetry-store.js";

const callContext = new AsyncLocalStorage<RequestTracker>();
const httpContext = new AsyncLocalStorage<RequestTracker>();
const clock = { wall: () => Date.now(), monotonic: () => performance.now() };
let store: ReturnType<typeof createRequestTelemetryClient> | undefined;
let lastWarning = -Infinity;
function persist(record: ModelRequestRecord) {
  if (!loadGroguPrivateProfile()) {
    return;
  }
  try {
    store ??= createRequestTelemetryClient(resolveModelTelemetryDirectory());
    store.write(record);
    if (store.droppedWrites && Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      console.error(`[model-request-telemetry] droppedWrites=${store.droppedWrites}`);
    }
  } catch {
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      console.error("[model-request-telemetry] persistence unavailable");
    }
  }
}

type HostClock = { wall: number; monotonic: number };
export function measureHostGap(
  previous: HostClock | undefined,
  current: HostClock,
  intervalMs = 1_000,
) {
  if (!previous) {
    return null;
  }
  const wallElapsedMs = current.wall - previous.wall;
  const monotonicElapsedMs = current.monotonic - previous.monotonic;
  if (wallElapsedMs < 0 || monotonicElapsedMs < 0) {
    return {
      wallElapsedMs,
      monotonicElapsedMs,
      schedulingGapMs: 0,
      possibleSuspensionMs: 0,
      clockChanged: true,
    };
  }
  const schedulingGapMs = Math.max(0, wallElapsedMs - intervalMs);
  return schedulingGapMs < 5_000
    ? null
    : {
        wallElapsedMs: telemetryRound(wallElapsedMs),
        monotonicElapsedMs: telemetryRound(monotonicElapsedMs),
        schedulingGapMs: telemetryRound(schedulingGapMs),
        possibleSuspensionMs: telemetryRound(Math.max(0, wallElapsedMs - monotonicElapsedMs)),
        clockChanged: false,
      };
}

const hostGaps: Array<{ startedAtMs: number; updatedAtMs: number; schedulingGapMs: number }> = [];
let hostTimer: NodeJS.Timeout | undefined;
function startHostMonitor() {
  if (hostTimer || !loadGroguPrivateProfile()) {
    return;
  }
  let previous = { wall: clock.wall(), monotonic: clock.monotonic() };
  hostTimer = callContext.exit(() =>
    setInterval(() => {
      const current = { wall: clock.wall(), monotonic: clock.monotonic() };
      const gap = measureHostGap(previous, current);
      if (gap) {
        const tracker = createRequestTracker({ kind: "host_gap" });
        tracker.record.startedAtMs = previous.wall;
        tracker.update(gap, false);
        tracker.finish({ outcome: "host_gap" });
        hostGaps.push({
          startedAtMs: previous.wall,
          updatedAtMs: current.wall,
          schedulingGapMs: gap.schedulingGapMs,
        });
        if (hostGaps.length > 64) {
          hostGaps.shift();
        }
      }
      previous = current;
    }, 1_000),
  );
  hostTimer.unref();
}

export async function closeModelRequestTelemetry() {
  if (hostTimer) {
    clearInterval(hostTimer);
  }
  hostTimer = undefined;
  const closing = store;
  store = undefined;
  await closing?.close();
}

export type RequestTelemetryFields = {
  kind?: "model_call" | "http_attempt" | "host_gap";
  provider?: string;
  model?: string;
  api?: string;
  callId?: string;
  parentId?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  jobId?: string;
  timeoutMs?: number;
  workClass?: string;
};

export function createRequestTracker(
  fields: RequestTelemetryFields,
  options: {
    write?: (record: ModelRequestRecord) => void;
    time?: typeof clock;
    gaps?: typeof hostGaps;
  } = {},
) {
  const { write = persist, time = clock, gaps = hostGaps } = options;
  const start = time.wall();
  const monoStart = time.monotonic();
  const jobId =
    telemetryUuid(fields.jobId) ??
    telemetryUuid(fields.sessionKey?.match(/:cron:([a-f0-9-]{36})/i)?.[1]);
  const record: ModelRequestRecord = {
    version: 1,
    id: randomUUID(),
    kind: fields.kind ?? "model_call",
    pid: process.pid,
    startedAtMs: start,
    updatedAtMs: start,
    terminal: false,
    phase: "created",
    provider: telemetryCode(fields.provider),
    model: telemetryCode(fields.model),
    api: telemetryCode(fields.api),
    nativeCallId: telemetryCode(fields.callId),
    parentId: fields.parentId ?? null,
    runId: telemetryUuid(fields.runId),
    sessionId: telemetryUuid(fields.sessionId),
    sessionHash: telemetryHash(fields.sessionKey ?? fields.sessionId),
    jobId,
    timeoutMs: telemetryFinite(fields.timeoutMs),
    requestBytes: null,
    responseBytes: 0,
    inputImageCount: null,
    queueWaitMs: null,
    queuedAhead: null,
    admittedAtMs: null,
    headersAtMs: null,
    firstByteAtMs: null,
    firstOutputAtMs: null,
    firstTextAtMs: null,
    firstReasoningAtMs: null,
    firstToolAtMs: null,
    lastOutputAtMs: null,
    lastByteAtMs: null,
    maxByteGapMs: 0,
    responseId: null,
    httpStatus: null,
    cloudflareRay: null,
    outputDeltas: 0,
    textDeltas: 0,
    reasoningDeltas: 0,
    toolDeltas: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    usageSource: null,
    httpAttempts: 0,
    workClass: ["interactive", "scheduled", "utility"].includes(fields.workClass ?? "")
      ? fields.workClass!
      : jobId
        ? "scheduled"
        : telemetryUuid(fields.sessionId)
          ? "interactive"
          : "utility",
  };
  const save = () => {
    record.updatedAtMs = time.wall();
    write(modelRequestMetadataSnapshot(record));
  };
  save();
  const tracker = {
    record,
    // SAFETY: The tracker owns this mutable slot and only assigns AbortSignal instances later.
    signal: undefined as AbortSignal | undefined,
    run<T>(operation: () => T): T {
      return callContext.run(tracker, operation);
    },
    update(fieldsToSave: Record<string, string | number | boolean | null>, flush = true) {
      if (record.terminal) {
        return;
      }
      Object.assign(record, fieldsToSave);
      if (flush) {
        save();
      }
    },
    queue(
      pool: {
        queuedAhead: number;
        queueActiveInteractive?: number;
        queueActiveUtility?: number;
        queueActiveScheduled?: number;
        queueInteractiveReserveAvailable?: boolean;
        queueInteractiveReserveOccupied?: boolean;
        queueInteractiveCooldownActive?: boolean;
        queueNonInteractiveCooldownActive?: boolean;
      },
      timeoutMs: number,
      priority = 0,
    ) {
      tracker.update({
        phase: "queued",
        queuedAhead: pool.queuedAhead,
        queueTimeoutMs: telemetryFinite(timeoutMs),
        queuePriority: priority,
        queueActiveInteractive: pool.queueActiveInteractive ?? null,
        queueActiveUtility: pool.queueActiveUtility ?? null,
        queueActiveScheduled: pool.queueActiveScheduled ?? null,
        queueInteractiveReserveAvailable: pool.queueInteractiveReserveAvailable ?? null,
        queueInteractiveReserveOccupied: pool.queueInteractiveReserveOccupied ?? null,
        queueInteractiveCooldownActive: pool.queueInteractiveCooldownActive ?? null,
        queueNonInteractiveCooldownActive: pool.queueNonInteractiveCooldownActive ?? null,
      });
    },
    admitted(pool?: Parameters<typeof tracker.queue>[0]) {
      if (record.terminal) {
        return;
      }
      const admittedAtMs = time.wall();
      tracker.update({
        admittedAtMs,
        queueWaitMs: Math.max(0, admittedAtMs - start),
        phase: "awaiting_headers",
        ...(pool
          ? {
              queueActiveInteractive: pool.queueActiveInteractive ?? null,
              queueActiveUtility: pool.queueActiveUtility ?? null,
              queueActiveScheduled: pool.queueActiveScheduled ?? null,
              queueInteractiveReserveAvailable: pool.queueInteractiveReserveAvailable ?? null,
              queueInteractiveReserveOccupied: pool.queueInteractiveReserveOccupied ?? null,
              queueInteractiveCooldownActive: pool.queueInteractiveCooldownActive ?? null,
              queueNonInteractiveCooldownActive: pool.queueNonInteractiveCooldownActive ?? null,
            }
          : {}),
      });
    },
    headers(response: Response, reused?: boolean) {
      if (record.terminal) {
        return;
      }
      const ray = response.headers.get("cf-ray");
      tracker.update({
        headersAtMs: record.headersAtMs ?? time.wall(),
        httpStatus: response.status,
        dispatcherReused: reused ?? null,
        cloudflareRay: ray && /^[a-f0-9]{8,32}-[A-Z]{3}$/i.test(ray) ? ray : null,
        phase: "awaiting_body",
      });
    },
    bytes(length: number) {
      if (record.terminal) {
        return;
      }
      const now = time.wall();
      const first = record.firstByteAtMs === null;
      record.firstByteAtMs ??= now;
      if (record.lastByteAtMs !== null) {
        record.maxByteGapMs = Math.max(record.maxByteGapMs, now - record.lastByteAtMs);
      }
      record.lastByteAtMs = now;
      record.responseBytes += length;
      record.phase = "streaming";
      if (first) {
        save();
      }
    },
    output(kind: string) {
      if (record.terminal) {
        return;
      }
      const now = time.wall();
      const first = record.firstOutputAtMs === null;
      record.phase = "streaming";
      record.firstOutputAtMs ??= now;
      record.lastOutputAtMs = now;
      record.outputDeltas++;
      if (kind === "text") {
        record.firstTextAtMs ??= now;
        record.textDeltas++;
      }
      if (kind === "reasoning") {
        record.firstReasoningAtMs ??= now;
        record.reasoningDeltas++;
      }
      if (kind === "tool") {
        record.firstToolAtMs ??= now;
        record.toolDeltas++;
      }
      if (first) {
        save();
      }
    },
    observe(event: unknown) {
      if (record.terminal || !isRecord(event)) {
        return;
      }
      const message = event.message ?? event.error ?? event.partial;
      record.responseId =
        telemetryIdentifier(isRecord(message) ? message.responseId : undefined) ??
        record.responseId;
      if (typeof event.delta === "string" && event.delta.length) {
        if (event.type === "text_delta") {
          tracker.output("text");
        } else if (event.type === "thinking_delta") {
          tracker.output("reasoning");
        } else if (event.type === "toolcall_delta") {
          tracker.output("tool");
        }
      }
    },
    finish(
      params: {
        outcome?: string;
        error?: unknown;
        signal?: AbortSignal;
        usage?: Record<string, string | number | null> | null;
        stopReason?: string;
        requestBytes?: number;
      } = {},
    ) {
      if (record.terminal) {
        return;
      }
      const end = time.wall();
      record.terminal = true;
      record.finishedAtMs = end;
      record.outcome = telemetryCode(params.outcome);
      record.failurePhase =
        params.error ||
        ["http_error", "provider_error", "incomplete_stream"].includes(params.outcome ?? "")
          ? record.phase
          : null;
      record.phase = "finished";
      record.wallDurationMs = Math.max(0, end - start);
      record.monotonicDurationMs = telemetryRound(Math.max(0, time.monotonic() - monoStart));
      const from = record.admittedAtMs ?? start;
      const elapsed = (at: number | null) => (at === null ? null : Math.max(0, at - from));
      record.timeToHeadersMs = elapsed(record.headersAtMs);
      record.timeToFirstByteMs = elapsed(record.firstByteAtMs);
      record.timeToFirstOutputMs = elapsed(record.firstOutputAtMs);
      record.timeToFirstTextMs = elapsed(record.firstTextAtMs);
      record.timeToFirstReasoningMs = elapsed(record.firstReasoningAtMs);
      record.idleAtEndMs = Math.max(
        0,
        end - (record.lastByteAtMs ?? record.lastOutputAtMs ?? from),
      );
      record.stopReason = telemetryCode(params.stopReason) ?? record.stopReason ?? null;
      if (params.usage) {
        Object.assign(record, params.usage);
      }
      if (telemetryFinite(params.requestBytes) !== null) {
        record.requestBytes = params.requestBytes!;
      }
      if (params.error) {
        Object.assign(record, safeModelError(params.error, params.signal));
      }
      const streamingMs = record.firstOutputAtMs === null ? 0 : end - record.firstOutputAtMs;
      record.outputTokensPerSecond =
        record.outputTokens !== null && streamingMs >= 1 && record.outputDeltas > 1
          ? telemetryRound((record.outputTokens * 1_000) / streamingMs)
          : null;
      const relevantGaps = gaps.filter((g) => g.updatedAtMs >= start && g.startedAtMs <= end);
      record.hostGapCount = relevantGaps.length;
      record.maxHostSchedulingGapMs = Math.max(0, ...relevantGaps.map((g) => g.schedulingGapMs));
      save();
    },
  };
  return tracker;
}

export type RequestTracker = ReturnType<typeof createRequestTracker>;
export const currentHttpRequestTelemetry = () => httpContext.getStore();
export function beginModelRequestTelemetry(fields: RequestTelemetryFields) {
  startHostMonitor();
  return createRequestTracker({ ...fields, kind: "model_call" });
}

export function instrumentModelFetch(
  model: Model,
  fetcher: typeof fetch,
  options: { timeoutMs?: number } = {},
): typeof fetch {
  if (!loadGroguPrivateProfile()) {
    return fetcher;
  }
  return async (input, init) => {
    startHostMonitor();
    const parent = callContext.getStore();
    const tracker = createRequestTracker({
      kind: "http_attempt",
      provider: model.provider,
      model: model.id,
      api: model.api,
      parentId: parent?.record.id,
      jobId: typeof parent?.record.jobId === "string" ? parent.record.jobId : undefined,
      workClass: parent?.record.workClass,
      timeoutMs: options.timeoutMs,
    });
    tracker.signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    parent?.update({
      httpAttempts: parent.record.httpAttempts + 1,
      lastHttpAttemptId: tracker.record.id,
    });
    if (typeof init?.body === "string") {
      tracker.update({ requestBytes: Buffer.byteLength(init.body) }, false);
    }
    let requestInit = init;
    if (model.provider === "sparky") {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (!headers.has("x-grogu-request-id")) {
        headers.set("x-grogu-request-id", tracker.record.id);
        tracker.update({ correlationHeader: "x-grogu-request-id" }, false);
        requestInit = { ...init, headers };
      }
    } else {
      tracker.admitted();
    }
    return httpContext.run(tracker, async () => {
      try {
        return await fetcher(input, requestInit);
      } catch (error) {
        tracker.finish({ outcome: "request_error", error, signal: tracker.signal });
        throw error;
      }
    });
  };
}
