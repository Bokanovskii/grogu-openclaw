import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "../../packages/ai/src/transports/openai-completions.test-support.js";
import { onAgentEventForRun } from "../infra/agent-events.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";

afterEach(() => vi.useRealTimers());

const joinedHtml = (drafts: (Record<string, unknown> | undefined)[]) =>
  drafts.map((draft) => (typeof draft?.html === "string" ? draft.html : "")).join("");

it("shows widget progress before an OpenAI completions call ends and flushes its last HTML piece", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const context = createMessageUpdateContext();
  const events: Record<string, unknown>[] = [];
  const off = onAgentEventForRun(context.params.runId, (event) => {
    if (event.stream === "tool" && event.data.phase === "input_delta") {
      events.push(event.data);
    }
  });
  const model = makeCompletionsModel({ provider: "compatible-proxy" });
  const output = createAssistantOutput(model);
  const chunks = [
    '{"title":"Build times","widget_code":"<h2>',
    "Builds</h2>\\n<div",
    '>Fast</div>"}',
  ];
  try {
    await processCompletionsStream(
      (async function* () {
        yield makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "widget-1",
              type: "function",
              function: { name: "show_widget", arguments: chunks[0] },
            },
          ],
        });
        expect(events[0]).toMatchObject({ name: "show_widget", toolCallId: "widget-1" });
        vi.advanceTimersByTime(100);
        expect(events.some((event) => JSON.stringify(event).includes("<h2>"))).toBe(true);
        // The transport's cooperative scheduler also uses setTimeout. Resume it
        // on the real clock after testing the projector's one batching deadline.
        vi.useRealTimers();
        yield makeCompletionsChunk({
          tool_calls: [{ index: 0, function: { arguments: chunks[1] } }],
        });
        yield makeCompletionsChunk(
          { tool_calls: [{ index: 0, function: { arguments: chunks[2] } }] },
          "tool_calls",
        );
      })(),
      output,
      model,
      {
        push: (event) => {
          void updateMessage(context, {
            message: "partial" in event ? event.partial : output,
            assistantMessageEvent: event,
          });
        },
      },
    );
    const drafts = events.map((event) => asOptionalObjectRecord(event.widgetDraft));
    expect(joinedHtml(drafts)).toBe("<h2>Builds</h2>\n<div>Fast</div>");
    expect(drafts.at(-1)?.title).toBe("Build times");
  } finally {
    context.state.widgetDraftProjector?.clear();
    off();
  }
});

it.each(["partialJson", "partialArgs"])(
  "decodes split escapes and a late title without leaking draft HTML to channel callbacks (%s)",
  async (field) => {
    vi.useFakeTimers();
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const drafts: Record<string, unknown>[] = [];
    const off = onAgentEventForRun(context.params.runId, (event) => {
      const draft = asOptionalObjectRecord(event.data.widgetDraft);
      if (draft) {
        drafts.push(draft);
      }
    });
    const input = '{"widget_code":"<p>\\uD83D\\uDE80\\n\\"ready\\"</p>","title":"Launch"}';
    try {
      for (let length = 1; length <= input.length; length++) {
        await updateMessage(context, {
          message: { role: "assistant", content: [] },
          assistantMessageEvent: {
            type: "toolcall_delta",
            contentIndex: 0,
            partial: {
              content: [{ id: "escapes", name: "show_widget", [field]: input.slice(0, length) }],
            },
          },
        });
        vi.advanceTimersByTime(100);
      }
      await updateMessage(context, {
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "escapes" } },
      });
      expect(joinedHtml(drafts)).toBe('<p>🚀\n"ready"</p>');
      expect(drafts.at(-1)?.title).toBe("Launch");
      expect(onAgentEvent).not.toHaveBeenCalled();
      const count = drafts.length;
      vi.runAllTimers();
      expect(drafts).toHaveLength(count);
    } finally {
      context.state.widgetDraftProjector?.clear();
      off();
    }
  },
);

it.each([
  {
    name: "oversized arguments",
    raw: `{"widget_code":"${"x".repeat(1_100_000)}`,
    unavailable: "limit",
  },
  { name: "non-HTML widgets", raw: '{"kind":"report","report":{}', unavailable: "unsupported" },
])("keeps status and size without preview bytes for $name", async ({ raw, unavailable }) => {
  vi.useFakeTimers();
  const context = createMessageUpdateContext();
  const drafts: Record<string, unknown>[] = [];
  const off = onAgentEventForRun(context.params.runId, (event) => {
    const draft = asOptionalObjectRecord(event.data.widgetDraft);
    if (draft) {
      drafts.push(draft);
    }
  });
  const update = (name: string, partialArgs: string) =>
    updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        partial: { content: [{ id: "limited", name, partialArgs }] },
      },
    });
  try {
    await update("other_tool", raw);
    vi.advanceTimersByTime(100);
    expect(drafts).toEqual([]);
    await update("show_widget", raw);
    vi.advanceTimersByTime(100);
    expect(drafts.at(-1)).toMatchObject({ unavailable, receivedChars: raw.length });
    await update("show_widget", `${raw} `);
    vi.advanceTimersByTime(100);
    expect(drafts.at(-1)).toMatchObject({ unavailable, receivedChars: raw.length + 1 });
    expect(joinedHtml(drafts)).toBe("");
  } finally {
    context.state.widgetDraftProjector?.clear();
    off();
  }
});
