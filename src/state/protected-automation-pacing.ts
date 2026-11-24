import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  ProtectedAutomationDraft,
  ProtectedAutomationPacing,
  ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import { DEFAULT_ERROR_BACKOFF_SCHEDULE_MS, errorBackoffMs } from "../cron/error-backoff.js";
import { resolvePacedNextRunAtMs } from "../cron/pacing.js";
import type { ProtectedAutomationLifecycleCommand } from "./protected-automation-lifecycle.types.js";

export type ProtectedAutomationCheckDecision = {
  version: string;
  atMs: number;
  reason: NonNullable<ProtectedAutomationRecord["nextCheckReason"]>;
  consecutiveFailures: number;
};

export type ProtectedAutomationCheckColumns = {
  pacing_revision: number | null;
  pacing_next_at_ms: number | null;
  pacing_reason: number | null;
  pacing_failures: number | null;
};

const reasonCodes = { model: 1, fallback: 2, backoff: 3 } as const;

export function readProtectedAutomationCheck(
  row?: ProtectedAutomationCheckColumns,
): ProtectedAutomationCheckDecision | undefined {
  if (!row) {
    return undefined;
  }
  const {
    pacing_revision: revision,
    pacing_next_at_ms: time,
    pacing_reason: code,
    pacing_failures: failures,
  } = row;
  if (revision === null && time === null && code === null && failures === null) {
    return undefined;
  }
  const reason =
    code === reasonCodes.model
      ? "model"
      : code === reasonCodes.backoff
        ? "backoff"
        : code === reasonCodes.fallback
          ? "fallback"
          : undefined;
  if (
    !reason ||
    revision === null ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    time === null ||
    time < 0 ||
    asDateTimestampMs(time) === undefined ||
    failures === null ||
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    failures > DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.length
  ) {
    throw new Error("Stored protected automation pacing cursor is invalid.");
  }
  return { version: String(revision), atMs: time, reason, consecutiveFailures: failures };
}

export function protectedAutomationCheckColumns(
  check: ProtectedAutomationCheckDecision,
): ProtectedAutomationCheckColumns {
  return {
    pacing_revision: Number(check.version),
    pacing_next_at_ms: check.atMs,
    pacing_reason: reasonCodes[check.reason],
    pacing_failures: check.consecutiveFailures,
  };
}

export function resolveFinishedAutomationCheck(
  definition: ProtectedAutomationDraft | undefined,
  revision: number,
  command: Extract<ProtectedAutomationLifecycleCommand, { kind: "finish" }>,
  chat?: ProtectedAutomationCheckColumns,
): ProtectedAutomationCheckDecision | undefined {
  if (!definition?.pacing || definition.schedule.kind !== "every") {
    return undefined;
  }
  const version = String(revision);
  const previous = readProtectedAutomationCheck(chat);
  return resolveProtectedAutomationCheck(
    { version, pacing: definition.pacing, schedule: definition.schedule },
    command.now,
    command.outcome.status === "succeeded" ? command.outcome : { status: "failed" },
    previous?.version === version ? previous.consecutiveFailures : 0,
  );
}

export function resolveProtectedAutomationCheck(
  automation: { version: string; schedule: { everyMs: number }; pacing: ProtectedAutomationPacing },
  endedAtMs: number,
  outcome: { status: "succeeded"; proposedDelayMs?: number } | { status: "failed" },
  previousFailures: number,
): ProtectedAutomationCheckDecision {
  const consecutiveFailures =
    outcome.status === "failed"
      ? Math.min(previousFailures + 1, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.length)
      : 0;
  const proposal = outcome.status === "succeeded" ? outcome.proposedDelayMs : undefined;
  const usableProposal = proposal !== undefined && Number.isSafeInteger(proposal) && proposal > 0;
  const delayMs = consecutiveFailures
    ? Math.max(automation.schedule.everyMs, errorBackoffMs(consecutiveFailures))
    : usableProposal
      ? proposal
      : automation.schedule.everyMs;
  const atMs = resolvePacedNextRunAtMs({
    nowMs: endedAtMs,
    delayMs,
    pacing: { min: `${automation.pacing.minMs}ms`, max: `${automation.pacing.maxMs}ms` },
  });
  if (atMs === undefined) {
    throw new Error("Protected automation has no valid next check.");
  }
  return {
    version: automation.version,
    atMs,
    reason: consecutiveFailures ? "backoff" : usableProposal ? "model" : "fallback",
    consecutiveFailures,
  };
}
