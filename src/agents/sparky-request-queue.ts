import { parseRetryAfterHeadersSeconds } from "@openclaw/ai/internal/retry-after";
import type { Model } from "../llm/types.js";
import { currentHttpRequestTelemetry } from "./model-request-telemetry.js";

type Priority = -1 | 0 | 1;
type AdmissionEntry = {
  signal?: AbortSignal;
  priority: Priority;
  queuedAt: number;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
};
const abortReason = (signal?: AbortSignal) =>
  signal?.reason ?? new DOMException("Sparky request cancelled", "AbortError");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function sparkyUtilityBounds(modelRef: string | undefined) {
  return modelRef?.startsWith("sparky/")
    ? { timeoutMs: 120_000, maxTokens: 1_024, thinkLevel: "off" as const }
    : { timeoutMs: 20_000, maxTokens: 240 };
}

export function createSparkyAdmission(
  options: {
    maxWaiting?: number;
    maxActive?: number;
    now?: () => number;
    agingMs?: number;
  } = {},
) {
  const { maxWaiting = 32, maxActive = 4, now = Date.now, agingMs = 120_000 } = options;
  let active = 0;
  let pauses = 0;
  let lastPriority: Priority = 0;
  const waiting: AdmissionEntry[] = [];
  function pump() {
    while (!pauses && active < maxActive && waiting.length) {
      const aged =
        lastPriority >= 0 ? waiting.findIndex((entry) => now() - entry.queuedAt >= agingMs) : -1;
      const index =
        aged >= 0
          ? aged
          : waiting.reduce(
              (best, entry, current) => (entry.priority > waiting[best]!.priority ? current : best),
              0,
            );
      const next = waiting.splice(index, 1)[0]!;
      next.detach();
      if (next.signal?.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      lastPriority = next.priority;
      active++;
      let released = false;
      next.resolve(() => {
        if (!released) {
          released = true;
          active--;
          pump();
        }
      });
    }
  }
  return {
    async pauseFor(ms: number, delay = sleep) {
      pauses++;
      try {
        await delay(ms);
      } finally {
        pauses--;
        pump();
      }
    },
    acquire(signal?: AbortSignal, priority: Priority = 0): Promise<() => void> {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (![-1, 0, 1].includes(priority)) {
        return Promise.reject(new RangeError("Invalid request queue priority"));
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
          priority,
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
    get waiting() {
      return waiting.length;
    },
    get queuedAhead() {
      return waiting.length + (active >= maxActive ? active : 0);
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
    const priority =
      telemetry?.record.workClass === "interactive"
        ? 1
        : telemetry?.record.workClass === "scheduled"
          ? -1
          : 0;
    telemetry?.queue(pool, waitMs, priority);
    let release: () => void;
    try {
      release = await pool.acquire(waitingSignal, priority);
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
    telemetry?.admitted();
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
        void pool.pauseFor(delayMs, options.sleep).catch(() => undefined);
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
