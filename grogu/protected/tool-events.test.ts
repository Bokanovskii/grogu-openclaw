import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapWebContent } from "../../src/security/external-content.js";
import { createToolTimer, projectToolResult } from "./tool-events.js";

void test("web search sources show the framed title, not the model safety frame", () => {
  const { sources } = projectToolResult("web_search", {
    results: [
      { title: wrapWebContent("OpenClaw  docs", "web_search"), url: "https://docs.openclaw.ai/" },
      { title: wrapWebContent("", "web_search"), url: "https://example.com/empty" },
      { title: "Plain title", url: "https://example.com/plain" },
    ],
  });
  assert.deepEqual(sources, [
    { url: "https://docs.openclaw.ai/", title: "OpenClaw docs" },
    { url: "https://example.com/empty", title: "example.com" },
    { url: "https://example.com/plain", title: "Plain title" },
  ]);
});

void test("tool timer reports each finished call once, under its kind", () => {
  let clock = 0;
  const finished: Array<[string, number]> = [];
  const observe = createToolTimer(
    (kind, durationMs) => finished.push([kind, durationMs]),
    () => clock,
  );
  observe({ phase: "start", name: "web_search", toolCallId: "a" });
  clock = 40;
  observe({ phase: "start", name: "web_fetch", toolCallId: "b" });
  clock = 100;
  observe({ phase: "update", name: "web_search", toolCallId: "a" });
  observe({ phase: "result", name: "web_search", toolCallId: "a" });
  clock = 130;
  // A failed call still took time, but a repeated or unmatched result and a call without an id do not count.
  observe({ phase: "result", name: "web_fetch", toolCallId: "b", isError: true });
  observe({ phase: "result", name: "web_fetch", toolCallId: "b" });
  observe({ phase: "result", name: "web_fetch", toolCallId: "never-started" });
  observe({ phase: "start", name: "web_fetch" });
  observe({ phase: "result", name: "web_fetch" });
  assert.deepEqual(finished, [
    ["search", 100],
    ["fetch", 90],
  ]);
});
