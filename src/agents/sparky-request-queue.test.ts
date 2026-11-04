import { describe, expect, it, vi } from "vitest";
import { createSparkyAdmission, queueSparkyFetch } from "./sparky-request-queue.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture({
  id: "synthetic",
  provider: "sparky",
  baseUrl: "https://queue.example.invalid/v1",
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("provider-origin admission", () => {
  it("preserves AbortError classification for an explicit null abort reason", async () => {
    const controller = new AbortController();
    controller.abort(null);
    await expect(createSparkyAdmission().acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("admits four active requests, bounds waiting, and honors priority with aging", async () => {
    let now = 0;
    const pool = createSparkyAdmission({ now: () => now, maxWaiting: 2 });
    const releases = await Promise.all(Array.from({ length: 4 }, () => pool.acquire()));
    const order: string[] = [];
    const scheduled = pool.acquire(undefined, -1).then((release) => {
      order.push("scheduled");
      return release;
    });
    const interactive = pool.acquire(undefined, 1).then((release) => {
      order.push("interactive");
      return release;
    });
    await expect(pool.acquire()).rejects.toThrow(/full/);
    releases[0]!();
    const foregroundRelease = await interactive;
    expect(order).toEqual(["interactive"]);
    now = 120_001;
    foregroundRelease();
    const backgroundRelease = await scheduled;
    expect(order).toEqual(["interactive", "scheduled"]);
    backgroundRelease();
    releases.slice(1).forEach((release) => release());
    expect(pool.activeCount).toBe(0);
  });

  it("rechecks deadline just before dispatch after a host pause", async () => {
    let now = 0;
    const pool = createSparkyAdmission({ maxActive: 1 });
    const release = await pool.acquire();
    const fetcher = vi.fn<typeof fetch>();
    const pending = queueSparkyFetch(model, fetcher, { pool, now: () => now, timeoutMs: 100 })(
      "https://queue.example.invalid",
    );
    now = 101;
    release();
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(pool.activeCount).toBe(0);
  });

  it("holds through headers and split SSE DONE, then releases before stuck HTTP cancellation", async () => {
    const pool = createSparkyAdmission({ maxActive: 1 });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const text of ['data: {"x":1}\n\n', "data: [DO", "NE]\n\n"]) {
              controller.enqueue(new TextEncoder().encode(text));
            }
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const response = await queueSparkyFetch(model, fetcher, { pool })(
      "https://queue.example.invalid",
    );
    expect(pool.activeCount).toBe(1);
    await expect(response.text()).resolves.toContain("[DONE]");
    expect(pool.activeCount).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares bounded 429 cooldown and releases caller-aborted streams before cleanup", async () => {
    const pool = createSparkyAdmission({ maxActive: 1 });
    let resume: (() => void) | undefined;
    const delay = vi.fn(
      (ms: number) =>
        new Promise<void>((resolve) => {
          expect(ms).toBe(120_000);
          resume = resolve;
        }),
    );
    const first = queueSparkyFetch(
      model,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "300" },
        }),
      ),
      { pool, sleep: delay },
    );
    await first("https://queue.example.invalid");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const next = queueSparkyFetch(model, fetcher, { pool })("https://queue.example.invalid");
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    resume!();
    await next;
    const caller = new AbortController();
    let cool: (() => void) | undefined;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = await queueSparkyFetch(
      model,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
      {
        pool,
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            expect(ms).toBe(1_500);
            cool = resolve;
          }),
      },
    )("https://queue.example.invalid", { signal: caller.signal });
    caller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    cool!();
    await flush();
    expect(pool.activeCount).toBe(0);
  });
});
