import type {
  ProtectedAutomationDraft,
  ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import {
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
  type ProtectedAutomationMutationAuthority,
} from "../../src/state/protected-automation-operations.js";
import type { ProtectedAutomationStorageRecord } from "../../src/state/protected-automations.js";
import type { StorageAdmission } from "./capacity.js";

function context(stateDir: string) {
  return captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } });
}

function assertCurrent(
  workerContext: ReturnType<typeof captureOpenClawStateWorkerContext>,
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

function definition(automation: ProtectedAutomationRecord): ProtectedAutomationDraft {
  return {
    name: automation.name,
    instructions: automation.instructions,
    whenToNotify: automation.whenToNotify,
    ...(automation.doneWhen === undefined ? {} : { doneWhen: automation.doneWhen }),
    agentId: automation.agentId,
    model: automation.model,
    ...(automation.thinking === undefined ? {} : { thinking: automation.thinking }),
    schedule: automation.schedule,
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
  storage.chargeAutomationCreate(input.definition);
  const workerContext = context(stateDir);
  const result = await createProtectedAutomationWithAdmission(workerContext, input, authority);
  const created = result.status === "created";
  storage.settleAutomationCreate(input.definition, created);
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
  const currentDefinition = definition(current);
  storage.chargeAutomationPatch(currentDefinition, input.definition);
  const workerContext = context(stateDir);
  const result = await patchProtectedAutomationWithAdmission(workerContext, input, authority);
  storage.settleAutomationPatch(currentDefinition, input.definition, result.status === "updated");
  storage.assertResult();
  return result.status === "updated" ? record(result.automation) : result;
}
