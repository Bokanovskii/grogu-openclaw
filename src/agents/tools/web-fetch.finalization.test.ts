import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.wrapper.js";
import { createEmbeddedRunContextRecoveryState } from "../embedded-agent-runner/run/context-recovery-state.js";
import { prepareEmbeddedRunTerminal } from "../embedded-agent-runner/run/terminal-preparation.js";
import { createUsageAccumulator } from "../embedded-agent-runner/usage-accumulator.js";
import { createSubscribedSessionHarness } from "../embedded-agent-subscribe.e2e-harness.js";
import { wrapToolDefinition } from "../sessions/tools/tool-definition-wrapper.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createWebFetchTool } from "./web-fetch.js";

const { guardedFetch, providerFallback } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  providerFallback: vi.fn().mockResolvedValue(null),
}));

// mock-isolation: Replace external network and provider discovery, not terminal decisions.
vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: guardedFetch,
}));
// mock-isolation: Keep provider credentials and bundled runtime discovery outside this fixture.
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: providerFallback,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("web_fetch source limitations at terminal delivery", () => {
  it.each([
    { failure: "certificate", expected: "certificate", completed: true },
    { failure: "403", expected: "403", completed: true },
    { failure: "429", expected: "429", completed: true },
    { failure: "transport", expected: "connection", completed: true },
    { failure: "extraction", expected: "extract readable content", completed: true },
    { failure: "certificate", expected: "certificate", completed: false },
  ])(
    "reports $failure without losing completed output (terminal tool: $completed)",
    async ({ failure, expected, completed }) => {
      const remoteError = new TypeError("fetch failed", {
        cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      });
      if (failure === "403" || failure === "429" || failure === "extraction") {
        guardedFetch.mockResolvedValueOnce({
          response: new Response("PRIVATE_REMOTE_BODY", {
            status: failure === "extraction" ? 200 : Number(failure),
            headers: { "content-type": "text/html" },
          }),
          finalUrl: "https://example.com/course",
          release: async () => {},
        });
      } else {
        guardedFetch.mockRejectedValueOnce(
          failure === "certificate" ? remoteError : new TypeError("fetch failed"),
        );
      }
      const fetchTool = createWebFetchTool({
        config: {
          tools: { web: { fetch: { cacheTtlMinutes: 0, readability: failure !== "extraction" } } },
        },
      });
      if (!fetchTool) {
        throw new Error("Expected enabled web_fetch");
      }
      const tool = wrapToolWithBeforeToolCallHook(fetchTool, undefined, {
        emitDiagnostics: false,
      });
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "fetch-final" });
      const model: Model = {
        id: "synthetic",
        name: "Synthetic",
        api: "openai-responses",
        provider: "test-provider",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 1_000,
      };
      let requests = 0;
      const agent = new Agent({
        initialState: {
          model,
          tools: toToolDefinitions([
            tool,
            {
              name: "show_widget",
              label: "Show Widget",
              description: "Present the completed comparison.",
              parameters: Type.Object({}),
              execute: async () => ({
                content: [{ type: "text", text: "Comparison available" }],
                details: { kind: "canvas", presentation: { target: "assistant_message" } },
                terminate: true,
              }),
            },
          ]).map((definition) => wrapToolDefinition(definition)),
        },
        streamFn: () => {
          const request = requests++;
          const reason = request === 0 || completed ? "toolUse" : "stop";
          const message = buildEmbeddedRunnerAssistant({
            stopReason: reason,
            content:
              request === 0
                ? [
                    {
                      type: "toolCall",
                      id: "fetch",
                      name: "web_fetch",
                      arguments: { url: "https://example.com/course?token=PRIVATE_QUERY" },
                    },
                  ]
                : completed
                  ? [{ type: "toolCall", id: "widget", name: "show_widget", arguments: {} }]
                  : [],
          });
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason, message });
          stream.end();
          return stream;
        },
      });
      const unsubscribe = agent.subscribe(emit);
      try {
        await agent.prompt("Compare the courses.");
        await subscription.waitForPendingEvents();
        const lastToolError = subscription.getLastToolError();
        const assistant = subscription.getCurrentAttemptAssistant();
        const attempt = makeEmbeddedRunnerAttempt({
          messagesSnapshot: agent.state.messages,
          assistantTexts: subscription.assistantTexts,
          toolMetas: subscription.toolMetas.map((entry) => {
            if (!entry.toolName) {
              throw new Error("Expected a named settled tool");
            }
            return { ...entry, toolName: entry.toolName };
          }),
          itemLifecycle: subscription.getItemLifecycle(),
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          lastAssistant: assistant,
          lastToolError,
        });
        const prepared = prepareEmbeddedRunTerminal({
          runParams: {
            admittedRunContext: createTestAdmittedRunContext("fetch-final"),
            sessionId: "fetch-final",
            runId: "fetch-final",
            workspaceDir: "/synthetic/workspace",
            prompt: "Compare the courses.",
            timeoutMs: 60_000,
          },
          attempt,
          currentAttemptCompletedAssistant: assistant,
          provider: "test-provider",
          model: "synthetic",
          activeErrorContext: { provider: "test-provider", model: "synthetic" },
          authProfileStore: { version: 1, profiles: {} },
          sessionIdUsed: "fetch-final",
          outerContextTokenMeta: {},
          usageAccumulator: createUsageAccumulator(),
          contextRecoveryState: createEmbeddedRunContextRecoveryState(),
          resolvedToolResultFormat: "markdown",
          terminalState: {
            outcome: { reason: "completed", status: "ok", stopReason: "toolUse" },
            signalOwnedInterruption: false,
          },
        });

        expect(prepared.payloads).toHaveLength(1);
        expect(prepared.payloads[0]?.text).toContain(expected);
        expect(prepared.payloads[0]?.isError === true).toBe(!completed);
        expect(prepared.payloads[0]?.text).toMatch(/another source|browser/);
        expect(JSON.stringify(prepared.payloads)).not.toContain("PRIVATE_");
        expect(attempt.lastToolError).toBe(lastToolError);
        expect(prepared.attemptToolSummary?.unresolvedError?.toolName).toBe("web_fetch");
        if (completed) {
          expect(prepared.payloads[0]?.text).toContain("completed results");
          expect(getReplyPayloadMetadata(prepared.payloads[0]!)).toMatchObject({
            hostNotice: true,
          });
        }
      } finally {
        unsubscribe();
        subscription.unsubscribe();
      }
    },
  );
});
