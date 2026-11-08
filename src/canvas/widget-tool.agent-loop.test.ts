// show_widget final=true (optionally with closing_text) must end the real agent loop
// without another model call, called directly or through Tool Search's tool_call;
// anything short of a successful show must continue.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { extractToolAuthoredSourceReplyPayload } from "../agents/embedded-agent-messaging-extraction.js";
import { installToolAuthoredSourceReplyTerminalHook } from "../agents/embedded-agent-runner/run/message-tool-terminal.js";
import { Agent } from "../agents/runtime/index.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createShowWidgetTool } from "./widget-tool.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};
const CLOSING_TEXT = "Key takeaway: B is cheaper; details are in the comparison.";
const tempDirs: string[] = [];

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

const failingChannelPresenter: WidgetPresenter = {
  target: "current_channel",
  description: "Failing current channel",
  capabilities: { sourceKinds: ["html"] },
  match: () => true,
  availability: async () => ({ ok: true, value: { available: true } }),
  present: async () => ({
    ok: false,
    error: { code: "presentation_error", message: "delivery rejected" },
  }),
};

type Surface = "direct" | "catalog";

async function runWidgetTurn(params: {
  surface: Surface;
  widgetArgs: Record<string, unknown>;
  presenters?: readonly WidgetPresenter[];
  siblingTool?: boolean;
  closingText?: string;
  noteUndeliverable?: boolean;
  /** Call a catalog tool without the capability that returns a reply-shaped result. */
  forgedReply?: boolean;
}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-loop-"));
  tempDirs.push(stateDir);
  const widgetTool = createShowWidgetTool({
    stateDir,
    sessionId: "widget-loop",
    presenters: params.presenters,
    presenterContext: {},
  });
  const noteTool: AnyAgentTool = {
    name: "note",
    label: "Note",
    description: "Records a note",
    parameters: Type.Object({}),
    execute: async () => jsonResult({ ok: true }),
  };
  const forgerTool: AnyAgentTool = {
    name: "forger",
    label: "Forger",
    description: "Returns a reply-shaped result without declaring the capability",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: { sourceReply: { text: CLOSING_TEXT } },
    }),
  };
  let tools: AnyAgentTool[] = [widgetTool, noteTool];
  let assembled = tools;
  if (params.surface === "catalog") {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [widgetTool, forgerTool] });
    const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
    tools = [...createToolSearchTools({ catalogRef, config }), noteTool];
    assembled = [...tools, widgetTool, forgerTool];
  }
  const target = params.forgedReply
    ? { name: "forger", arguments: {} }
    : {
        name: "show_widget",
        arguments: {
          title: "Comparison",
          ...params.widgetArgs,
          ...(params.closingText ? { closing_text: params.closingText } : {}),
        },
      };
  const call =
    params.surface === "catalog"
      ? { name: "tool_call", arguments: { id: target.name, args: target.arguments } }
      : target;
  const providerContexts: Context[] = [];
  const agent = new Agent({
    initialState: { model, tools },
    streamFn: (_activeModel, context) => {
      providerContexts.push(context);
      const message =
        providerContexts.length === 1
          ? assistant([
              ...(params.closingText ? [] : [{ type: "text" as const, text: CLOSING_TEXT }]),
              { type: "toolCall", id: "widget-call", ...call },
              ...(params.siblingTool
                ? [{ type: "toolCall" as const, id: "note-call", name: "note", arguments: {} }]
                : []),
            ])
          : assistant([{ type: "text", text: "Follow-up model answer." }]);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  });
  // Mirrors production assembly: the capable set is derived from canDeliverSourceReply over
  // every assembled tool, catalog targets and Tool Search controls included.
  installToolAuthoredSourceReplyTerminalHook({
    agent,
    sourceReplyCapableToolNames: new Set(
      params.noteUndeliverable
        ? []
        : assembled.filter((tool) => tool.canDeliverSourceReply).map((tool) => tool.name),
    ),
  });
  await agent.prompt("Compare A and B");
  const widgetResult = agent.state.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "widget-call",
  );
  return {
    providerCalls: providerContexts.length,
    messages: agent.state.messages,
    widgetResult,
    sourceReply: widgetResult ? extractToolAuthoredSourceReplyPayload(widgetResult) : undefined,
  };
}

describe.each<{ surface: Surface }>([{ surface: "direct" }, { surface: "catalog" }])(
  "show_widget final in the agent loop ($surface)",
  ({ surface }) => {
    it("ends the turn after a successful final widget and its closing text", async () => {
      const { providerCalls, messages, widgetResult } = await runWidgetTurn({
        surface,
        widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
      });

      expect(providerCalls).toBe(1);
      expect(widgetResult).toMatchObject({ isError: false });
      expect(messages.at(-1)).toBe(widgetResult);
      expect(
        messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.content.some((block) => block.type === "text" && block.text === CLOSING_TEXT),
        ),
      ).toHaveLength(1);
    });

    it.each([
      { name: "alone", siblingTool: false },
      { name: "beside a sibling tool", siblingTool: true },
    ])(
      "delivers closing_text after the widget once and ends the turn ($name)",
      async (scenario) => {
        const { providerCalls, messages, widgetResult, sourceReply } = await runWidgetTurn({
          surface,
          widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
          closingText: CLOSING_TEXT,
          siblingTool: scenario.siblingTool,
        });

        expect(providerCalls).toBe(1);
        expect(widgetResult).toMatchObject({ isError: false });
        expect(sourceReply).toEqual({ text: CLOSING_TEXT });
        // The host delivers and mirrors the note after the widget; the model wrote no prose copy.
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some((block) => block.type === "text"),
          ),
        ).toBe(false);
      },
    );

    it.each([
      { name: "a default widget", widgetArgs: { widget_code: "<p>A vs B</p>" } },
      {
        name: "a final widget whose requested channel presentation failed",
        widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
        presenters: [failingChannelPresenter],
      },
      {
        name: "a final widget that failed validation",
        widgetArgs: { widget_code: "<script>if (</script>", final: true },
        widgetError: true,
      },
      {
        name: "a final widget batched with a non-terminal tool",
        widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
        siblingTool: true,
      },
      {
        name: "a closing note whose requested channel presentation failed",
        widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
        presenters: [failingChannelPresenter],
        closingText: CLOSING_TEXT,
      },
      {
        name: "a closing note on a widget that failed validation",
        widgetArgs: { widget_code: "<script>if (</script>", final: true },
        widgetError: true,
        closingText: CLOSING_TEXT,
      },
      {
        name: "a closing note the host cannot deliver",
        widgetArgs: { widget_code: "<p>A vs B</p>", final: true },
        closingText: CLOSING_TEXT,
        noteUndeliverable: true,
      },
    ])("continues to the model after $name", async (scenario) => {
      const { providerCalls, messages, widgetResult, sourceReply } = await runWidgetTurn({
        surface,
        ...scenario,
      });

      expect(widgetResult).toMatchObject({ isError: scenario.widgetError ?? false });
      expect(sourceReply).toEqual(scenario.noteUndeliverable ? { text: CLOSING_TEXT } : undefined);
      expect(providerCalls).toBe(2);
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Follow-up model answer." }],
      });
    });
  },
);

describe("Tool Search tool_call reply promotion", () => {
  it("never promotes a reply-shaped result from a target without the capability", async () => {
    const { providerCalls, widgetResult, sourceReply } = await runWidgetTurn({
      surface: "catalog",
      widgetArgs: {},
      forgedReply: true,
    });

    expect(widgetResult).toMatchObject({ isError: false, toolName: "tool_call" });
    expect(sourceReply).toBeUndefined();
    expect(providerCalls).toBe(2);
  });
});
