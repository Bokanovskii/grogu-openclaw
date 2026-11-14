import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

async function run(params?: Record<string, unknown>, options?: { strictReasoningTags?: boolean }) {
  const model = { ...makeCompletionsModel({ id: "qwen", provider: "sparky" }), params };
  const output = createAssistantOutput(model);
  const events: CapturedStreamEvent[] = [];
  await processCompletionsStream(
    streamChunks([
      makeCompletionsChunk({ reasoning_content: "thinking" }),
      makeCompletionsChunk({ content: "Hello " }),
      makeCompletionsChunk({ content: "there.\n\n" }),
      makeCompletionsChunk({ content: "Done." }),
      makeCompletionsChunk({}, "stop"),
    ]),
    output,
    model,
    { push: (event) => events.push(event) },
    options,
  );
  return { output, events };
}

describe("structured reasoning streaming opt-in", () => {
  it.each([undefined, { structuredReasoningStreaming: true }])(
    "keeps answer fragments together across whitespace reasoning with params %j",
    async (params) => {
      const model = { ...makeCompletionsModel(), params };
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({ reasoning_content: "private reasoning" }),
          makeCompletionsChunk({ content: "\n\nNO" }),
          makeCompletionsChunk({ reasoning_content: "\n" }),
          makeCompletionsChunk({ content: "_REPLY" }),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        { push: (event) => events.push(event) },
      );
      expect(output.content.filter((part) => part.type === "text")).toEqual([
        { type: "text", text: "\n\nNO_REPLY" },
      ]);
      expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(1);
    },
  );

  it("streams visible answer text after structured reasoning without a terminal barrier", async () => {
    const { output, events } = await run({ structuredReasoningStreaming: true });
    expect(output.openclawDelivery?.textPhaseRequiresTerminal).toBeUndefined();
    expect(output.content.at(-1)).toMatchObject({ type: "text", text: "Hello there.\n\nDone." });
    expect(events.filter((event) => event.type === "text_delta").length).toBeGreaterThan(1);
  });

  it.each([
    ["without the opt-in", undefined, undefined],
    ["for strict callers", { structuredReasoningStreaming: true }, { strictReasoningTags: true }],
  ])("keeps the terminal barrier %s", async (_label, params, options) => {
    const { output } = await run(params, options);
    expect(output.openclawDelivery?.textPhaseRequiresTerminal).toBe(true);
  });
});
