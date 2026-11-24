import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { createProtectedTurnTiming, type ModelRequestFacts } from "./turn-timing.js";

function finishedRecord(
  t: TestContext,
  report: (timing: ReturnType<typeof createProtectedTurnTiming>) => void,
) {
  const lines: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => {
    lines.push(args[1]);
  });
  const timing = createProtectedTurnTiming(performance.now());
  report(timing);
  timing.finish("complete");
  return JSON.parse(String(lines[0])) as Record<string, unknown>;
}

const request = (facts: Partial<ModelRequestFacts>): ModelRequestFacts => ({
  wallDurationMs: null,
  timeToFirstOutputMs: null,
  timeToFirstTextMs: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  reasoningTokens: null,
  ...facts,
});

void test("model totals add up a turn's requests and omit what none of them measured", (t) => {
  const record = finishedRecord(t, (timing) => {
    timing.modelRequests([
      request({
        wallDurationMs: 900.4,
        timeToFirstOutputMs: 300,
        inputTokens: 1200,
        outputTokens: 80,
      }),
      request({ wallDurationMs: 600.4, inputTokens: 800, cacheReadTokens: 512 }),
    ]);
  });
  assert.equal(record.modelRequests, 2);
  assert.equal(record.modelWallMs, 1501);
  assert.equal(record.modelFirstOutputMs, 300);
  assert.equal(record.modelInputTokens, 2000);
  assert.equal(record.modelOutputTokens, 80);
  assert.equal(record.modelCacheReadTokens, 512);
  assert.equal("modelFirstTextMs" in record, false);
  assert.equal("modelReasoningTokens" in record, false);
});

void test("tool totals count finished calls and split out search and fetch time", (t) => {
  const record = finishedRecord(t, (timing) => {
    timing.tool("search", 120.4);
    timing.tool("search", 80);
    timing.tool("widget", 30);
  });
  assert.equal(record.toolCalls, 3);
  assert.equal(record.toolMs, 230);
  assert.equal(record.searchMs, 200);
  assert.equal("fetchMs" in record, false);
});

void test("a turn with no model request or tool call reports neither", (t) => {
  const record = finishedRecord(t, (timing) => {
    timing.modelRequests([]);
  });
  assert.deepEqual(
    Object.keys(record).filter((key) => /^(model|tool|search|fetch)/u.test(key)),
    [],
  );
});
