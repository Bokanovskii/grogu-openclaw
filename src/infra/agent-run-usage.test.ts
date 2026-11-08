import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAgentRunUsage,
  recordAgentRunOutputTokens,
  resetAgentRunUsageForTest,
} from "./agent-run-usage.js";

describe("agent run usage", () => {
  beforeEach(() => resetAgentRunUsageForTest());

  it("does not commit usage when run ownership rejects the event", () => {
    const rejected = recordAgentRunOutputTokens({
      runId: "stale-run",
      lifecycleGeneration: "old-generation",
      outputTokens: 12,
      emit: () => false,
    });
    expect(
      recordAgentRunOutputTokens({
        runId: "stale-run",
        lifecycleGeneration: "old-generation",
        outputTokens: 0,
        update: { type: "estimate", responseId: Symbol("stale-response"), outputTokens: 50 },
        emit: () => false,
      }),
    ).toBeUndefined();
    const accepted = recordAgentRunOutputTokens({
      runId: "stale-run",
      lifecycleGeneration: "old-generation",
      outputTokens: 3,
      emit: () => true,
    });

    expect(rejected).toBeUndefined();
    expect(accepted).toEqual({ outputTokens: 3 });
  });

  it("clears only the targeted lifecycle generation", () => {
    const record = (
      lifecycleGeneration: string,
      outputTokens: number,
      update?: Parameters<typeof recordAgentRunOutputTokens>[0]["update"],
    ) =>
      recordAgentRunOutputTokens({
        runId: "shared-run",
        lifecycleGeneration,
        outputTokens,
        update,
        emit: () => true,
      });

    expect(record("old-generation", 12)?.outputTokens).toBe(12);
    expect(record("new-generation", 7)?.outputTokens).toBe(7);
    record("old-generation", 0, {
      type: "estimate",
      responseId: Symbol("old-response"),
      outputTokens: 40,
    });
    record("new-generation", 0, {
      type: "estimate",
      responseId: Symbol("new-response"),
      outputTokens: 20,
    });

    clearAgentRunUsage("shared-run", "old-generation");

    expect(record("new-generation", 3)).toEqual({ outputTokens: 10, outputTokensEstimate: 30 });
    expect(record("old-generation", 2)).toEqual({ outputTokens: 2 });
  });

  it("reconciles a response without erasing other estimates", () => {
    const responseA = Symbol("response-a");
    const responseB = Symbol("response-b");
    const record = (
      outputTokens: number,
      update?: Parameters<typeof recordAgentRunOutputTokens>[0]["update"],
    ) =>
      recordAgentRunOutputTokens({
        runId: "overlapping-responses",
        lifecycleGeneration: "generation",
        outputTokens,
        update,
        emit: () => true,
      });
    record(0, { type: "estimate", responseId: responseA, outputTokens: 12 });
    expect(record(0, { type: "estimate", responseId: responseB, outputTokens: 8 })).toEqual({
      outputTokens: 0,
      outputTokensEstimate: 20,
      modelProgress: true,
    });
    expect(record(5, { type: "complete", responseId: responseB })).toEqual({
      outputTokens: 5,
      outputTokensEstimate: 17,
    });
    expect(record(3)).toEqual({ outputTokens: 8, outputTokensEstimate: 20 });
    expect(record(0, { type: "complete", responseId: responseA })).toEqual({ outputTokens: 8 });
  });
});
