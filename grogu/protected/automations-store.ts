import type {
  ProtectedAutomationCatalog,
  ProtectedAutomationDraft,
  ProtectedAutomationDraftValidation,
  ProtectedAutomationPatchRequest,
  ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import {
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
  type ProtectedAutomationMutationAuthority,
} from "../../src/state/protected-automation-operations.js";
import type { ProtectedAutomationStorageRecord } from "../../src/state/protected-automations.js";
import { applyProtectedAutomationPatch, validateProtectedAutomationDraft } from "./automations.js";
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

export type StoredAutomationRecord = Omit<ProtectedAutomationRecord, "nextCheckAt">;

function record(automation: ProtectedAutomationStorageRecord): StoredAutomationRecord {
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

export async function readOwnedProtectedAutomationStorageRecord(
  stateDir: string,
  automationId: string,
  authority: ProtectedAutomationMutationAuthority,
): Promise<ProtectedAutomationStorageRecord | undefined> {
  const automation = await readAutomation(
    stateDir,
    { profileId: authority.profileId, automationId },
    authority,
  );
  return automation?.relation === "owner" &&
    automation.centralOwnerProfileId === authority.profileId
    ? automation
    : undefined;
}

export async function listOwnedProtectedAutomationStorageRecords(
  stateDir: string,
  authority: ProtectedAutomationMutationAuthority,
): Promise<ProtectedAutomationStorageRecord[]> {
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
  return records.filter(
    (automation) =>
      automation.relation === "owner" && automation.centralOwnerProfileId === authority.profileId,
  );
}

export async function listProtectedAutomationRecords(
  stateDir: string,
  authority: ProtectedAutomationMutationAuthority,
): Promise<StoredAutomationRecord[]> {
  const records = await listOwnedProtectedAutomationStorageRecords(stateDir, authority);
  return records.filter((automation) => automation.visibility === "private").map(record);
}

export async function readProtectedAutomationRecord(
  stateDir: string,
  input: { profileId: string; automationId: string },
  authority: ProtectedAutomationMutationAuthority,
): Promise<StoredAutomationRecord | undefined> {
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
  input: {
    profileId: string;
    definition: ProtectedAutomationDraft;
    now: number;
    automationId?: string;
  },
  authority: ProtectedAutomationMutationAuthority,
  storage: Pick<
    StorageAdmission,
    "chargeAutomationCreate" | "settleAutomationCreate" | "assertResult"
  >,
): Promise<StoredAutomationRecord | undefined> {
  const workerContext = context(stateDir);
  const result = await createProtectedAutomationWithAdmission(workerContext, input, {
    ...authority,
    admitStorage: ({ nextStoredBytes }) => storage.chargeAutomationCreate(nextStoredBytes),
    onStorageCommitted: ({ committedStoredBytes, automationId }) =>
      storage.settleAutomationCreate(committedStoredBytes, true, automationId),
    onStorageAborted: ({ nextStoredBytes }) =>
      storage.settleAutomationCreate(nextStoredBytes, false),
  });
  const created = result.status === "created" || result.status === "exists";
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
    enabled?: boolean;
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

export type SaveProtectedAutomationPatchResult =
  | { status: "updated"; automation: StoredAutomationRecord }
  | { status: "not_found" }
  | { status: "version_mismatch"; currentVersion?: string }
  | { status: "scheduler_required" }
  | { status: "invalid"; validation: Extract<ProtectedAutomationDraftValidation, { valid: false }> }
  | { status: "member_inactive" }
  | { status: "storage_unavailable" };

/** The versioned save path for field and authoring-chat edits. */
export async function saveProtectedAutomationPatch(
  stateDir: string,
  input: {
    automationId: string;
    expectedVersion: string;
    patch: ProtectedAutomationPatchRequest;
    catalog: ProtectedAutomationCatalog;
    retainedAgent: (agentId: string) => { id: string } | undefined;
  },
  authority: ProtectedAutomationMutationAuthority,
  deps: {
    revalidate: () => Promise<void>;
    schedulerAvailable?: boolean;
    provision?: () => Promise<void>;
    admitStorage?: () => Promise<
      Pick<
        StorageAdmission,
        "chargeAutomationPatch" | "settleAutomationPatch" | "assertResult" | "release"
      >
    >;
  },
): Promise<SaveProtectedAutomationPatchResult> {
  if (
    !/^[1-9]\d*$/u.test(input.expectedVersion) ||
    !Number.isSafeInteger(Number(input.expectedVersion))
  ) {
    return { status: "version_mismatch" };
  }
  await deps.revalidate();
  const current = await readProtectedAutomationRecord(
    stateDir,
    { profileId: authority.profileId, automationId: input.automationId },
    authority,
  );
  if (!current) {
    return { status: "not_found" };
  }
  if (current.version !== input.expectedVersion) {
    return { status: "version_mismatch", currentVersion: current.version };
  }
  if (input.patch.enabled === true && !deps.schedulerAvailable) {
    return { status: "scheduler_required" };
  }
  const validation = validateProtectedAutomationDraft(
    applyProtectedAutomationPatch(current, input.patch),
    input.catalog,
    input.retainedAgent(current.agentId),
  );
  if (!validation.valid) {
    return { status: "invalid", validation };
  }
  await deps.revalidate();
  if (input.patch.enabled === true) {
    if (!deps.provision) {
      return { status: "scheduler_required" };
    }
    await deps.provision();
  }
  if (!deps.admitStorage) {
    return { status: "storage_unavailable" };
  }
  const storage = await deps.admitStorage();
  try {
    const updated = await patchProtectedAutomationRecord(
      stateDir,
      {
        profileId: authority.profileId,
        automationId: input.automationId,
        expectedRevision: Number(input.expectedVersion),
        definition: validation.draft,
        enabled: input.patch.enabled ?? current.enabled,
        now: Date.now(),
      },
      authority,
      storage,
    );
    if (!("status" in updated)) {
      authority.assertCurrent();
      return { status: "updated", automation: updated };
    }
    switch (updated.status) {
      case "member_inactive":
      case "version_mismatch":
      case "scheduler_required":
        return { status: updated.status };
      default:
        return { status: "not_found" };
    }
  } finally {
    storage.release();
  }
}
