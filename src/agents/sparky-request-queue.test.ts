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
  it("keeps one of four lanes reserved for interactive work", async () => {
    const pool = createSparkyAdmission({ maxWaiting: 2 });
    const background = await Promise.all(
      Array.from({ length: 3 }, () => pool.acquire(undefined, "scheduled")),
    );
    let fourthBackgroundAdmitted = false;
    const fourthBackground = pool.acquire(undefined, "scheduled").then((release) => {
      fourthBackgroundAdmitted = true;
      return release;
    });
    await flush();
    expect(fourthBackgroundAdmitted).toBe(false);
    expect(pool.activeByWorkClass).toEqual({ interactive: 0, utility: 0, scheduled: 3 });
    expect(pool.telemetry).toMatchObject({
      queueInteractiveReserveAvailable: true,
      queueInteractiveReserveOccupied: false,
    });

    const interactive = await pool.acquire(undefined, "interactive");
    expect(pool.activeByWorkClass).toEqual({ interactive: 1, utility: 0, scheduled: 3 });
    expect(pool.telemetry).toMatchObject({
      queueInteractiveReserveAvailable: false,
      queueInteractiveReserveOccupied: true,
    });
    interactive();
    await flush();
    expect(fourthBackgroundAdmitted).toBe(false);

    background[0]!();
    const fourthRelease = await fourthBackground;
    fourthRelease();
    background.slice(1).forEach((release) => release());
    expect(pool.activeCount).toBe(0);
  });

  it("bounds waiting and ages scheduled work into a non-interactive lane", async () => {
    let now = 0;
    const pool = createSparkyAdmission({ now: () => now, maxWaiting: 2 });
    const releases = await Promise.all([
      pool.acquire(undefined, "scheduled"),
      pool.acquire(undefined, "scheduled"),
      pool.acquire(undefined, "scheduled"),
      pool.acquire(undefined, "interactive"),
    ]);
    const order: string[] = [];
    const scheduled = pool.acquire(undefined, "scheduled").then((release) => {
      order.push("scheduled");
      return release;
    });
    const interactive = pool.acquire(undefined, "interactive").then((release) => {
      order.push("interactive");
      return release;
    });
    await expect(pool.acquire()).rejects.toThrow(/full/);
    now = 120_001;
    releases[0]!();
    const backgroundRelease = await scheduled;
    expect(order).toEqual(["scheduled"]);
    backgroundRelease();
    const foregroundRelease = await interactive;
    expect(order).toEqual(["scheduled", "interactive"]);
    foregroundRelease();
    releases[3]!();
    releases.slice(1, 3).forEach((release) => release());
    expect(pool.activeCount).toBe(0);
  });

  it("rechecks deadline just before dispatch after a host pause", async () => {
    let now = 0;
    const pool = createSparkyAdmission({ maxActive: 1, interactiveReserve: 0 });
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
    const pool = createSparkyAdmission({ maxActive: 1, interactiveReserve: 0 });
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

  it("keeps the interactive reserve open during a bounded non-interactive 429 cooldown", async () => {
    const pool = createSparkyAdmission();
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
    const interactiveRelease = await pool.acquire(undefined, "interactive");
    expect(pool.telemetry).toMatchObject({
      queueInteractiveCooldownActive: false,
      queueNonInteractiveCooldownActive: true,
    });
    let secondInteractiveAdmitted = false;
    const secondInteractive = pool.acquire(undefined, "interactive").then((release) => {
      secondInteractiveAdmitted = true;
      return release;
    });
    interactiveRelease();
    await flush();
    expect(secondInteractiveAdmitted).toBe(true);
    const secondInteractiveRelease = await secondInteractive;
    secondInteractiveRelease();
    resume!();
    await next;
  });

  it("reopens the reserve after a preexisting interactive turn finishes during cooldown", async () => {
    const pool = createSparkyAdmission();
    const first = await pool.acquire(undefined, "interactive");
    let resume: (() => void) | undefined;
    const pause = pool.pauseFor(
      120_000,
      "non-interactive",
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    first();
    let nextAdmitted = false;
    const next = pool.acquire(undefined, "interactive").then((release) => {
      nextAdmitted = true;
      return release;
    });

    await flush();
    expect(nextAdmitted).toBe(true);
    const nextRelease = await next;
    nextRelease();
    resume!();
    await pause;
  });

  it("pauses every class after an interactive 429 and releases aborted streams once", async () => {
    const pool = createSparkyAdmission({ maxActive: 1, interactiveReserve: 0 });
    let resume: (() => void) | undefined;
    const pause = pool.pauseFor(
      120_000,
      "all",
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    let interactiveAdmitted = false;
    const waiting = pool.acquire(undefined, "interactive").then((release) => {
      interactiveAdmitted = true;
      return release;
    });
    await flush();
    expect(interactiveAdmitted).toBe(false);
    expect(pool.telemetry).toMatchObject({
      queueInteractiveCooldownActive: true,
      queueNonInteractiveCooldownActive: true,
    });
    resume!();
    await pause;
    const waitingRelease = await waiting;
    waitingRelease();

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
