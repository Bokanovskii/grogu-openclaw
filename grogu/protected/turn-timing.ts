import { performance } from "node:perf_hooks";
import { telemetryRound } from "../../src/agents/model-request-telemetry-metadata.js";

type Phase =
  | "admissionMs"
  | "providerRequestStartMs"
  | "firstProviderOutputMs"
  | "firstClientVisibleOutputMs";

/** Only elapsed times and fixed outcomes leave the protected turn's timing owner. */
export function createProtectedTurnTiming(startedAt: number) {
  const phases: Record<Phase, number | null> = {
    admissionMs: null,
    providerRequestStartMs: null,
    firstProviderOutputMs: null,
    firstClientVisibleOutputMs: null,
  };
  const elapsed = () => telemetryRound(performance.now() - startedAt);
  let accessChecks = 0;
  let accessValidationMs = 0;
  return {
    mark: (phase: Phase) => {
      phases[phase] ??= elapsed();
    },
    accessValidation() {
      const checkingAt = performance.now();
      accessChecks++;
      return () => {
        accessValidationMs += performance.now() - checkingAt;
      };
    },
    finish(outcome: "complete" | "failed" | "interrupted") {
      console.info(
        "[protected-turn-timing]",
        JSON.stringify({
          ...phases,
          accessChecks,
          accessValidationMs: telemetryRound(accessValidationMs),
          completionMs: elapsed(),
          outcome,
        }),
      );
    },
  };
}
