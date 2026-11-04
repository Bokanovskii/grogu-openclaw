import type { Context } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSparkyImageHistory, retrySparkyAdmission } from "./sparky-policy.js";

beforeEach(() => {
  vi.stubEnv("GROGU_PROFILE_FILE", "/synthetic/profile.json");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const rejected = (ms: number) =>
  Object.assign(new Error("Concurrency limit reached for this token owner"), {
    status: 429,
    headers: new Headers({ "retry-after-ms": String(ms) }),
  });

describe("Sparky rejected-admission retries", () => {
  it("preserves AbortError classification for a null admission-wait reason", async () => {
    const signal = new AbortController();
    const error = rejected(1);
    await expect(
      retrySparkyAdmission(
        { provider: "sparky" },
        vi.fn<() => Promise<never>>().mockRejectedValue(error),
        {
          signal: signal.signal,
          timeoutMs: 100,
          sleep: async () => {
            signal.abort(null);
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries only concurrency admission, within the original deadline and maximum attempts", async () => {
    let now = 0;
    const error = rejected(1);
    const open = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("accepted");
    expect(
      await retrySparkyAdmission({ provider: "sparky" }, open, {
        timeoutMs: 100,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).toBe("accepted");
    expect(open).toHaveBeenCalledTimes(2);
    const always = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    await expect(
      retrySparkyAdmission({ provider: "sparky" }, always, {
        timeoutMs: 100,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toBe(error);
    expect(always).toHaveBeenCalledTimes(20);
  });

  it("never shortens a long retry hint or retries after a host pause or caller abort", async () => {
    const error = rejected(100);
    const open = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    await expect(
      retrySparkyAdmission({ provider: "sparky" }, open, { timeoutMs: 50 }),
    ).rejects.toBe(error);
    let now = 0;
    const signal = new AbortController();
    await expect(
      retrySparkyAdmission({ provider: "sparky" }, open, {
        timeoutMs: 200,
        now: () => now,
        sleep: async () => {
          now = 201;
        },
      }),
    ).rejects.toBe(error);
    await expect(
      retrySparkyAdmission({ provider: "sparky" }, open, {
        signal: signal.signal,
        timeoutMs: 200,
        sleep: async () => {
          signal.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(open).toHaveBeenCalledTimes(3);
  });

  it.each([
    { provider: "other", error: rejected(1) },
    {
      provider: "sparky",
      error: Object.assign(rejected(1), { headers: new Headers({ "x-should-retry": "false" }) }),
    },
    {
      provider: "sparky",
      error: Object.assign(new Error("daily quota exhausted"), { status: 429 }),
    },
    { provider: "sparky", error: Object.assign(new Error("Concurrency limit"), { status: 500 }) },
  ])("preserves unrelated errors %#", async ({ provider, error }) => {
    const open = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    await expect(
      retrySparkyAdmission({ provider }, open, {
        sleep: async () => {
          throw new Error("must not sleep");
        },
      }),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("request-only image projection", () => {
  const image = { type: "image" as const, data: "synthetic", mimeType: "image/png" };
  it("keeps the newest two without mutating history and explicitly rejects an oversized current turn", () => {
    const context: Context = {
      messages: [
        { role: "user", timestamp: 1, content: [image, image, { type: "text", text: "old" }] },
        { role: "user", timestamp: 2, content: [image, { type: "text", text: "current" }] },
      ],
    };
    const original = JSON.stringify(context);
    const projected = projectSparkyImageHistory({ provider: "sparky" }, context);
    expect(JSON.stringify(context)).toBe(original);
    expect(projected.messages[1]).toBe(context.messages[1]);
    expect(projected.messages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("earlier image omitted"),
      }),
      image,
      { type: "text", text: "old" },
    ]);
    expect(() =>
      projectSparkyImageHistory(
        { provider: "sparky" },
        {
          messages: [{ role: "user", timestamp: 1, content: [image, image, image] }],
        },
      ),
    ).toThrow(/this turn contains 3/);
    vi.stubEnv("GROGU_PROFILE_FILE", undefined);
    expect(projectSparkyImageHistory({ provider: "sparky" }, context)).toBe(context);
  });
});
