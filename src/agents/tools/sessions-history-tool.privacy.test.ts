import { describe, expect, it } from "vitest";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import {
  type CallGatewayRequest,
  readHistoryDetails,
} from "./sessions-history-tool.test-support.js";

function createHistoryTool(message: unknown) {
  return createSessionsHistoryTool({
    config: {},
    callGateway: async <T>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return { sessionId: "selected-session", messages: [message] } as T;
      }
      if (request.method === "chat.message.get") {
        return { ok: true, message } as T;
      }
      throw new Error(`Unexpected Gateway request: ${request.method}`);
    },
  });
}

describe("sessions_history visible text privacy", () => {
  it("preserves top-level visible text when every nested result is filtered", async () => {
    const tool = createHistoryTool({
      role: "assistant",
      text: "Visible parent text.",
      content: [{ type: "tool_result", content: "RESULT_HIDDEN" }],
      __openclaw: { id: "selected-message" },
    });
    const args = { sessionKey: "main", messageId: "selected-message" };
    const preview = await tool.execute("preview", args);
    expect(readHistoryDetails(preview).messages).toEqual([
      {
        role: "assistant",
        text: "Visible parent text.",
        content: [],
        __openclaw: { id: "selected-message" },
      },
    ]);
    expect((await tool.execute("text", { ...args, textCursor: "start" })).details).toMatchObject({
      textPage: { field: "text", text: "Visible parent text." },
      hasMore: false,
    });
  });

  it.each([false, true])(
    "keeps argument buffers private and gates nested results with includeTools=%s",
    async (includeTools) => {
      const tool = createHistoryTool({
        role: "assistant",
        content: [
          { type: "text", text: "Visible answer." },
          { type: "thinking", thinking: "Visible reasoning.", partialJson: "Visible partial." },
          {
            type: "toolCall",
            name: "inspect",
            arguments: { filter: "PRIVATE_ARGUMENT_OBJECT" },
            partialJson: '{"filter":"PRIVATE_ARGUMENT_BUFFER"}',
          },
          {
            type: "text",
            content: [
              { type: "text", text: "Visible nested text." },
              { type: "tool_result", content: "RESULT_STRING" },
              {
                type: "toolResult",
                content: [{ type: "text", text: "RESULT_BLOCK" }],
              },
            ],
          },
        ],
        __openclaw: { id: "selected-message" },
      });
      const args = { sessionKey: "main", messageId: "selected-message", includeTools };
      const preview = await tool.execute("preview", args);
      expect(JSON.stringify(preview.details)).not.toContain("PRIVATE_ARGUMENT_BUFFER");
      expect(JSON.stringify(preview.details).includes("RESULT_")).toBe(includeTools);

      const fields: Record<string, string> = {};
      let textCursor: string | undefined = "start";
      for (let index = 0; textCursor && index < 8; index++) {
        const result = await tool.execute(`visible-${index}`, { ...args, textCursor });
        const page = readHistoryDetails(result).textPage as {
          field: string;
          text: string;
          nextCursor?: string;
        };
        expect(JSON.stringify(result.details)).not.toContain("PRIVATE_ARGUMENT");
        fields[page.field] = (fields[page.field] ?? "") + page.text;
        textCursor = page.nextCursor;
      }
      expect(textCursor).toBeUndefined();
      expect(fields).toEqual({
        "content[0].text": "Visible answer.",
        "content[1].thinking": "Visible reasoning.",
        "content[1].partialJson": "Visible partial.",
        "content[3].content[0].text": "Visible nested text.",
        ...(includeTools
          ? {
              "content[3].content[1].content": "RESULT_STRING",
              "content[3].content[2].content[0].text": "RESULT_BLOCK",
            }
          : {}),
      });
    },
  );

  it.each(["tool_result", "tool_result_error", "function_call_output", "function"])(
    "requires includeTools for alternate result role %s in previews and text reads",
    async (role) => {
      const tool = createHistoryTool({
        role,
        content: [{ type: "text", text: "Explicit result." }],
        __openclaw: { id: "selected-message" },
      });
      const args = { sessionKey: "main", messageId: "selected-message" };
      expect(readHistoryDetails(await tool.execute("preview", args)).messages).toEqual([]);
      await expect(tool.execute("text", { ...args, textCursor: "start" })).rejects.toThrow(
        "includeTools: true",
      );
      expect(
        readHistoryDetails(await tool.execute("included-preview", { ...args, includeTools: true }))
          .messages,
      ).toHaveLength(1);
      expect(
        (await tool.execute("included-text", { ...args, includeTools: true, textCursor: "start" }))
          .details,
      ).toMatchObject({
        textPage: { field: "content[0].text", text: "Explicit result." },
        hasMore: false,
      });
    },
  );
});
