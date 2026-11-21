import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";

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
  },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedUsage.record", input },
  );
}

export function listProtectedUsage(stateDir: string, profileId: string, now: number) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedUsage.list", input: { profileId, now } },
  );
}

export function pruneProtectedUsage(stateDir: string, now: number) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedUsage.prune", input: { now } },
  );
}
