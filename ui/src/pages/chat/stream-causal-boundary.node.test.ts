import { describe, expect, it } from "vitest";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import {
  replaceChatStream,
  replaceChatStreamFromHistorySnapshot,
} from "./stream-causal-boundary.ts";

describe("blank history status snapshots", () => {
  it("preserves unpersisted answer text and segments but allows an explicit terminal clear", () => {
    const segment: ChatStreamSegment = { text: "First answer part.", ts: 1, runId: "run" };
    const state = {
      chatRunId: "run",
      chatStream: "The final answer.",
      chatStreamSegments: [segment],
    };
    replaceChatStreamFromHistorySnapshot(state, "  ");
    expect(state.chatStream).toBe("The final answer.");
    expect(state.chatStreamSegments).toEqual([segment]);
    replaceChatStreamFromHistorySnapshot(state, null);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("protects pending text belonging to this run, not persisted or other-run segments", () => {
    const segment: ChatStreamSegment = { text: "Saved answer.", ts: 1, runId: "run" };
    for (const current of [
      segment,
      { ...segment, persisted: true },
      { ...segment, runId: "other" },
    ]) {
      const state = { chatRunId: "run", chatStream: null, chatStreamSegments: [current] };
      replaceChatStreamFromHistorySnapshot(state, "");
      expect(state.chatStream).toBe(current === segment ? null : "");
    }
  });

  it("still replaces heartbeat acknowledgments and accepts nonempty replacement answers", () => {
    const state = { chatRunId: "run", chatStream: "HEARTBEAT_OK", chatStreamSegments: [] };
    replaceChatStreamFromHistorySnapshot(state, "");
    expect(state.chatStream).toBe("");
    replaceChatStreamFromHistorySnapshot(state, "New answer.");
    expect(state.chatStream).toBe("New answer.");
  });

  it("leaves explicit gateway replacements authoritative, including hidden blank tails", () => {
    const segment: ChatStreamSegment = { text: "Draft part.", ts: 1, runId: "run" };
    const state = { chatRunId: "run", chatStream: "The token is ", chatStreamSegments: [segment] };
    replaceChatStream(state, "");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamSegments).toEqual([]);
  });
});
