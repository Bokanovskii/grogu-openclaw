import type {
  ProtectedAutomationFinishedRun,
  ProtectedAutomationRunListResponse,
  ProtectedAutomationRunResponse,
} from "../../packages/gateway-protocol/src/protected-automation-results.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedAutomationMutationAuthority } from "../../src/state/protected-automation-operations.js";
import { ProtectedError } from "./errors.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type ProtectedAutomationResultReadAuthority = ProtectedAutomationMutationAuthority & {
  revalidate(): Promise<void>;
};

async function readRuns(
  stateDir: string,
  input: { profileId: string; automationId: string; id?: string },
  authority: ProtectedAutomationResultReadAuthority,
): Promise<ProtectedAutomationFinishedRun[]> {
  const context = captureProtectedStateWorkerContext(stateDir);
  await authority.revalidate();
  const runs = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomationResults.runs", input }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  // Foreign, revoked, and unknown automations are indistinguishable.
  if (!runs) {
    throw new ProtectedError(404, "not_found", "Not found.");
  }
  return runs;
}

export async function listProtectedAutomationRunRecords(
  stateDir: string,
  automationId: string,
  authority: ProtectedAutomationResultReadAuthority,
): Promise<ProtectedAutomationRunListResponse> {
  return {
    runs: await readRuns(stateDir, { profileId: authority.profileId, automationId }, authority),
  };
}

export async function readProtectedAutomationRunRecord(
  stateDir: string,
  input: { automationId: string; id: string },
  authority: ProtectedAutomationResultReadAuthority,
): Promise<ProtectedAutomationRunResponse> {
  const [run] = await readRuns(stateDir, { profileId: authority.profileId, ...input }, authority);
  if (!run) {
    throw new ProtectedError(404, "not_found", "Not found.");
  }
  return { run };
}

/** Existing-owner contribution to `storedDataUsage`; includes every retained run, readable or not. */
export async function readProtectedAutomationResultStorageUsage(
  stateDir: string,
  assertCurrent: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomationResults.storageUsage", input: undefined }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        assertCurrent();
      },
    },
  );
}
