import { performance } from "node:perf_hooks";
import type { ProtectedActivity } from "@openclaw/gateway-protocol/protected";
type Phase =
  | "admissionMs"
  | "providerRequestStartMs"
  | "firstProviderOutputMs"
  | "firstClientVisibleOutputMs";
export type ProtectedTurnTiming = Record<Phase, number | null> & { completionMs: number };

/**
 * Fixed steps of a request, in the order they normally happen. A step records milliseconds
 * since the request started, so its cost is the gap to the step before it.
 */
export const protectedTurnMarks = [
  "identityVerified",
  "memberResolved",
  "accessAdmitted",
  "accessBound",
  "chatEntryRead",
  "routeGrantChecked",
  "bodyParsed",
  "turnGrantChecked",
  "aliasesPrepared",
  "storageAdmitted",
  "turnEntryRead",
  "admissionGrantChecked",
  "historyRead",
  "artifactsListed",
  "keyResolved",
  "memoryOpened",
  "runnerStarting",
  "runnerEntered",
  "modelResolved",
  "authResolved",
  "contextEngineReady",
  "attemptDispatched",
  "contextAssembled",
  "toolStarted",
  "runnerReturned",
  "updatesFlushed",
  "childrenFinished",
  "resultRead",
  "budgetSaved",
] as const;
export type ProtectedTurnMark = (typeof protectedTurnMarks)[number];

/** Counts and durations a turn may report about the load it ran under and the work it did. */
export const protectedTurnNotes = [
  "activeTurns",
  "storageQueueMs",
  "storageScanMs",
  "modelRequests",
  "modelWallMs",
  "modelFirstOutputMs",
  "modelFirstTextMs",
  "modelInputTokens",
  "modelOutputTokens",
  "modelCacheReadTokens",
  "modelReasoningTokens",
  "toolCalls",
  "toolMs",
  "searchMs",
  "fetchMs",
] as const;
export type ProtectedTurnNote = (typeof protectedTurnNotes)[number];

/** The numbers a terminal model request reports; a field is null when it was not measured. */
export type ModelRequestFacts = {
  wallDurationMs: number | null;
  timeToFirstOutputMs: number | null;
  timeToFirstTextMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
};

/** Optional numbers on the timing line, in output order. */
export const protectedTurnExtras = ["turnOrdinal", "finishedAtSec", ...protectedTurnNotes] as const;
type Extra = (typeof protectedTurnExtras)[number];

// Counts admitted turns since this process started, so a first-turn warm-up cost stands out.
let admittedTurns = 0;

/** Only elapsed times, counts and fixed outcomes leave the protected turn's timing owner. */
export function createProtectedTurnTiming(startedAt: number) {
  const phases: Record<Phase, number | null> = {
    admissionMs: null,
    providerRequestStartMs: null,
    firstProviderOutputMs: null,
    firstClientVisibleOutputMs: null,
  };
  // Insertion order is the order the steps first happened.
  const marks: Partial<Record<ProtectedTurnMark, number>> = {};
  const notes: Partial<Record<Extra, number>> = {};
  let admittedAt: number | undefined;
  let accessChecks = 0;
  let accessValidationMs = 0;
  let toolCalls = 0;
  let toolMs = 0;
  const toolMsByKind: Partial<Record<ProtectedActivity["kind"], number>> = {};
  return {
    mark: (phase: Phase) => {
      const now = performance.now();
      if (phase === "admissionMs") {
        if (admittedAt === undefined) {
          phases.admissionMs = Math.round(now - startedAt);
          admittedAt = now;
          notes.turnOrdinal = ++admittedTurns;
        }
      } else {
        phases[phase] ??= Math.round(now - (admittedAt ?? startedAt));
      }
    },
    at: (step: ProtectedTurnMark) => {
      marks[step] ??= Math.round(performance.now() - startedAt);
    },
    note: (name: ProtectedTurnNote, value: number) => {
      notes[name] = Math.round(value);
    },
    /** One finished tool call. Parallel calls overlap, so their durations add up past wall time. */
    tool: (kind: ProtectedActivity["kind"], durationMs: number) => {
      toolCalls++;
      toolMs += durationMs;
      toolMsByKind[kind] = (toolMsByKind[kind] ?? 0) + durationMs;
    },
    /** Totals across the turn's model requests, which overlap when specialists run side by side. */
    modelRequests: (requests: readonly ModelRequestFacts[]) => {
      if (requests.length === 0) {
        return;
      }
      notes.modelRequests = requests.length;
      // A total is left out when no request measured it, so a missing value is never read as zero.
      const total = (
        name: ProtectedTurnNote,
        pick: (request: ModelRequestFacts) => number | null,
      ) => {
        let sum: number | undefined;
        for (const request of requests) {
          const value = pick(request);
          if (value !== null) {
            sum = (sum ?? 0) + value;
          }
        }
        if (sum !== undefined) {
          notes[name] = Math.round(sum);
        }
      };
      total("modelWallMs", (request) => request.wallDurationMs);
      total("modelFirstOutputMs", (request) => request.timeToFirstOutputMs);
      total("modelFirstTextMs", (request) => request.timeToFirstTextMs);
      total("modelInputTokens", (request) => request.inputTokens);
      total("modelOutputTokens", (request) => request.outputTokens);
      total("modelCacheReadTokens", (request) => request.cacheReadTokens);
      total("modelReasoningTokens", (request) => request.reasoningTokens);
    },
    accessValidation() {
      const checkingAt = performance.now();
      accessChecks++;
      return () => {
        accessValidationMs += performance.now() - checkingAt;
      };
    },
    finish(outcome: "complete" | "failed" | "interrupted") {
      const result = {
        ...phases,
        completionMs: Math.round(performance.now() - (admittedAt ?? startedAt)),
      };
      notes.finishedAtSec = Math.round(Date.now() / 1000);
      if (toolCalls > 0) {
        notes.toolCalls = toolCalls;
        notes.toolMs = Math.round(toolMs);
        if (toolMsByKind.search !== undefined) {
          notes.searchMs = Math.round(toolMsByKind.search);
        }
        if (toolMsByKind.fetch !== undefined) {
          notes.fetchMs = Math.round(toolMsByKind.fetch);
        }
      }
      console.info(
        "[protected-turn-timing]",
        JSON.stringify({
          ...result,
          accessChecks,
          accessValidationMs: Math.round(accessValidationMs),
          outcome,
          ...notes,
          marks,
        }),
      );
      return result satisfies ProtectedTurnTiming;
    },
  };
}

export type ProtectedTurnTimer = ReturnType<typeof createProtectedTurnTiming>;
