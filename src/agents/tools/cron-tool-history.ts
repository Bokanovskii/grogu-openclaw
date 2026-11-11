import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  CronHistoryResultSchema,
  type CronHistoryResult,
} from "../../../packages/gateway-protocol/src/schema/cron.js";
import {
  ChatHistoryTextResultSchema,
  type ChatHistoryTextResult,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { MAX_AGENT_TOOL_HISTORY_BYTES } from "../../gateway/server-constants.js";
import { redactSecrets } from "../../logging/redact.js";
import { stripToolMessages } from "./chat-history-text.js";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";
import { sanitizeHistoryMessage } from "./sessions-history-text.js";

function decodeHistoryCursor(value: string, includeTools: boolean): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new ToolInputError("Invalid history cursor; copy nextCursor unchanged.");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    decoded[0] !== includeTools ||
    typeof decoded[1] !== "string" ||
    !decoded[1]
  ) {
    throw new ToolInputError("Invalid history cursor or includeTools changed; restart history.");
  }
  return decoded[1];
}

export async function readCronRunTranscript(params: {
  jobId: string;
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
  signal?: AbortSignal;
}) {
  const { input } = params;
  const runId = readToolStringParam(input, "runId");
  if (input.runId !== undefined && !runId) {
    throw new ToolInputError("runId must be a non-empty string");
  }
  const runAtMs = readNonNegativeIntegerParam(input, "runAtMs", { max: MAX_DATE_TIMESTAMP_MS });
  if (!runId && runAtMs === undefined) {
    throw new ToolInputError("history requires an exact runId or runAtMs from a run record");
  }
  if (input.offset !== undefined) {
    throw new ToolInputError("history uses cursor, not offset; copy nextCursor unchanged");
  }
  if (input.includeTools !== undefined && typeof input.includeTools !== "boolean") {
    throw new ToolInputError("includeTools must be a boolean");
  }
  const includeTools = input.includeTools === true;
  const cursor =
    input.cursor === undefined
      ? undefined
      : readToolStringParam(input, "cursor", { required: true, trim: false });
  if (cursor && cursor.length > 8192) {
    throw new ToolInputError("history cursor exceeds the 8192-character limit");
  }
  const messageId =
    input.messageId === undefined
      ? undefined
      : readToolStringParam(input, "messageId", { required: true });
  const textCursor =
    input.textCursor === undefined
      ? undefined
      : readToolStringParam(input, "textCursor", { required: true, trim: false });
  if ((messageId === undefined) !== (textCursor === undefined)) {
    throw new ToolInputError('history text requires messageId and textCursor; start with "start".');
  }
  if (textCursor && (cursor || input.limit !== undefined)) {
    throw new ToolInputError("history text cannot be combined with cursor or limit");
  }
  const limit = readPositiveIntegerParam(input, "limit", { max: 200 });
  const selection = {
    id: params.jobId,
    ...(runId ? { runId } : {}),
    ...(runAtMs !== undefined ? { runAtMs } : {}),
  };
  if (messageId && textCursor) {
    const result = await params.callGateway<ChatHistoryTextResult>(
      "cron.history",
      params.gatewayOpts,
      { ...selection, messageId, textCursor, includeTools },
      { requireAgentRuntimeIdentity: true, signal: params.signal },
    );
    if (!Value.Check(ChatHistoryTextResultSchema, result)) {
      throw new Error("Cannot safely read the recorded automation message.");
    }
    const { bytes: _bytes, ...messagePage } = result;
    const payload = { ...messagePage, messages: [], contentTruncated: result.hasMore };
    const details = { ...payload, bytes: Buffer.byteLength(JSON.stringify(payload)) };
    const text = JSON.stringify(details);
    if (Buffer.byteLength(text) > MAX_AGENT_TOOL_HISTORY_BYTES) {
      throw new Error("Automation text page exceeds the history response budget.");
    }
    return textResult(text, details);
  }
  const result = await params.callGateway<CronHistoryResult>(
    "cron.history",
    params.gatewayOpts,
    {
      ...selection,
      ...(cursor ? { cursor: decodeHistoryCursor(cursor, includeTools) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    { requireAgentRuntimeIdentity: true, signal: params.signal },
  );
  if (!Value.Check(CronHistoryResultSchema, result)) {
    throw new Error("Cannot safely read the recorded automation transcript.");
  }
  const selected = includeTools ? result.messages : stripToolMessages(result.messages);
  const sanitized = selected.map((message) => sanitizeHistoryMessage(message));
  const projection = {
    messages: sanitized.map((entry) => entry.message),
  };
  const redacted = redactSecrets(projection);
  const contentTruncated = sanitized.some(
    (entry) =>
      entry.truncated ||
      asOptionalRecord(asOptionalRecord(entry.message)?.["__openclaw"])?.truncated === true,
  );
  const contentRedacted =
    sanitized.some((entry) => entry.redacted) ||
    JSON.stringify(redacted) !== JSON.stringify(projection);
  const nextCursor = result.nextCursor
    ? Buffer.from(JSON.stringify([includeTools, result.nextCursor])).toString("base64url")
    : undefined;
  if (
    !Value.Check(CronHistoryResultSchema, {
      ...redacted,
      ...(nextCursor ? { nextCursor } : {}),
    })
  ) {
    throw new Error("Cannot safely format the automation transcript.");
  }
  const details = {
    ...redacted,
    ...(nextCursor ? { nextCursor } : {}),
    contentTruncated,
    contentRedacted,
  };
  const text = JSON.stringify(details);
  if (Buffer.byteLength(text) > MAX_AGENT_TOOL_HISTORY_BYTES) {
    throw new Error(
      "Automation transcript page is too large; reduce limit and retry the same cursor, or use an authorized transcript viewer.",
    );
  }
  return textResult(text, details);
}
