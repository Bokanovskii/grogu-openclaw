import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ChatMessageGetResult } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import { stripToolMessages } from "./chat-history-text.js";
import { ToolInputError } from "./common.js";

const TEXT_MAX_CHARS = 4000;
const CURSOR_MAX_CHARS = 4096;
export const SessionsHistoryTextCursorSchema = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: CURSOR_MAX_CHARS,
    description:
      'With messageId, use "start" to read complete visible text in bounded pages, then copy textPage.nextCursor unchanged. History pagination is ignored. Cursors do not grant access; changed text requires restarting.',
  }),
);
export const SessionsHistoryTextOutputSchema = Type.Object(
  {
    sessionKey: Type.String(),
    sessionId: Type.String(),
    messageId: Type.String(),
    textPage: Type.Object(
      {
        field: Type.String(),
        offset: Type.Integer(),
        text: Type.String(),
        totalChars: Type.Integer(),
        nextCursor: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    hasMore: Type.Boolean(),
    contentRedacted: Type.Boolean(),
    bytes: Type.Number(),
    sessionLinkRule: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const CursorSchema = Type.Object(
  {
    version: Type.Literal(1),
    agentId: Type.String({ minLength: 1 }),
    sessionKey: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    messageId: Type.String({ minLength: 1 }),
    hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    fieldIndex: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
type TextCursor = Static<typeof CursorSchema>;

export function sanitizeHistoryMessage(
  message: unknown,
  maxChars = TEXT_MAX_CHARS,
  onText?: (text: string, field: string) => void,
): { message: unknown; truncated: boolean; redacted: boolean } {
  const record = asOptionalRecord(message);
  if (!record) {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...record };
  let truncated = false;
  let redacted = false;
  const sanitizeText = (text: string, field: string) => {
    // Redact the entire field before either preview truncation or page slicing.
    const sanitized = redactToolPayloadText(text);
    redacted ||= sanitized !== text;
    onText?.(sanitized, field);
    if (sanitized.length <= maxChars) {
      return sanitized;
    }
    truncated = true;
    return `${truncateUtf16Safe(sanitized, maxChars)}\n…(truncated)…`;
  };
  for (const field of ["details", "usage", "cost"]) {
    if (field in entry) {
      delete entry[field];
      truncated = true;
    }
  }
  const sanitizeContent = (value: unknown, fieldPath: string): unknown => {
    if (typeof value === "string") {
      return sanitizeText(value, fieldPath);
    }
    if (!Array.isArray(value)) {
      return value;
    }
    return value.map((block: unknown, index: number) => {
      const blockRecord = asOptionalRecord(block);
      if (!blockRecord) {
        return block;
      }
      const content = { ...blockRecord };
      const blockPath = `${fieldPath}[${index}]`;
      const fields =
        content.type === "thinking" ? ["text", "thinking", "partialJson"] : ["text", "partialJson"];
      for (const field of fields) {
        if (typeof content[field] === "string") {
          content[field] = sanitizeText(content[field], `${blockPath}.${field}`);
        }
      }
      // Follow visible content only, never private replay, arguments or details.
      if ("content" in content) {
        content.content = sanitizeContent(content.content, `${blockPath}.content`);
      }
      return content;
    });
  };
  if ("content" in entry) {
    entry.content = sanitizeContent(entry.content, "content");
  }
  if (typeof entry.text === "string") {
    entry.text = sanitizeText(entry.text, "text");
  }
  return { message: entry, truncated, redacted };
}

function decodeTextCursor(value: string): TextCursor | undefined {
  if (value === "start") {
    return undefined;
  }
  const invalid = () => new ToolInputError('Invalid textCursor; restart with textCursor: "start".');
  if (value.length > CURSOR_MAX_CHARS || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw invalid();
  }
  if (!Value.Check(CursorSchema, decoded)) {
    throw invalid();
  }
  return decoded;
}

export function prepareSessionsHistoryTextRead(params: {
  textCursor: string;
  agentId: string;
  sessionKey: string;
  displayKey: string;
  messageId: string;
  sessionId?: string;
  includeTools: boolean;
  maxBytes: number;
  sessionLinkRule?: string;
}) {
  const cursor = decodeTextCursor(params.textCursor);
  if (
    cursor &&
    (cursor.agentId !== params.agentId ||
      cursor.sessionKey !== params.sessionKey ||
      cursor.messageId !== params.messageId ||
      (params.sessionId !== undefined && cursor.sessionId !== params.sessionId))
  ) {
    throw new ToolInputError(
      'textCursor belongs to another message or transcript; restart with textCursor: "start".',
    );
  }
  return {
    sessionId: cursor?.sessionId ?? params.sessionId,
    finish(response: ChatMessageGetResult, sessionId: string) {
      if (!response.ok || response.message === undefined) {
        return {
          status: "error" as const,
          error: `Message text unavailable (${response.unavailableReason ?? "not_found"}); refresh history or select another visible message.`,
        };
      }
      if (!params.includeTools && stripToolMessages([response.message]).length === 0) {
        throw new ToolInputError("Reading this tool message requires includeTools: true.");
      }
      const meta = asOptionalRecord(asOptionalRecord(response.message)?.["__openclaw"]);
      if (meta?.id !== params.messageId) {
        throw new Error("The selected message changed; refresh history before reading its text.");
      }
      if (meta.truncated === true && meta.reason === "display-cap") {
        return {
          status: "error" as const,
          error:
            "Message text exceeds the Gateway full-message display limit; select a smaller message or inspect it through the authorized transcript owner.",
        };
      }
      const fields: Array<{ field: string; text: string }> = [];
      const sanitized = sanitizeHistoryMessage(
        response.message,
        Number.POSITIVE_INFINITY,
        (text, field) => fields.push({ field, text }),
      );
      const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      if (cursor && (cursor.sessionId !== sessionId || cursor.hash !== hash)) {
        throw new ToolInputError(
          'Message text changed; discard prior pages and restart with textCursor: "start".',
        );
      }
      if (fields.length === 0) {
        return {
          status: "error" as const,
          error:
            "This message has no visible text fields; select another message or inspect its attachments.",
        };
      }
      const fieldIndex = cursor?.fieldIndex ?? 0;
      const offset = cursor?.offset ?? 0;
      const field = fields[fieldIndex];
      if (!field || offset > field.text.length) {
        throw new ToolInputError('Invalid textCursor position; restart with textCursor: "start".');
      }
      const remaining = sliceUtf16Safe(field.text, offset);
      if (remaining.length !== field.text.length - offset) {
        throw new ToolInputError(
          'Invalid textCursor Unicode boundary; restart with textCursor: "start".',
        );
      }
      const text = truncateUtf16Safe(remaining, TEXT_MAX_CHARS);
      const nextOffset = offset + text.length;
      const nextIndex = nextOffset === field.text.length ? fieldIndex + 1 : fieldIndex;
      const hasMore = nextIndex < fields.length;
      const nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              sessionId,
              messageId: params.messageId,
              hash,
              fieldIndex: nextIndex,
              offset: nextIndex === fieldIndex ? nextOffset : 0,
            } satisfies TextCursor),
          ).toString("base64url")
        : undefined;
      if (nextCursor && nextCursor.length > CURSOR_MAX_CHARS) {
        throw new Error(
          "Message identity exceeds the text continuation limit; select another message.",
        );
      }
      const payload = {
        sessionKey: params.displayKey,
        sessionId,
        messageId: params.messageId,
        textPage: {
          field: field.field,
          offset,
          text,
          totalChars: field.text.length,
          ...(nextCursor ? { nextCursor } : {}),
        },
        hasMore,
        contentRedacted: sanitized.redacted,
        ...(params.sessionLinkRule ? { sessionLinkRule: params.sessionLinkRule } : {}),
      };
      const result = { ...payload, bytes: jsonUtf8Bytes(payload) };
      if (jsonUtf8Bytes(result) > params.maxBytes) {
        throw new Error(
          "Text page metadata exceeds the history response budget; select another message.",
        );
      }
      return result;
    },
  };
}
