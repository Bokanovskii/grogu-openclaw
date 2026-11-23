import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedTurnTelemetryInput } from "../../src/state/protected-feedback.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export function recordProtectedUsage(
  stateDir: string,
  input: {
    runId: string;
    profileId: string;
    model: string;
    messages: number | null;
    tokens: number | null;
    failed: boolean;
    now: number;
    telemetry?: ProtectedTurnTelemetryInput;
  },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedUsage.record",
    input,
  });
}

export function listProtectedUsage(stateDir: string, profileId: string, now: number) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedUsage.list",
    input: { profileId, now },
  });
}

export function pruneProtectedUsage(stateDir: string, now: number) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedUsage.prune",
    input: { now },
  });
}
