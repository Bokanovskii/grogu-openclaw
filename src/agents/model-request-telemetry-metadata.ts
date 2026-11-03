import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const telemetryHash = (value: unknown) =>
  typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 24) : null;
export const telemetryCode = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_./:-]{1,160}$/.test(value) ? value : null;
export const telemetryUuid = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ? value
    : null;
export const telemetryIdentifier = (value: unknown) =>
  typeof value === "string" &&
  /^(?:chatcmpl-[a-zA-Z0-9_.-]{1,120}|resp_[a-zA-Z0-9_-]{1,120}|[a-f0-9-]{32,36})$/.test(value)
    ? value
    : null;
export const telemetryFinite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const telemetryCounter = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const telemetryRound = (value: number) => Math.round(value * 1_000) / 1_000;

const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "APIError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "FetchError",
  "ProviderHttpError",
]);
export const telemetryErrorCodes = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "invalid_request",
  "invalid_request_error",
  "upstream_error",
  "gateway_error",
  "server_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "context_length_exceeded",
  "model_not_found",
  "request_timeout",
]);

export function safeModelError(value: unknown, signal?: AbortSignal) {
  const error = isRecord(value) ? value : {};
  const cause = isRecord(error.cause) ? error.cause : {};
  const reason: unknown = signal?.reason;
  const reasonName = isRecord(reason) ? reason.name : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  const code = error.code ?? cause.code;
  const timeout =
    /timeout|timed out|deadline/i.test(message) ||
    error.name === "TimeoutError" ||
    reasonName === "TimeoutError";
  return {
    errorName:
      typeof error.name === "string" && errorNames.has(error.name) ? error.name : "OtherError",
    errorCode: typeof code === "string" && telemetryErrorCodes.has(code) ? code : null,
    errorCodeHash: telemetryHash(code),
    failureKind: timeout
      ? "timeout"
      : signal?.aborted || error.name === "AbortError"
        ? "cancelled"
        : typeof code === "string" &&
            /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(code)
          ? "network"
          : /stream.*(?:ended|incomplete)|without finish_reason/i.test(message)
            ? "incomplete_stream"
            : "error",
    callerSignalAborted: signal?.aborted === true,
    abortReasonName: signal?.aborted
      ? typeof reasonName === "string" && errorNames.has(reasonName)
        ? reasonName
        : "OtherError"
      : null,
  };
}

type MetadataValue = string | number | boolean | null;
export type ModelRequestRecord = Record<string, MetadataValue> & {
  version: number;
  id: string;
  kind: string;
  startedAtMs: number;
  updatedAtMs: number;
  terminal: boolean;
  phase: string;
  workClass: string;
  httpAttempts: number;
  responseBytes: number;
  outputDeltas: number;
  textDeltas: number;
  reasoningDeltas: number;
  toolDeltas: number;
  firstByteAtMs: number | null;
  firstOutputAtMs: number | null;
  firstTextAtMs: number | null;
  firstReasoningAtMs: number | null;
  firstToolAtMs: number | null;
  lastOutputAtMs: number | null;
  lastByteAtMs: number | null;
  maxByteGapMs: number;
  admittedAtMs: number | null;
  headersAtMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseId: string | null;
  httpStatus: number | null;
};

const numericFields = new Set(
  `version pid startedAtMs updatedAtMs finishedAtMs timeoutMs requestBytes responseBytes inputImageCount queueWaitMs queuedAhead queueTimeoutMs queuePriority admittedAtMs headersAtMs firstByteAtMs firstOutputAtMs firstTextAtMs firstReasoningAtMs firstToolAtMs lastOutputAtMs lastByteAtMs maxByteGapMs httpStatus outputDeltas textDeltas reasoningDeltas toolDeltas inputTokens outputTokens cacheReadTokens cacheWriteTokens reasoningTokens httpAttempts wallDurationMs monotonicDurationMs timeToHeadersMs timeToFirstByteMs timeToFirstOutputMs timeToFirstTextMs timeToFirstReasoningMs idleAtEndMs outputTokensPerSecond hostGapCount maxHostSchedulingGapMs unparsedWireEvents wallElapsedMs monotonicElapsedMs schedulingGapMs possibleSuspensionMs`.split(
    " ",
  ),
);
const codeFields = new Set(
  `id kind phase workClass provider model api nativeCallId parentId runId sessionId sessionHash jobId responseId responseModel cloudflareRay outcome failurePhase stopReason usageSource errorName errorCode errorCodeHash failureKind abortReasonName providerErrorCode providerErrorCodeHash providerErrorType lastHttpAttemptId correlationHeader`.split(
    " ",
  ),
);
const booleanFields = new Set([
  "terminal",
  "dispatcherReused",
  "callerSignalAborted",
  "wireParserTruncated",
  "clockChanged",
]);

/** Enforce the metadata-only contract again at persistence; never serialize arbitrary caller fields. */
export function modelRequestMetadataSnapshot(record: ModelRequestRecord): ModelRequestRecord {
  const result: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (numericFields.has(key)) {
      result[key] =
        key === "queuePriority" && (value === -1 || value === 0 || value === 1)
          ? value
          : telemetryFinite(value);
    } else if (codeFields.has(key)) {
      result[key] = telemetryCode(value);
    } else if (booleanFields.has(key) && (typeof value === "boolean" || value === null)) {
      result[key] = value;
    }
  }
  // The typed producer supplies these fields; validate them before retaining the snapshot.
  if (
    !telemetryUuid(result.id) ||
    (result.kind !== "http_attempt" &&
      result.kind !== "model_call" &&
      result.kind !== "host_gap") ||
    typeof result.startedAtMs !== "number" ||
    typeof result.updatedAtMs !== "number" ||
    typeof result.terminal !== "boolean"
  ) {
    throw new Error("Invalid model request telemetry metadata");
  }
  return result as ModelRequestRecord;
}

export function normalizeReportedUsage(
  value: unknown,
  options: { wire?: boolean; successful?: boolean } = {},
) {
  if (!isRecord(value)) {
    return null;
  }
  const details = (key: string) => (isRecord(value[key]) ? value[key] : {});
  const input = telemetryCounter(
    options.wire ? (value.prompt_tokens ?? value.input_tokens) : value.input,
  );
  const output = telemetryCounter(
    options.wire ? (value.completion_tokens ?? value.output_tokens) : value.output,
  );
  const cacheRead = telemetryCounter(
    options.wire
      ? (details("prompt_tokens_details").cached_tokens ??
          details("input_tokens_details").cached_tokens ??
          value.cache_read_input_tokens)
      : value.cacheRead,
  );
  const cacheWrite = telemetryCounter(
    options.wire ? value.cache_creation_input_tokens : value.cacheWrite,
  );
  const reasoning = telemetryCounter(
    options.wire
      ? (details("completion_tokens_details").reasoning_tokens ??
          details("output_tokens_details").reasoning_tokens)
      : value.reasoningTokens,
  );
  if (
    [input, output, cacheRead, cacheWrite, reasoning].every((v) => v === null) ||
    (!options.wire &&
      options.successful === false &&
      ![input, output, cacheRead, cacheWrite, reasoning].some((v) => v !== null && v > 0))
  ) {
    return null;
  }
  return {
    inputTokens:
      input === null ? null : options.wire ? input : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    usageSource: options.wire ? "provider_reported" : "native_terminal",
  };
}

export function countRequestImages(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  const messages = payload.messages ?? payload.input;
  if (typeof messages === "string") {
    return 0;
  }
  if (!Array.isArray(messages)) {
    return null;
  }
  const image = (part: unknown) =>
    isRecord(part) && ["image", "image_url", "input_image"].includes(String(part.type));
  let count = 0;
  for (const message of messages) {
    if (image(message)) {
      count++;
    }
    if (isRecord(message) && Array.isArray(message.content)) {
      count += message.content.filter(image).length;
    }
  }
  return count;
}
