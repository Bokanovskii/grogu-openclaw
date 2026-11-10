import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { NESTED_TOOL_ACTIVITY_CUSTOM_TYPE } from "../../sessions/nested-tool-activity.js";
import { extractAssistantTextForPhase } from "../../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
import { isToolResultBlockType } from "../../shared/tool-block-contract.js";
import { sanitizeUserFacingText } from "../embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../embedded-agent-helpers/user-facing-text.js";

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.flatMap((msg) => {
    const record = asOptionalRecord(msg);
    if (!record) {
      return [msg];
    }
    const { role, customType } = record;
    if (
      role === "tool" ||
      role === "function" ||
      isToolResultBlockType(role) ||
      isToolResultBlockType(record.type) ||
      (role === "custom" && customType === NESTED_TOOL_ACTIVITY_CUSTOM_TYPE)
    ) {
      return [];
    }
    if (!Array.isArray(record.content)) {
      return [msg];
    }
    const originalContent = record.content;
    const content = stripToolMessages(originalContent);
    if (
      content.length === originalContent.length &&
      content.every((block, i) => block === originalContent[i])
    ) {
      return [msg];
    }
    return content.length > 0 || (typeof record.text === "string" && record.text.length > 0)
      ? [{ ...record, content }]
      : [];
  });
}

function sanitizeTextContent(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "history");
}

export function extractStoredAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const joined =
    extractAssistantTextForPhase(message, {
      phase: "final_answer",
      sanitizeText: sanitizeTextContent,
      joinWith: "",
    }) ??
    extractAssistantTextForPhase(message, {
      sanitizeText: sanitizeTextContent,
      joinWith: "",
    });
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined
    ? errorContext
      ? renderUserFacingText(joined, { errorContext: true })
      : sanitizeUserFacingText(joined)
    : undefined;
}
