import type {
  ProtectedAutomationDraft,
  ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import {
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
  type ProtectedAutomationMutationAuthority,
} from "../../src/state/protected-automation-operations.js";
import type { ProtectedAutomationStorageRecord } from "../../src/state/protected-automations.js";
import type { StorageAdmission } from "./capacity.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

function context(stateDir: string) {
  return captureProtectedStateWorkerContext(stateDir);
}

function assertCurrent(
  workerContext: ReturnType<typeof captureProtectedStateWorkerContext>,
  authority: ProtectedAutomationMutationAuthority,
) {
  workerContext.admission.assertCurrent();
  authority.assertCurrent();
}

function record(automation: ProtectedAutomationStorageRecord): ProtectedAutomationRecord {
  const thinking = automation.definition.thinking;
  if (!thinking) {
    throw new Error("Stored protected automation has no resolved thinking level.");
  }
  return {
    ...automation.definition,
    thinking,
    id: automation.id,
    version: String(automation.definitionRevision),
    enabled: automation.enabled,
    state: automation.enabled ? "active" : "paused",
    nextCheckAt: null,
  };
}

async function readAutomation(
  stateDir: string,
  input: { profileId: string; automationId: string },
  authority: ProtectedAutomationMutationAuthority,
) {
  const workerContext = context(stateDir);
  return runOpenClawStateWorkerOperation(
    workerContext,
    (scope) => scope.execute({ type: "protectedAutomations.read", input }),
    { assertCurrent: () => assertCurrent(workerContext, authority) },
  );
}

export async function listProtectedAutomationRecords(
  stateDir: string,
  authority: ProtectedAutomationMutationAuthority,
): Promise<ProtectedAutomationRecord[]> {
  const workerContext = context(stateDir);
  const records = await runOpenClawStateWorkerOperation(
    workerContext,
    (scope) =>
      scope.execute({
        type: "protectedAutomations.list",
        input: { profileId: authority.profileId },
      }),
    { assertCurrent: () => assertCurrent(workerContext, authority) },
  );
  return records
    .filter((automation) => automation.visibility === "private" && automation.relation === "owner")
    .map(record);
}

export async function readProtectedAutomationRecord(
  stateDir: string,
  input: { profileId: string; automationId: string },
  authority: ProtectedAutomationMutationAuthority,
): Promise<ProtectedAutomationRecord | undefined> {
  const automation = await readAutomation(stateDir, input, authority);
  return automation && automation.visibility === "private" && automation.relation === "owner"
    ? record(automation)
    : undefined;
}

export async function readProtectedAutomationStorageUsage(
  stateDir: string,
  profileId: string,
  assertAuthorityCurrent: () => void,
) {
  const workerContext = context(stateDir);
  return runOpenClawStateWorkerOperation(
    workerContext,
    (scope) => scope.execute({ type: "protectedAutomations.storageUsage", input: { profileId } }),
    {
      assertCurrent: () =>
        assertCurrent(workerContext, { profileId, assertCurrent: assertAuthorityCurrent }),
    },
  );
}

export async function createProtectedAutomationRecord(
  stateDir: string,
  input: { profileId: string; definition: ProtectedAutomationDraft; now: number },
  authority: ProtectedAutomationMutationAuthority,
  storage: Pick<
    StorageAdmission,
    "chargeAutomationCreate" | "settleAutomationCreate" | "assertResult"
  >,
): Promise<ProtectedAutomationRecord | undefined> {
  const workerContext = context(stateDir);
  const result = await createProtectedAutomationWithAdmission(workerContext, input, {
    ...authority,
    admitStorage: ({ nextStoredBytes }) => storage.chargeAutomationCreate(nextStoredBytes),
    onStorageCommitted: ({ committedStoredBytes, automationId }) =>
      storage.settleAutomationCreate(committedStoredBytes, true, automationId),
    onStorageAborted: ({ nextStoredBytes }) =>
      storage.settleAutomationCreate(nextStoredBytes, false),
  });
  const created = result.status === "created";
  storage.assertResult();
  if (!created) {
    return undefined;
  }
  return record(result.automation);
}

export async function patchProtectedAutomationRecord(
  stateDir: string,
  input: {
    profileId: string;
    automationId: string;
    expectedRevision: number;
    definition: ProtectedAutomationDraft;
    now: number;
  },
  authority: ProtectedAutomationMutationAuthority,
  storage: Pick<
    StorageAdmission,
    "chargeAutomationPatch" | "settleAutomationPatch" | "assertResult"
  >,
) {
  const current = await readProtectedAutomationRecord(
    stateDir,
    { profileId: input.profileId, automationId: input.automationId },
    authority,
  );
  if (!current) {
    return { status: "automation_not_found" as const };
  }
  if (current.version !== String(input.expectedRevision)) {
    return { status: "version_mismatch" as const };
  }
  const workerContext = context(stateDir);
  const result = await patchProtectedAutomationWithAdmission(workerContext, input, {
    ...authority,
    admitStorage: ({ currentStoredBytes, nextStoredBytes }) =>
      storage.chargeAutomationPatch(currentStoredBytes, nextStoredBytes),
    onStorageCommitted: ({ currentStoredBytes, committedStoredBytes }) =>
      storage.settleAutomationPatch(currentStoredBytes, committedStoredBytes, true),
    onStorageAborted: ({ currentStoredBytes, nextStoredBytes }) =>
      storage.settleAutomationPatch(currentStoredBytes, nextStoredBytes, false),
  });
  storage.assertResult();
  return result.status === "updated" ? record(result.automation) : result;
}
