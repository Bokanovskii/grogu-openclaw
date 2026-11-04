import assert from "node:assert/strict";
import test from "node:test";
import { groguDigestFormat, summarizeGroguDigest } from "./digest.mjs";

test("renders a deterministic bounded timeline and collapsed tool facts", async () => {
  const messages = [
    { role: "user", content: "2026-11-03T10:00Z Decision D-17: keep quoted id msg_abc." },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "sessions_search", input: { private: "omitted" } }],
    },
    { role: "tool", name: "sessions_search", isError: false, content: "large private result" },
    { role: "assistant", content: "I found the older decision and kept D-17." },
  ];

  const first = await summarizeGroguDigest({ messages });
  const second = await summarizeGroguDigest({ messages });

  assert.equal(first, second);
  assert.match(first, /^GROGU_CONTEXT_DIGEST\nformat=grogu-digest\/v1\n/);
  assert.match(first, /Decision D-17: keep quoted id msg_abc/);
  assert.match(first, /I found the older decision and kept D-17/);
  assert.match(first, /"sessions_search" called=1 ok=1 error=0 unknown=0/);
  assert.doesNotMatch(first, /large private result|private.*omitted/);
  assert.ok(Buffer.byteLength(first, "utf8") <= groguDigestFormat.maxBytes);
});

test("merges recognized summaries and bounds unrecognized legacy text", async () => {
  const previous = await summarizeGroguDigest({
    messages: [{ role: "user", content: "Earlier unresolved request R-1." }],
  });
  const merged = await summarizeGroguDigest({
    previousSummary: previous,
    messages: [{ role: "assistant", content: "Current final answer A-2." }],
  });
  assert.match(merged, /Earlier unresolved request R-1/);
  assert.match(merged, /Current final answer A-2/);
  assert.doesNotMatch(merged, /legacy-summary:/);

  const legacy = await summarizeGroguDigest({
    previousSummary: `legacy ${"x".repeat(10_000)}`,
    messages: [{ role: "user", content: "Newest owner request." }],
  });
  assert.match(legacy, /legacy-summary:/);
  assert.match(legacy, /…\[truncated\]/);
  assert.ok(Buffer.byteLength(legacy, "utf8") <= groguDigestFormat.maxBytes);
});

test("keeps the newest timeline entries when the digest budget is exceeded", async () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `entry-${index} ${"🙂".repeat(500)}`,
  }));
  const digest = await summarizeGroguDigest({ messages });

  assert.match(digest, /entry-39/);
  assert.match(digest, /timeline-omitted=/);
  assert.ok(Buffer.byteLength(digest, "utf8") <= groguDigestFormat.maxBytes);
});
