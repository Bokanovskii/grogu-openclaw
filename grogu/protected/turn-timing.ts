import { performance } from "node:perf_hooks";
type Phase =
  | "admissionMs"
  | "providerRequestStartMs"
  | "firstProviderOutputMs"
  | "firstClientVisibleOutputMs";
export type ProtectedTurnTiming = Record<Phase, number | null> & { completionMs: number };

/** Only elapsed times and fixed outcomes leave the protected turn's timing owner. */
export function createProtectedTurnTiming(startedAt: number) {
  const phases: Record<Phase, number | null> = {
    admissionMs: null,
    providerRequestStartMs: null,
    firstProviderOutputMs: null,
    firstClientVisibleOutputMs: null,
  };
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
        }
      } else {
        phases[phase] ??= Math.round(now - (admittedAt ?? startedAt));
      }
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
      console.info(
        "[protected-turn-timing]",
        JSON.stringify({
          ...result,
          accessChecks,
          accessValidationMs: Math.round(accessValidationMs),
          outcome,
        }),
      );
      return result satisfies ProtectedTurnTiming;
    },
  };
}
