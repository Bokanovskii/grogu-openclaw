import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { ChatItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import {
  canvasPreviewsMatch,
  normalizeRoleForGrouping,
  readCanvasContentPreview,
} from "../../lib/chat/message-normalizer.ts";
import type { CanvasToolPreview } from "../../lib/chat/tool-cards.ts";
import { extractChatMessagePreview, hasRenderableNormalizedMessage } from "./chat-thread-items.ts";

type InlineWidgetCandidate = {
  kind: string;
  surface?: string;
  viewId?: string;
  mcpApp?: unknown;
};

export function isManagedInlineWidget<T extends InlineWidgetCandidate>(
  preview: T | null | undefined,
): preview is T & { kind: "canvas"; surface: "assistant_message"; viewId: string } {
  return (
    preview?.kind === "canvas" &&
    preview.surface === "assistant_message" &&
    !preview.mcpApp &&
    typeof preview.viewId === "string" &&
    preview.viewId.trim().length > 0
  );
}

function assistantRecord(message: unknown): Record<string, unknown> | null {
  const raw = asRecord(message);
  return raw && typeof raw.role === "string" && normalizeRoleForGrouping(raw.role) === "assistant"
    ? raw
    : null;
}

function cleanAssistantWidgets(
  message: unknown,
  keep: (preview: CanvasToolPreview) => boolean,
): unknown {
  const raw = assistantRecord(message);
  if (!raw) {
    return message;
  }
  const cleanText = (text: string) =>
    extractCanvasShortcodes(text, (preview) => !isManagedInlineWidget(preview) || keep(preview))
      .text;
  if (!Array.isArray(raw.content)) {
    const field =
      typeof raw.content === "string" ? "content" : typeof raw.text === "string" ? "text" : null;
    if (!field) {
      return message;
    }
    const original = raw[field];
    if (typeof original !== "string") {
      return message;
    }
    const text = cleanText(original);
    return text === original ? message : { ...raw, [field]: text };
  }
  let changed = false;
  const content = raw.content.flatMap((block: unknown) => {
    const record = asRecord(block);
    const preview = readCanvasContentPreview(block);
    if (preview && isManagedInlineWidget(preview) && !keep(preview)) {
      changed = true;
      return [];
    }
    if (record?.type === "text" && typeof record.text === "string") {
      const text = cleanText(record.text);
      if (text !== record.text) {
        changed = true;
        return [{ ...record, text }];
      }
    }
    return [block];
  });
  return changed ? { ...raw, content } : message;
}

export function prepareInlineWidgetInput<
  T extends {
    messages: unknown[];
    toolMessages: unknown[];
    stream: string | null;
    streamSegments: ChatStreamSegment[];
  },
>(input: T) {
  const receipts: CanvasToolPreview[] = [];
  for (const message of [...input.messages, ...input.toolMessages]) {
    const raw = asRecord(message);
    if (!raw || typeof raw.role !== "string" || normalizeRoleForGrouping(raw.role) !== "tool") {
      continue;
    }
    const preview = extractChatMessagePreview(message)?.preview;
    if (
      preview &&
      isManagedInlineWidget(preview) &&
      !receipts.some((owner) => canvasPreviewsMatch(owner, preview))
    ) {
      receipts.push(preview);
    }
  }
  const keep = (preview: CanvasToolPreview) =>
    !receipts.some((owner) => canvasPreviewsMatch(owner, preview));
  const cleanText = (text: string) =>
    extractCanvasShortcodes(text, (preview) => !isManagedInlineWidget(preview) || keep(preview))
      .text;
  return {
    ...input,
    messages: input.messages.map((message) => cleanAssistantWidgets(message, keep)),
    stream: input.stream === null ? null : cleanText(input.stream),
    streamSegments: input.streamSegments.map((segment) => {
      const text = cleanText(segment.text);
      return text === segment.text ? segment : { ...segment, text };
    }),
  };
}

export function deduplicateInlineWidgets(items: ChatItem[]): ChatItem[] {
  const seen: CanvasToolPreview[] = [];
  const claim = (preview: CanvasToolPreview) => {
    if (seen.some((owner) => canvasPreviewsMatch(owner, preview))) {
      return false;
    }
    seen.push(preview);
    return true;
  };
  return items.flatMap((item): ChatItem[] => {
    if (item.kind === "stream") {
      const text = extractCanvasShortcodes(
        item.text,
        (preview) => !isManagedInlineWidget(preview) || claim(preview),
      ).text;
      return text === item.text ? [item] : text.trim() ? [{ ...item, text }] : [];
    }
    if (item.kind !== "message") {
      return [item];
    }
    const message = cleanAssistantWidgets(item.message, claim);
    return message === item.message
      ? [item]
      : hasRenderableNormalizedMessage(message)
        ? [{ ...item, message }]
        : [];
  });
}

export function splitAssistantProse(items: ChatItem[]): ChatItem[] {
  return items.flatMap((item): ChatItem[] => {
    if (item.kind !== "message") {
      return [item];
    }
    const raw = assistantRecord(item.message);
    if (!raw || !Array.isArray(raw.content)) {
      return [item];
    }
    const isTool = (block: unknown) => {
      const type = asRecord(block)?.type;
      return isToolCallContentType(type) || isToolResultContentType(type);
    };
    if (
      !raw.content.some(isTool) ||
      !raw.content.some((block: unknown) => {
        const record = asRecord(block);
        return (
          ["text", "input_text", "output_text"].includes(String(record?.type)) &&
          typeof record?.text === "string" &&
          record.text.trim().length > 0
        );
      })
    ) {
      return [item];
    }
    const segments: { tool: boolean; content: unknown[] }[] = [];
    for (const block of raw.content) {
      const tool = isTool(block);
      const previous = segments.at(-1);
      if (previous?.tool === tool) {
        previous.content.push(block);
      } else {
        segments.push({ tool, content: [block] });
      }
    }
    return segments.map((segment, index) => ({
      ...item,
      key: `${item.key}:${segment.tool ? "tools" : "prose"}:${index}`,
      message: {
        ...raw,
        content: segment.content,
        ...(!segment.tool
          ? {
              toolCallId: undefined,
              tool_call_id: undefined,
              toolUseId: undefined,
              tool_use_id: undefined,
              toolName: undefined,
              tool_name: undefined,
            }
          : {}),
      },
    }));
  });
}
