import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import type {
  CronTriggerEvaluationResult,
  CronTriggerFailureCode,
  CronTriggerSourceFailureKind,
} from "./types.js";

const MAX_TRIGGER_STATE_BYTES = 16 * 1024;

function isTruncatedScriptOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.truncated === true &&
    typeof value.prefix === "string" &&
    typeof value.omittedBytes === "number"
  );
}

function scriptOutputFailure(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
  candidate: unknown,
  label: string,
) {
  // A prefix is diagnostic text, never a complete decision or a reason to settle earlier JSON.
  if (
    isTruncatedScriptOutput(result.value) ||
    isTruncatedScriptOutput(candidate) ||
    (candidate === undefined && result.output.some(isTruncatedScriptOutput))
  ) {
    return scriptFailure(
      `${label} result was truncated; return a smaller complete result`,
      "output_limit_exceeded",
    );
  }
  return undefined;
}

function scriptResultCandidate(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
  condition = false,
) {
  if (isRecord(result.value) && (!condition || typeof result.value.fire === "boolean")) {
    return result.value;
  }
  for (let index = result.output.length - 1; index >= 0; index -= 1) {
    const entry = result.output[index];
    if (isRecord(entry) && entry.type === "json") {
      return entry.value;
    }
  }
  return undefined;
}

function scriptTriggerCandidate(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): unknown {
  const isTriggerCandidate = (candidate: unknown) =>
    isRecord(candidate) &&
    (typeof candidate.fire === "boolean" ||
      (isRecord(candidate.error) && typeof candidate.error.kind === "string"));
  if (isTriggerCandidate(result.value)) {
    return result.value;
  }
  for (let index = result.output.length - 1; index >= 0; index -= 1) {
    const entry = result.output[index];
    if (isRecord(entry) && entry.type === "json" && isTriggerCandidate(entry.value)) {
      return entry.value;
    }
  }
  return undefined;
}

export function scriptFailure(
  error: string,
  code: CronTriggerFailureCode = "internal_error",
  sourceFailureKind?: CronTriggerSourceFailureKind,
): Extract<CronTriggerEvaluationResult, { kind: "error" }> {
  return { kind: "error", code, error, ...(sourceFailureKind ? { sourceFailureKind } : {}) };
}

export function parseTriggerResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronTriggerEvaluationResult {
  const candidate = scriptTriggerCandidate(result);
  const outputFailure = scriptOutputFailure(result, candidate, "cron trigger");
  if (outputFailure) {
    return outputFailure;
  }
  if (
    isRecord(candidate) &&
    isRecord(candidate.error) &&
    typeof candidate.error.kind === "string"
  ) {
    const kind = candidate.error.kind;
    if (["transient", "timeout", "network", "incomplete", "unavailable"].includes(kind)) {
      return scriptFailure("worker source temporarily unavailable", "timeout");
    }
    if (kind === "auth" || kind === "permission" || kind === "config" || kind === "schema") {
      const sourceFailureKind: CronTriggerSourceFailureKind = kind;
      return scriptFailure(
        `worker source ${sourceFailureKind} failure`,
        "invalid_input",
        sourceFailureKind,
      );
    }
    return scriptFailure("worker source returned an unknown failure", "invalid_input");
  }
  if (!isRecord(candidate) || typeof candidate.fire !== "boolean") {
    return scriptFailure("cron trigger script must return an object with boolean fire");
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    return scriptFailure("cron trigger script message must be a string");
  }
  const state = validateCronState(candidate, "cron trigger");
  if (!state.ok) {
    return scriptFailure(state.error, state.code);
  }
  return {
    kind: "evaluated",
    fire: candidate.fire,
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    ...(state.stateChanged ? { state: state.state } : {}),
  };
}

export type CronScriptPayloadExecutionResult =
  | {
      kind: "completed";
      notify?: string;
      wake?: "now" | "next-heartbeat";
      stateChanged: boolean;
      state?: unknown;
      nextCheck?: { delayMs: number };
    }
  | { kind: "error"; code: CronTriggerFailureCode; error: string };

function validateCronState(candidate: Record<string, unknown>, label: string) {
  if (!Object.hasOwn(candidate, "state")) {
    return { ok: true as const, stateChanged: false as const };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(candidate.state);
  } catch (error) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable: ${formatErrorMessageWithCode(error)}`,
    };
  }
  if (serialized === undefined) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable`,
    };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRIGGER_STATE_BYTES) {
    return {
      ok: false as const,
      code: "output_limit_exceeded" as const,
      error: `${label} state exceeds the 16KB limit`,
    };
  }
  return {
    ok: true as const,
    stateChanged: true as const,
    state: JSON.parse(serialized) as unknown,
  };
}

export function parseScriptPayloadResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronScriptPayloadExecutionResult {
  const candidate = scriptResultCandidate(result);
  const outputFailure = scriptOutputFailure(result, candidate, "cron script payload");
  if (outputFailure) {
    return outputFailure;
  }
  if (!isRecord(candidate)) {
    return scriptFailure("cron script payload must return an object");
  }
  if (candidate.notify !== undefined && typeof candidate.notify !== "string") {
    return scriptFailure("cron script payload notify must be a string");
  }
  if (
    candidate.wake !== undefined &&
    candidate.wake !== "now" &&
    candidate.wake !== "next-heartbeat"
  ) {
    return scriptFailure('cron script payload wake must be "now" or "next-heartbeat"');
  }
  let nextCheck: { delayMs: number } | undefined;
  if (candidate.nextCheck !== undefined) {
    if (typeof candidate.nextCheck !== "string") {
      return scriptFailure("cron script payload nextCheck must be a duration string");
    }
    try {
      const delayMs = parseDurationMs(candidate.nextCheck);
      if (delayMs <= 0) {
        throw new Error("duration must be positive");
      }
      nextCheck = { delayMs };
    } catch {
      return scriptFailure("cron script payload nextCheck must be a positive duration");
    }
  }
  const state = validateCronState(candidate, "cron script payload");
  if (!state.ok) {
    return scriptFailure(state.error, state.code);
  }
  return {
    kind: "completed",
    ...(candidate.notify !== undefined ? { notify: candidate.notify } : {}),
    ...(candidate.wake !== undefined ? { wake: candidate.wake } : {}),
    stateChanged: state.stateChanged,
    ...(state.stateChanged ? { state: state.state } : {}),
    ...(nextCheck ? { nextCheck } : {}),
  };
}
