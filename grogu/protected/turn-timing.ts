import { performance } from "node:perf_hooks";
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

/** Counts and durations a turn may report about the load it ran under. */
export const protectedTurnNotes = ["activeTurns", "storageQueueMs", "storageScanMs"] as const;
export type ProtectedTurnNote = (typeof protectedTurnNotes)[number];

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
