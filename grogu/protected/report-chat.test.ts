import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProtectedChat } from "@openclaw/gateway-protocol/protected";
import { captureProtectedReportChatReference, projectProtectedReportChat } from "./report-chat.js";

const chat: ProtectedChat = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Renamed after reporting",
  version: "1",
  updatedAt: 1000,
  selectedAgentId: "research",
  messages: [{ id: "reply", role: "assistant", text: "Saved answer", status: "complete" }],
};

void test("full-chat pages retain tools and compaction without secrets or private reasoning", () => {
  const events = [
    { type: "session" },
    { type: "model_change", provider: "synthetic", modelId: "test" },
    { type: "thinking_level_change", thinkingLevel: "medium" },
    { id: "system-context", message: { role: "system", content: "System context" } },
    { id: "prompt", message: { role: "user", content: "Original question" } },
    {
      id: "tool-message",
      message: {
        role: "assistant",
        provider: "synthetic",
        model: "test",
        content: [
          { type: "thinking", thinking: "Never expose private model reasoning" },
          {
            type: "toolCall",
            id: "call",
            name: "sessions_history",
            arguments: {
              password: "synthetic-report-secret-123456",
              public: "Keep this argument",
              replay: { type: "reasoning", text: "Private replay body" },
            },
          },
        ],
      },
    },
    {
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "call",
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { type: "thinking", thinking: "Private serialized result" },
              { type: "text", text: "Visible child answer" },
            ]),
          },
        ],
        details: {
          thinkingSignature: "Private opaque replay",
          encrypted_content: "Private replay ciphertext",
          nested: [
            { type: "thinking", thinking: "Private structured result" },
            { type: "text", text: "Visible detail" },
          ],
        },
      },
    },
    { id: "compact", type: "compaction", summary: "Saved compaction summary" },
    {
      id: "reply",
      timestamp: "1970-01-01T00:00:01.000Z",
      message: { role: "assistant", content: "Saved answer", provider: "synthetic", model: "test" },
    },
    ...Array.from({ length: 140 }, (_, index) => ({
      id: `history-${index}`,
      message: { role: "user", content: `Earlier message ${index}` },
    })),
  ];
  const reference = captureProtectedReportChatReference(
    events,
    [{ id: "generated~chat~artifact.html", name: "artifact.html", size: 42, origin: "produced" }],
    1000,
    "Title at submission",
  );
  const input = {
    events: [...events, { id: "future", message: { role: "user", content: "Added later" } }],
    chat,
    reference,
    responseId: "reply",
    reportedFileIds: [],
  };
  const first = projectProtectedReportChat(input);
  assert.ok(first.state === "available");
  assert.equal(first.title, "Title at submission");
  assert.equal(first.capturedAt, 1000);
  assert.equal(first.items.length, 128);
  assert.ok(first.nextCursor);
  assert.equal(first.redacted, true);
  assert.equal(first.redactions, null);
  assert.equal(first.items.filter((item) => item.kind === "notice").length, 1);
  const tool = first.items.find((item) => item.kind === "tool");
  assert.ok(tool?.kind === "tool");
  assert.ok(tool.output !== null);
  assert.match(tool.input, /Keep this argument/u);
  assert.match(tool.output, /Visible child answer/u);
  assert.match(tool.output, /Visible detail/u);
  assert.equal(tool.status, "ok");
  assert.equal(tool.truncated, true);
  const reply = first.items.find((item) => item.id === "reply");
  assert.ok(reply?.kind === "message");
  assert.equal(reply.reported, true);
  assert.equal(reply.status, "complete");
  assert.equal(reply.at, 1000);
  assert.equal(first.items.find((item) => item.id === "prompt")?.reported, true);
  assert.ok(first.items.some((item) => item.kind === "compaction"));
  const second = projectProtectedReportChat({ ...input, cursor: first.nextCursor });
  assert.ok(second.state === "available");
  assert.equal(second.nextCursor, null);
  assert.ok(second.items.some((item) => item.kind === "file" && item.readable === false));
  assert.doesNotMatch(
    JSON.stringify([first, second]),
    /synthetic-report-secret-123456|Never expose private|Private replay body|Private serialized result|Private structured result|Private opaque replay|Private replay ciphertext|Added later/u,
  );
});

void test("full-chat references detect rewrites and reject another report's page cursor", () => {
  const events = Array.from({ length: 130 }, (_, index) => ({
    id: `message-${index}`,
    message: { role: "user", content: `Question ${index}` },
  }));
  const reference = captureProtectedReportChatReference(events, [], 1000, "Original");
  const input = { events, chat, reference, responseId: "reply", reportedFileIds: [] };
  const first = projectProtectedReportChat(input);
  assert.ok(first.state === "available" && first.nextCursor);
  const cursor = first.nextCursor;
  const changed = [
    { ...events[0], message: { role: "user", content: "Rewritten" } },
    ...events.slice(1),
  ];
  assert.deepEqual(projectProtectedReportChat({ ...input, events: changed }), {
    state: "unavailable",
    reason: "not_retained",
  });
  const otherReference = captureProtectedReportChatReference(changed, [], 1000, "Other");
  assert.throws(
    () =>
      projectProtectedReportChat({
        ...input,
        events: changed,
        reference: otherReference,
        cursor,
      }),
    { status: 400, code: "invalid_request" },
  );
});
