import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapWebContent } from "../../src/security/external-content.js";
import { projectToolResult } from "./tool-events.js";

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
