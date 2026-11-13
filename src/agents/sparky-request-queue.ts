import { parseRetryAfterHeadersSeconds } from "@openclaw/ai/internal/retry-after";
import { toErrorObject } from "../infra/errors.js";
import type { Model } from "../llm/types.js";
import { currentHttpRequestTelemetry } from "./model-request-telemetry.js";

type Priority = -1 | 0 | 1;
type SparkyWorkClass = "interactive" | "utility" | "scheduled";
type CooldownScope = "all" | "non-interactive";
type AdmissionEntry = {
  signal?: AbortSignal;
  priority: Priority;
  workClass: SparkyWorkClass;
  queuedAt: number;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
};
const abortReason = (signal?: AbortSignal) =>
  signal?.reason == null
    ? new DOMException("Sparky request cancelled", "AbortError")
    : toErrorObject(signal.reason, "Sparky request cancelled");
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const priorityForWorkClass = (workClass: SparkyWorkClass): Priority =>
  workClass === "interactive" ? 1 : workClass === "scheduled" ? -1 : 0;

export function sparkyUtilityBounds(modelRef: string | undefined) {
  return modelRef?.startsWith("sparky/")
    ? { timeoutMs: 120_000, maxTokens: 1_024 }
    : { timeoutMs: 20_000, maxTokens: 240 };
}

export function createSparkyAdmission(
  options: {
    maxWaiting?: number;
    maxActive?: number;
    interactiveReserve?: number;
    now?: () => number;
    agingMs?: number;
  } = {},
) {
  const {
    maxWaiting = 32,
    maxActive = 4,
    interactiveReserve = Math.min(1, maxActive),
    now = Date.now,
    agingMs = 120_000,
  } = options;
  if (
    !Number.isSafeInteger(maxActive) ||
    maxActive < 1 ||
    !Number.isSafeInteger(interactiveReserve) ||
    interactiveReserve < 0 ||
    interactiveReserve > maxActive
  ) {
    throw new RangeError("Invalid Sparky admission capacity");
  }
  const maxNonInteractive = maxActive - interactiveReserve;
  let active = 0;
  const activeByWorkClass: Record<SparkyWorkClass, number> = {
    interactive: 0,
    utility: 0,
    scheduled: 0,
  };
  let allPauses = 0;
  let nonInteractivePauses = 0;
  let lastPriority: Priority = 0;
  const waiting: AdmissionEntry[] = [];
  const canAdmit = (entry: AdmissionEntry) => {
    if (allPauses > 0 || active >= maxActive) {
      return false;
    }
    if (entry.workClass === "interactive") {
      return (
        nonInteractivePauses === 0 ||
        (interactiveReserve > 0 && activeByWorkClass.interactive < interactiveReserve)
      );
    }
    return (
      nonInteractivePauses === 0 &&
      activeByWorkClass.utility + activeByWorkClass.scheduled < maxNonInteractive
    );
  };
  function pump() {
    while (active < maxActive && waiting.length) {
      const eligible = waiting
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => canAdmit(entry));
      if (eligible.length === 0) {
        return;
      }
      const aged =
        lastPriority >= 0
          ? eligible.find(({ entry }) => now() - entry.queuedAt >= agingMs)?.index
          : undefined;
      const index =
        aged !== undefined
          ? aged
          : eligible.reduce((best, current) =>
              current.entry.priority > best.entry.priority ? current : best,
            ).index;
      const next = waiting.splice(index, 1)[0]!;
      next.detach();
      if (next.signal?.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      lastPriority = next.priority;
      active++;
      activeByWorkClass[next.workClass]++;
      let released = false;
      next.resolve(() => {
        if (!released) {
          released = true;
          active--;
          activeByWorkClass[next.workClass]--;
          pump();
        }
      });
    }
  }
  const telemetrySnapshot = () => ({
    queuedAhead: waiting.length + (active >= maxActive ? active : 0),
    queueActiveInteractive: activeByWorkClass.interactive,
    queueActiveUtility: activeByWorkClass.utility,
    queueActiveScheduled: activeByWorkClass.scheduled,
    queueInteractiveReserveAvailable:
      active < maxActive &&
      allPauses === 0 &&
      (nonInteractivePauses === 0 ||
        (interactiveReserve > 0 && activeByWorkClass.interactive < interactiveReserve)),
    queueInteractiveReserveOccupied: active > maxNonInteractive,
    queueInteractiveCooldownActive: allPauses > 0,
    queueNonInteractiveCooldownActive: allPauses > 0 || nonInteractivePauses > 0,
  });
  return {
    async pauseFor(ms: number, scope: CooldownScope, delay = sleep) {
      if (scope === "all") {
        allPauses++;
      } else {
        nonInteractivePauses++;
      }
      try {
        await delay(ms);
      } finally {
        if (scope === "all") {
          allPauses--;
        } else {
          nonInteractivePauses--;
        }
        pump();
      }
    },
    acquire(signal?: AbortSignal, workClass: SparkyWorkClass = "utility"): Promise<() => void> {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (!["interactive", "utility", "scheduled"].includes(workClass)) {
        return Promise.reject(new RangeError("Invalid request work class"));
      }
      if (waiting.length >= maxWaiting) {
        return Promise.reject(
          new Error("Sparky request queue is full; retry after current work finishes"),
        );
      }
      return new Promise((resolve, reject) => {
        const entry: AdmissionEntry = {
          resolve,
          reject,
          signal,
          priority: priorityForWorkClass(workClass),
          workClass,
          queuedAt: now(),
          detach: () => signal?.removeEventListener("abort", cancel),
        };
        const cancel = () => {
          const index = waiting.indexOf(entry);
          if (index < 0) {
            return;
          }
          waiting.splice(index, 1);
          entry.detach();
          reject(abortReason(signal));
        };
        waiting.push(entry);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
        pump();
      });
    },
    get activeCount() {
      return active;
    },
    get activeByWorkClass() {
      return { ...activeByWorkClass };
    },
    get waiting() {
      return waiting.length;
    },
    get queuedAhead() {
      return telemetrySnapshot().queuedAhead;
    },
    get telemetry() {
      return telemetrySnapshot();
    },
  };
}

type Admission = ReturnType<typeof createSparkyAdmission>;
const pools = new Map<string, Admission>();

function createSseDoneObserver() {
  const decoder = new TextDecoder();
  let line = "";
  let overflow = false;
  let done = false;
  return (chunk: Uint8Array) => {
    if (done) {
      return true;
    }
    for (const char of decoder.decode(chunk, { stream: true })) {
      if (char === "\n" || char === "\r") {
        if (!overflow && /^data:[ \t]*\[DONE\][ \t]*$/i.test(line)) {
          done = true;
        }
        line = "";
        overflow = false;
      } else if (!overflow) {
        line += char;
        if (line.length > 1_024) {
          line = "";
          overflow = true;
        }
      }
    }
    return done;
  };
}

/** Admission surrounds the guarded transport; no URL, credential, or sandbox policy is bypassed. */
export function queueSparkyFetch(
  model: Model,
  fetcher: typeof fetch,
  options: {
    pool?: Admission;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): typeof fetch {
  if (model.provider !== "sparky") {
    return fetcher;
  }
  const key = new URL(model.baseUrl).origin;
  const now = options.now ?? Date.now;
  const pool = options.pool ?? pools.get(key) ?? createSparkyAdmission();
  if (!options.pool) {
    pools.set(key, pool);
  }
  return async (input, init) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const waitMs = options.timeoutMs ?? 300_000;
    const queuedAt = now();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Sparky local queue deadline expired", "TimeoutError")),
      waitMs,
    );
    timer.unref?.();
    const waitingSignal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const telemetry = currentHttpRequestTelemetry();
    const workClass: SparkyWorkClass =
      telemetry?.record.workClass === "interactive" || telemetry?.record.workClass === "scheduled"
        ? telemetry.record.workClass
        : "utility";
    const priority = priorityForWorkClass(workClass);
    telemetry?.queue(pool.telemetry, waitMs, priority);
    let release: () => void;
    try {
      release = await pool.acquire(waitingSignal, workClass);
    } finally {
      clearTimeout(timer);
    }
    if (waitingSignal.aborted || now() - queuedAt >= waitMs) {
      release();
      throw waitingSignal.aborted
        ? abortReason(waitingSignal)
        : new DOMException(
            "Sparky local queue deadline expired before request dispatch",
            "TimeoutError",
          );
    }
    telemetry?.admitted(pool.telemetry);
    let settled = false;
    let detach = () => {};
    const finish = (cooldown = false) => {
      if (settled) {
        return;
      }
      settled = true;
      detach();
      if (cooldown) {
        void (options.sleep ?? sleep)(1_500).then(release, release);
      } else {
        release();
      }
    };
    try {
      callerSignal?.throwIfAborted();
      const response = await fetcher(input, init);
      if (response.status === 429) {
        const retryAfter = parseRetryAfterHeadersSeconds(response.headers, now());
        const delayMs =
          retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1_000, 120_000)
            : 15_000;
        void pool
          .pauseFor(delayMs, workClass === "interactive" ? "all" : "non-interactive", options.sleep)
          .catch(() => undefined);
      }
      if (!response.body) {
        finish();
        return response;
      }
      const reader = response.body.getReader();
      const observeDone = /\btext\/event-stream\b/i.test(response.headers.get("content-type") ?? "")
        ? createSseDoneObserver()
        : undefined;
      let bodyAborted = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            bodyController = controller;
          },
          async pull(controller) {
            try {
              const event = await reader.read();
              if (bodyAborted) {
                return;
              }
              if (event.done) {
                controller.close();
                finish();
              } else {
                controller.enqueue(event.value);
                if (observeDone?.(event.value)) {
                  bodyAborted = true;
                  controller.close();
                  // Inference is complete even if HTTP cancellation never settles.
                  finish();
                  void reader.cancel("Sparky SSE completed").catch(() => undefined);
                }
              }
            } catch (error) {
              if (!bodyAborted) {
                controller.error(error);
                finish(true);
              }
            }
          },
          cancel(reason) {
            bodyAborted = true;
            finish();
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      const onAbort = () => {
        bodyAborted = true;
        bodyController.error(abortReason(callerSignal));
        finish(true);
        void reader.cancel(callerSignal?.reason).catch(() => undefined);
      };
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      detach = () => callerSignal?.removeEventListener("abort", onAbort);
      if (callerSignal?.aborted) {
        onAbort();
      }
      return new Response(body, response);
    } catch (error) {
      finish(true);
      throw error;
    }
  };
}
