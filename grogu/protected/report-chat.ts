import { createHash } from "node:crypto";
import type { ProtectedChat } from "@openclaw/gateway-protocol/protected";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { redactToolPayloadText } from "../../src/logging/redact.js";
import type { ProtectedReportChatReference } from "../../src/state/protected-feedback.js";
import { ProtectedError } from "./errors.js";

type Item = { id: string; at: number | null; reported: boolean } & (
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      model: string | null;
      provider: string | null;
      responseId: string | null;
      status: "complete" | "failed" | "stopped" | null;
    }
  | {
      kind: "tool";
      name: string;
      input: string;
      output: string | null;
      status: "ok" | "error" | null;
      truncated: boolean;
    }
  | { kind: "compaction"; summary: string; replacedCount: number | null }
  | {
      kind: "file";
      fileId: string;
      name: string;
      size: number;
      origin: "produced";
      mediaType: null;
      readable: false;
    }
  | { kind: "notice"; text: string }
);

function digest(events: readonly unknown[]) {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(JSON.stringify(event));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function captureProtectedReportChatReference(
  events: readonly unknown[],
  files: ProtectedReportChatReference["files"],
  capturedAt: number,
  title: string,
): ProtectedReportChatReference {
  return { title, eventCount: events.length, digest: digest(events), files, capturedAt };
}

export function projectProtectedReportChat(input: {
  events: readonly unknown[];
  chat: ProtectedChat;
  reference: ProtectedReportChatReference;
  responseId: string;
  reportedFileIds: readonly string[];
  cursor?: string;
}) {
  const { reference } = input;
  const events = input.events.slice(0, reference.eventCount);
  if (events.length !== reference.eventCount || digest(events) !== reference.digest) {
    return { state: "unavailable" as const, reason: "not_retained" as const };
  }
  const cursorScope = digest([reference, input.responseId]);
  let offset = 0;
  if (input.cursor !== undefined) {
    const match = /^([a-f0-9]{64}):([1-9][0-9]{0,8})$/u.exec(input.cursor);
    if (!match || match[1] !== cursorScope) {
      throw new ProtectedError(400, "invalid_request", "The report page is invalid.");
    }
    offset = Number(match[2]);
  }
  let redacted = false;
  let truncated = false;
  let privateBlocks = 0;
  const redact = (text: string) => {
    const result = redactToolPayloadText(text);
    redacted ||= result !== text;
    return result;
  };
  const stripPrivateReasoning = (value: unknown, depth = 0): unknown => {
    if (depth > 256) {
      throw new ProtectedError(
        422,
        "invalid_evidence",
        "The report evidence is too deeply nested.",
      );
    }
    if (typeof value === "string") {
      const record = safeParseJson(value);
      if (!isRecord(record) && !Array.isArray(record)) {
        return value;
      }
      const previous = privateBlocks;
      const result = stripPrivateReasoning(record, depth + 1);
      return privateBlocks !== previous ? JSON.stringify(result ?? null) : value;
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const result = stripPrivateReasoning(item, depth + 1);
        return result === undefined ? [] : [result];
      });
    }
    if (isRecord(value)) {
      if (
        value.type === "thinking" ||
        value.type === "reasoning" ||
        value.type === "redacted_thinking"
      ) {
        truncated = true;
        privateBlocks++;
        return undefined;
      }
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          if (
            key === "thinkingSignature" ||
            key === "thoughtSignature" ||
            key === "thought_signature" ||
            key === "textSignature" ||
            key === "encryptedContent" ||
            key === "encrypted_content" ||
            key === "thinking" ||
            key === "reasoning" ||
            key === "reasoning_content"
          ) {
            truncated = true;
            privateBlocks++;
            return [];
          }
          const result = stripPrivateReasoning(item, depth + 1);
          return result === undefined ? [] : [[key, result]];
        }),
      );
    }
    return value;
  };
  const contentText = (content: unknown) => {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n");
  };
  const timestamp = (event: Record<string, unknown>, message?: Record<string, unknown>) => {
    const value =
      typeof event.timestamp === "string" ? Date.parse(event.timestamp) : message?.timestamp;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const responseIndex = events.findIndex(
    (event) => isRecord(event) && event.id === input.responseId,
  );
  let promptIndex = -1;
  for (let index = responseIndex - 1; index >= 0; index--) {
    const event = events[index];
    if (isRecord(event) && isRecord(event.message) && event.message.role === "user") {
      promptIndex = index;
      break;
    }
  }
  const visibleMessages = new Map(input.chat.messages.map((message) => [message.id, message]));
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const [index, value] of events.entries()) {
    if (!isRecord(value)) {
      truncated = true;
      items.push({
        kind: "notice",
        id: `event:${index}`,
        at: null,
        reported: false,
        text: "An unsupported transcript entry is not displayed.",
      });
      continue;
    }
    const id = typeof value.id === "string" ? value.id : `event:${index}`;
    const base = {
      id,
      at: timestamp(value),
      reported: index === responseIndex || index === promptIndex,
    };
    if (value.type === "compaction" && typeof value.summary === "string") {
      items.push({
        ...base,
        kind: "compaction",
        summary: redact(value.summary),
        replacedCount: null,
      });
      continue;
    }
    if (!isRecord(value.message)) {
      if (value.type !== "session") {
        items.push({
          ...base,
          kind: "notice",
          text: "A transcript metadata entry has no conversation content.",
        });
      }
      continue;
    }
    const message = value.message;
    base.at = timestamp(value, message);
    if (message.role === "toolResult") {
      const tool =
        typeof message.toolCallId === "string" ? tools.get(message.toolCallId) : undefined;
      const previous = privateBlocks;
      const output = redact(
        JSON.stringify({
          text: stripPrivateReasoning(contentText(message.content)),
          ...(message.details !== undefined
            ? { details: stripPrivateReasoning(message.details) }
            : {}),
        }),
      );
      const omittedContent =
        privateBlocks !== previous ||
        (Array.isArray(message.content) &&
          message.content.some((block) => !isRecord(block) || block.type !== "text"));
      truncated ||= omittedContent;
      if (tool) {
        tool.output = output;
        tool.status = message.isError === true ? "error" : "ok";
        tool.truncated ||= omittedContent;
      } else {
        items.push({
          ...base,
          kind: "tool",
          name: typeof message.toolName === "string" ? redact(message.toolName) : "Unknown tool",
          input: "",
          output,
          status: message.isError === true ? "error" : "ok",
          truncated: true,
        });
        truncated = true;
      }
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      items.push({
        ...base,
        kind: "notice",
        text: "A non-conversation transcript entry is not displayed.",
      });
      truncated = true;
      continue;
    }
    const visible = visibleMessages.get(id);
    items.push({
      ...base,
      kind: "message",
      role: message.role,
      text: redact(visible?.text ?? contentText(message.content)),
      model: typeof message.model === "string" ? redact(message.model) : null,
      provider: typeof message.provider === "string" ? redact(message.provider) : null,
      responseId: message.role === "assistant" ? id : null,
      status: visible?.status === "interrupted" ? "stopped" : (visible?.status ?? null),
    });
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const [blockIndex, block] of message.content.entries()) {
        if (!isRecord(block) || block.type !== "toolCall") {
          continue;
        }
        const previous = privateBlocks;
        const argumentsText = redact(
          JSON.stringify(stripPrivateReasoning(block.arguments ?? null) ?? null),
        );
        const tool: Extract<Item, { kind: "tool" }> = {
          ...base,
          id: `${id}:tool:${blockIndex}`,
          kind: "tool",
          name: typeof block.name === "string" ? redact(block.name) : "Unknown tool",
          input: argumentsText,
          output: null,
          status: null,
          truncated: privateBlocks !== previous,
        };
        items.push(tool);
        if (typeof block.id === "string") {
          tools.set(block.id, tool);
        }
      }
    }
  }
  for (const file of reference.files) {
    items.push({
      kind: "file",
      id: `file:${file.id}`,
      at: null,
      reported: input.reportedFileIds.includes(file.id),
      fileId: redact(file.id),
      name: redact(file.name),
      size: file.size,
      origin: file.origin,
      mediaType: null,
      readable: false,
    });
  }
  if (offset > items.length) {
    throw new ProtectedError(400, "invalid_request", "The report page is invalid.");
  }
  const end = Math.min(offset + 128, items.length);
  return {
    state: "available" as const,
    title: redact(reference.title),
    capturedAt: reference.capturedAt,
    truncated,
    redacted,
    redactions: null,
    items: items.slice(offset, end),
    nextCursor: end < items.length ? `${cursorScope}:${end}` : null,
  };
}
