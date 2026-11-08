// A final show_widget with closing_text must reach Control UI as widget, then note, then done,
// through real tool assembly, source-reply capture, delivery, and transcript mirroring, both as a
// direct schema and through the Tool Search catalog's tool_call, with one model request.
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { startClaimedGateway } from "./test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const CLOSING_TEXT = "Plan B saves about 18% at this usage level.";
const PROSE_TEXT = "Here is the comparison you asked for.";
const FOLLOW_UP_TEXT = "UNEXPECTED_FOLLOW_UP_MODEL_CALL";

type HistoryMessage = { role?: string; toolName?: string; content?: unknown };

function widgetResponse(
  ordinal: number,
  toolName: string,
  args: Record<string, unknown>,
  prose?: string,
) {
  const call = {
    type: "function_call",
    id: `fc_widget_${ordinal}`,
    call_id: `call_widget_${ordinal}`,
    name: toolName,
    arguments: JSON.stringify(toolName === "tool_call" ? { id: "show_widget", args } : args),
    status: "completed",
  };
  const message = prose
    ? {
        type: "message",
        id: `msg_prose_${ordinal}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: prose, annotations: [] }],
      }
    : undefined;
  const output = message ? [message, call] : [call];
  return [
    ...output.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: `resp_widget_${ordinal}`,
        status: "completed",
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function textResponse(text: string, ordinal: number) {
  const message = {
    type: "message",
    id: `msg_text_${ordinal}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_text_${ordinal}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function texts(message: HistoryMessage): string[] {
  return Array.isArray(message.content)
    ? message.content.flatMap((block: { type?: string; text?: unknown }) =>
        block.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
    : typeof message.content === "string"
      ? [message.content]
      : [];
}

const WIDGET_CODE = "<h2>Plan A vs Plan B</h2><table><tr><td>A</td><td>B</td></tr></table>";

describe.each([
  { surface: "direct schemas", toolSearch: false, widgetTool: "show_widget" },
  { surface: "the Tool Search catalog", toolSearch: undefined, widgetTool: "tool_call" },
])("show_widget final through a real Gateway with $surface", ({ toolSearch, widgetTool }) => {
  let modelToolCalls = 0;
  const offeredTools: string[][] = [];
  let nextWidget: { args: Record<string, unknown>; prose?: string } | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        tools?: Array<{ name?: string }>;
      };
      offeredTools.push(body.tools?.map((tool) => tool.name ?? "") ?? []);
      const ordinal = modelToolCalls + 1;
      if (!body.tools?.length) {
        writeOpenAiResponsesSse(response, textResponse("Widget comparison", ordinal));
        return;
      }
      modelToolCalls += 1;
      const widget = nextWidget;
      nextWidget = undefined;
      writeOpenAiResponsesSse(
        response,
        widget
          ? widgetResponse(ordinal, widgetTool, widget.args, widget.prose)
          : textResponse(FOLLOW_UP_TEXT, ordinal),
      );
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
  let server: {
    close: (opts: { reason: string }) => Promise<void>;
    startupSettled: Promise<unknown>;
  };
  let client: Awaited<ReturnType<typeof connectGatewayClient>>;

  beforeAll(async () => {
    resetGatewayTestState();
    home = await setupGatewayTempHome({ prefix: "openclaw-widget-closing-note-" });
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "0");
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture provider did not bind");
    }
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
    const token = nextGatewayId("widget-closing-note-token");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: home.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
        entries: { main: {} },
      },
      tools: {
        allow: ["show_widget"],
        codeMode: { enabled: false },
        ...(toolSearch === false ? { toolSearch } : {}),
      },
      models: { mode: "replace", providers: { [model.providerId]: model.config } },
      gateway: { auth: { mode: "token", token } },
      hooks: { enabled: false },
    };
    const configPath = await createGatewayConfigPath(home.tempHome);
    await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const { port } = portClaim;
    server = await startClaimedGateway(portClaim, () =>
      startGatewayServer(port, { bind: "loopback", auth: { mode: "token", token } }),
    );
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      clientDisplayName: "widget-closing-note",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.INLINE_WIDGETS, GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    });
    await server.startupSettled;
  }, 90_000);

  afterAll(async () => {
    try {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await server?.close({ reason: "widget closing note proof complete" });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
      });
      resetGatewayTestState();
      if (home) {
        await removeGatewayTempHome(home.tempHome);
        home.envSnapshot.restore();
      }
    }
  });

  async function runTurn(sessionKey: string, widget: NonNullable<typeof nextWidget>) {
    nextWidget = widget;
    const before = modelToolCalls;
    const accepted = await client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey,
      message: "Compare plan A and plan B.",
      deliver: false,
      idempotencyKey: nextGatewayId("widget-closing-note-run"),
    });
    expect(accepted.status).toBe("started");
    const completed = await client.request<{ status: string }>(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(completed.status).toBe("ok");
    // Fixture guard: the real assembly must offer the widget on the surface under test.
    expect(offeredTools.findLast((names) => names.length > 0)).toContain(widgetTool);
    const history = await client.request<{ messages: HistoryMessage[] }>("chat.history", {
      sessionKey,
    });
    const proofDir = process.env.OPENCLAW_WIDGET_CLOSING_NOTE_PROOF_DIR?.trim();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await writeFile(
        path.join(proofDir, `${widgetTool}-${sessionKey.split(":").at(-1)}-history.json`),
        `${JSON.stringify(history.messages, null, 2)}\n`,
      );
    }
    return { modelCalls: modelToolCalls - before, messages: history.messages };
  }

  const widgetIndexIn = (messages: HistoryMessage[]) =>
    messages.findIndex(
      (message) => message.role === "toolResult" && message.toolName === widgetTool,
    );
  const assistantTextIndexes = (messages: HistoryMessage[], needle: string) =>
    messages.flatMap((message, index) =>
      message.role === "assistant" && texts(message).some((text) => text.includes(needle))
        ? [index]
        : [],
    );

  it("ends a final widget with its closing note after one model request", async () => {
    const { modelCalls, messages } = await runTurn("agent:main:closing-note", {
      args: {
        title: "Plan comparison",
        widget_code: WIDGET_CODE,
        final: true,
        closing_text: CLOSING_TEXT,
      },
    });
    const widgetIndex = widgetIndexIn(messages);

    expect(modelCalls).toBe(1);
    expect(widgetIndex).toBeGreaterThan(-1);
    expect(assistantTextIndexes(messages, CLOSING_TEXT)).toEqual([messages.length - 1]);
    expect(messages.length - 1).toBeGreaterThan(widgetIndex);
    expect(JSON.stringify(messages)).not.toContain(FOLLOW_UP_TEXT);
  }, 60_000);

  it("ends a note-less final widget and keeps earlier prose above it", async () => {
    const { modelCalls, messages } = await runTurn("agent:main:prose-before", {
      args: { title: "Plan comparison", widget_code: WIDGET_CODE, final: true },
      prose: PROSE_TEXT,
    });

    expect(modelCalls).toBe(1);
    const proseIndexes = assistantTextIndexes(messages, PROSE_TEXT);
    expect(proseIndexes).toHaveLength(1);
    expect(proseIndexes[0]).toBeLessThan(widgetIndexIn(messages));
    expect(JSON.stringify(messages)).not.toContain(FOLLOW_UP_TEXT);
  }, 60_000);
});
