import type { Context, Model } from "@openclaw/llm-core";
import { parseRetryAfterErrorSeconds } from "../internal/retry-after.js";

function waitForAdmission(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Admission wait cancelled", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

function admissionRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status: unknown = Reflect.get(error, "status");
  const body: unknown = Reflect.get(error, "error");
  const message: unknown =
    body && typeof body === "object" ? Reflect.get(body, "message") : Reflect.get(error, "message");
  if (
    status !== 429 ||
    typeof message !== "string" ||
    !/concurrency limit|too many concurrent/i.test(message)
  ) {
    return false;
  }
  const headers: unknown = Reflect.get(error, "headers");
  if (headers instanceof Headers) {
    return headers.get("x-should-retry") !== "false";
  }
  return (
    !headers ||
    typeof headers !== "object" ||
    !Object.entries(headers).some(
      ([key, value]) => key.toLowerCase() === "x-should-retry" && value === "false",
    )
  );
}

/** Only a rejected admission may be replayed; accepted streams never enter this loop. */
export async function retrySparkyAdmission<T>(
  model: Pick<Model, "provider">,
  open: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  if (model.provider !== "sparky" || !process.env.GROGU_PROFILE_FILE) {
    return open();
  }
  const { signal, timeoutMs = 300_000, now = Date.now, sleep = waitForAdmission } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Invalid admission retry budget");
  }
  const deadline = now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await open();
    } catch (error) {
      if (!admissionRejected(error) || attempt >= 19) {
        throw error;
      }
      signal?.throwIfAborted();
      const delayMs = (parseRetryAfterErrorSeconds(error, now()) ?? 15) * 1_000;
      if (!Number.isFinite(delayMs) || delayMs >= deadline - now()) {
        throw error;
      }
      await sleep(delayMs, signal);
      signal?.throwIfAborted();
      if (now() >= deadline) {
        throw error;
      }
    }
  }
}

export class SparkyImageLimitError extends Error {
  readonly code = "invalid_request";
  constructor(count: number) {
    super(
      `Sparky accepts at most 2 images per request; this turn contains ${count}. Send at most two images together.`,
    );
    this.name = "SparkyImageLimitError";
  }
}

/** Project provider history without changing canonical transcript messages or parts. */
export function projectSparkyImageHistory(
  model: Pick<Model, "provider">,
  context: Context,
): Context {
  if (model.provider !== "sparky" || !process.env.GROGU_PROFILE_FILE) {
    return context;
  }
  const imageCount = (message: Context["messages"][number]) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image").length
      : 0;
  const total = context.messages.reduce((count, message) => count + imageCount(message), 0);
  if (total <= 2) {
    return context;
  }
  const currentStart = Math.max(
    0,
    context.messages.findLastIndex((message) => message.role === "user"),
  );
  const currentCount = context.messages
    .slice(currentStart)
    .reduce((count, message) => count + imageCount(message), 0);
  if (currentCount > 2) {
    throw new SparkyImageLimitError(currentCount);
  }
  let remaining = total - 2;
  const messages = context.messages.map((message, index) => {
    if (index >= currentStart || remaining === 0 || !Array.isArray(message.content)) {
      return message;
    }
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "image" || remaining === 0) {
        return part;
      }
      remaining--;
      changed = true;
      return {
        type: "text" as const,
        text: "[earlier image omitted from this request: Sparky accepts at most 2 images; reattach it if its pixels are needed]",
      };
    });
    return changed ? ({ ...message, content } as typeof message) : message;
  });
  return { ...context, messages };
}
