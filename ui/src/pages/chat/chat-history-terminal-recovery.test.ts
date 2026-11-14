// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { activeHistory, createState, emit, message } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";

function completedHistory(runId: string, receipt: "id" | "sequence" = "id"): ChatHistoryResult {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "The repair is complete." }],
        __openclaw: {
          ...(receipt === "id" ? { id: "assistant-final" } : { seq: 2 }),
          runId,
          runTerminal: true,
        },
      },
    ],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    },
  };
}

describe("chat history terminal recovery", () => {
  it.each(["id", "sequence"] as const)(
    "retires a run from its exact durable terminal %s when the session row omits lastRunId",
    async (receipt) => {
      const runId = "run-missed-terminal";
      const active = activeHistory(runId);
      const request = vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(completedHistory(runId, receipt));
      const state = createState(active);
      state.client = { request } as unknown as GatewayBrowserClient;

      await loadChatHistory(state);
      expect(state.chatRunId).toBe(runId);

      await loadChatHistory(state);

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
    },
  );

  it("does not retire a run from another run's durable terminal", async () => {
    const runId = "run-still-active-locally";
    const active = activeHistory(runId);
    const request = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(completedHistory("run-earlier"));
    const state = createState(active);
    state.client = { request } as unknown as GatewayBrowserClient;

    await loadChatHistory(state);
    await loadChatHistory(state);

    expect(state.chatRunId).toBe(runId);
  });

  it("replaces a keyed source-reply final with its delivery mirror row", async () => {
    const runId = "widget-run";
    const idempotencyKey = "chatcmpl-1:tool-source-reply:call-1";
    const user = message("user", "Make a widget", { id: "user", seq: 1, runId });
    const mirror = {
      ...message("assistant", "Widget is ready.", { id: "mirror", seq: 2, idempotencyKey }),
      model: "delivery-mirror",
    };
    const state = createState({ messages: [user, mirror] });
    state.chatMessages = [user];
    state.chatRunId = runId;

    emit(state, runId, {
      state: "final",
      message: message("assistant", "Widget is ready.", { runId, idempotencyKey }),
    });
    await loadChatHistory(state);

    expect(state.chatMessages.map(extractText)).toEqual(["Make a widget", "Widget is ready."]);
  });
});
