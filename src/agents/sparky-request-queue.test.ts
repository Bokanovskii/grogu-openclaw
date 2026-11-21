import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrySparkyAdmission } from "../../packages/ai/src/transports/sparky-policy.js";
import { createDeferred } from "../../test/helpers/promise.js";
import "../llm/ai-transport-host.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getQueueSize,
  isCommandLaneTaskMarkerCurrent,
  setCommandLaneConcurrency,
  type CommandLaneTaskMarker,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { createSparkyAdmission, queueSparkyFetch } from "./sparky-request-queue.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture({
  api: "openai-completions",
  id: "synthetic",
  provider: "sparky",
  baseUrl: "https://queue.example.invalid/v1",
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("provider-origin admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCommandQueueStateForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetCommandQueueStateForTest();
  });

  it("preserves AbortError classification for an explicit null abort reason", async () => {
    const controller = new AbortController();
    controller.abort(null);
    await expect(createSparkyAdmission().acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it.each([2, 4])(
    "lets automation fill all %i idle slots, then serves a waiting person at the next request boundary",
    async (maxActive) => {
      const pool = createSparkyAdmission({ maxActive });
      const automation = await Promise.all(
        Array.from({ length: maxActive }, (_, index) =>
          pool.acquire(undefined, index % 2 ? "utility" : "scheduled"),
        ),
      );
      expect(pool.activeCount).toBe(maxActive);
      const order: string[] = [];
      const nextAutomation = pool.acquire(undefined, "scheduled").then((release) => {
        order.push("automation");
        return release;
      });
      const person = pool.acquire(undefined, "interactive").then((release) => {
        order.push("person");
        return release;
      });
      await flush();
      expect(order).toEqual([]);
      automation[0]!();
      await flush();
      expect(order).toEqual(["person"]);
      automation[1]!();
      await flush();
      expect(order).toEqual(["person", "automation"]);
      (await person)();
      (await nextAutomation)();
      automation.slice(2).forEach((release) => release());
      expect(pool.activeCount).toBe(0);
    },
  );

  it.each([undefined, 4, 8])(
    "leaves scheduling to the provider unless the profile caps requests at %s",
    async (maxActive) => {
      const responses = Array.from({ length: 9 }, () => createDeferred<Response>());
      let calls = 0;
      const fetcher = vi.fn<typeof fetch>(() => responses[calls++]!.promise);
      const baseUrl = `https://profile-limit-${maxActive ?? "unset"}.example.invalid/v1`;
      const sparky = queueSparkyFetch({ ...model, baseUrl }, fetcher, { maxActive });
      const requests = responses.map(() => sparky(baseUrl));
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(fetcher).toHaveBeenCalledTimes(maxActive ?? 9);
      } finally {
        responses.forEach((response) => response.resolve(new Response(null)));
        await Promise.all(requests);
      }
      expect(fetcher).toHaveBeenCalledTimes(9);
    },
  );

  it("keeps humans FIFO ahead of aged backgrounds and never refuses them for a full queue", async () => {
    let now = 0;
    const pool = createSparkyAdmission({ maxActive: 2, now: () => now, maxWaiting: 4 });
    const releases = await Promise.all([
      pool.acquire(undefined, "scheduled"),
      pool.acquire(undefined, "interactive"),
    ]);
    const order: string[] = [];
    const scheduled = pool.acquire(undefined, "scheduled").then((release) => {
      order.push("scheduled");
      return release;
    });
    const utility = pool.acquire(undefined, "utility").then((release) => {
      order.push("utility");
      return release;
    });
    const interactive = ["first human", "second human"].map((name) =>
      pool.acquire(undefined, "interactive").then((release) => {
        order.push(name);
        return release;
      }),
    );
    await expect(pool.acquire()).rejects.toThrow(/full/);
    interactive.push(
      pool.acquire(undefined, "interactive").then((release) => {
        order.push("third human");
        return release;
      }),
    );
    expect(pool.waiting).toBe(5);
    now = 120_001;
    releases[0]!();
    await flush();
    expect(order).toEqual(["first human"]);
    const firstHuman = await interactive[0]!;
    firstHuman();
    const secondHuman = await interactive[1]!;
    expect(order).toEqual(["first human", "second human"]);
    secondHuman();
    const thirdHuman = await interactive[2]!;
    expect(order).toEqual(["first human", "second human", "third human"]);
    thirdHuman();
    const backgroundRelease = await scheduled;
    expect(order).toEqual(["first human", "second human", "third human", "scheduled"]);
    backgroundRelease();
    const utilityRelease = await utility;
    expect(order).toEqual(["first human", "second human", "third human", "scheduled", "utility"]);
    utilityRelease();
    releases[1]!();
    expect(pool.activeCount).toBe(0);
  });

  it("dispatches a non-Sparky provider while Sparky is waiting for its own slot", async () => {
    const pool = createSparkyAdmission({ maxActive: 1 });
    const release = await pool.acquire();
    const sparkyFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const sparky = queueSparkyFetch(model, sparkyFetch, { pool })("https://queue.example.invalid");
    const copilotFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    await queueSparkyFetch({ ...model, provider: "github-copilot" }, copilotFetch, { pool })(
      "https://queue.example.invalid",
    );
    expect(copilotFetch).toHaveBeenCalledOnce();
    expect(sparkyFetch).not.toHaveBeenCalled();
    expect(pool.activeCount).toBe(1);
    release();
    await sparky;
    expect(sparkyFetch).toHaveBeenCalledOnce();
    expect(pool.activeCount).toBe(0);
  });

  it("starts GHCP when every main slot is waiting for Sparky without releasing session ownership", async () => {
    setCommandLaneConcurrency("main", 2);
    const pool = createSparkyAdmission({ maxActive: 1 });
    const releaseProvider = await pool.acquire(undefined, "scheduled");
    const sparkyFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const sparky = queueSparkyFetch(model, sparkyFetch, { pool });
    const waiting = [
      createDeferred<CommandLaneTaskMarker>(),
      createDeferred<CommandLaneTaskMarker>(),
    ];
    const requests = waiting.map((started, index) =>
      enqueueCommandInLane(`session:sparky-${index}`, () =>
        enqueueCommandInLane(
          "main",
          async (marker) => {
            const response = sparky("https://queue.example.invalid");
            started.resolve(marker);
            return await response;
          },
          { allowCapacitySuspension: true },
        ),
      ),
    );
    const markers = await Promise.all(waiting.map((started) => started.promise));
    expect(getCommandLaneSnapshot("main")).toMatchObject({
      activeCount: 2,
      suspendedCount: 2,
      maxConcurrent: 2,
      blockedBy: null,
    });
    expect(markers.every(isCommandLaneTaskMarkerCurrent)).toBe(true);
    expect(getQueueSize("main")).toBe(2);
    const nextInSession = vi.fn(async () => {});
    const serialized = enqueueCommandInLane("session:sparky-0", nextInSession);
    const copilotFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    await enqueueCommandInLane("session:human", () =>
      enqueueCommandInLane(
        "main",
        () =>
          queueSparkyFetch({ ...model, provider: "github-copilot" }, copilotFetch, { pool })(
            "https://queue.example.invalid",
          ),
        { allowCapacitySuspension: true },
      ),
    );
    expect(copilotFetch).toHaveBeenCalledOnce();
    expect(sparkyFetch).not.toHaveBeenCalled();
    expect(nextInSession).not.toHaveBeenCalled();
    expect(getQueueSize("main")).toBe(2);
    releaseProvider();
    await Promise.all([...requests, serialized]);
    expect(sparkyFetch).toHaveBeenCalledTimes(2);
    expect(nextInSession).toHaveBeenCalledOnce();
    expect(pool.activeCount).toBe(0);
    expect(getQueueSize("main")).toBe(0);
  });

  it("starts GHCP during rejected-admission cooldown through the installed transport host", async () => {
    vi.stubEnv("GROGU_PROFILE_FILE", "/synthetic/profile.json");
    setCommandLaneConcurrency("main", 1);
    const waiting = createDeferred();
    const ready = createDeferred();
    const open = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("Concurrency limit reached"), {
          status: 429,
          headers: new Headers({ "retry-after": "15" }),
        }),
      )
      .mockResolvedValue("accepted");
    const sparky = enqueueCommandInLane(
      "main",
      () =>
        retrySparkyAdmission(model, open, {
          sleep: () => {
            waiting.resolve();
            return ready.promise;
          },
        }),
      { allowCapacitySuspension: true },
    );
    await waiting.promise;
    expect(getCommandLaneSnapshot("main")).toMatchObject({ activeCount: 1, suspendedCount: 1 });
    const copilotFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    await enqueueCommandInLane("main", () =>
      queueSparkyFetch(
        { ...model, provider: "github-copilot" },
        copilotFetch,
      )("https://queue.example.invalid"),
    );
    expect(copilotFetch).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    ready.resolve();
    await expect(sparky).resolves.toBe("accepted");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "releases provider admission on cancellation during reacquisition (root cancellation=%s)",
    async (cancelRoot) => {
      const pool = createSparkyAdmission({ maxActive: 1 });
      const releaseProvider = await pool.acquire();
      const signal = new AbortController();
      const waiting = createDeferred();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
      const request = enqueueCommandInLane(
        "main",
        async () => {
          const response = queueSparkyFetch(model, fetcher, { pool })(
            "https://queue.example.invalid",
            { signal: signal.signal },
          );
          waiting.resolve();
          return await response;
        },
        { allowCapacitySuspension: true, abortSignal: cancelRoot ? signal.signal : undefined },
      );
      const outcome = request.catch((error: unknown) => error);
      await waiting.promise;
      const running = createDeferred();
      const ready = createDeferred();
      const blocker = enqueueCommandInLane("main", async () => {
        running.resolve();
        await ready.promise;
      });
      await running.promise;
      releaseProvider();
      await vi.advanceTimersByTimeAsync(0);
      expect(getCommandLaneSnapshot("main").capacityWaitingCount).toBe(1);
      expect(pool.activeCount).toBe(1);
      signal.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(pool.activeCount).toBe(0);
      ready.resolve();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      await blocker;
    },
  );

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

  it("admits people to every free slot during a bounded non-interactive 429 cooldown", async () => {
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
    const secondInteractiveRelease = await pool.acquire(undefined, "interactive");
    expect(pool.activeByWorkClass).toEqual({ interactive: 2, utility: 0, scheduled: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    interactiveRelease();
    secondInteractiveRelease();
    resume!();
    await next;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("pauses every class after an interactive 429 and releases aborted streams once", async () => {
    const pool = createSparkyAdmission({ maxActive: 1 });
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
