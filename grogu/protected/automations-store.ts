import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  protectedAutomationPacingLimits,
  type ProtectedAutomationCatalog,
  type ProtectedAutomationDraft,
  type ProtectedAutomationDraftValidation,
  type ProtectedAutomationPatchRequest,
  type ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../src/infra/sqlite-worker-operation-settlement.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedAutomationRetirementUncertainCommit } from "../../src/state/protected-automation-lifecycle.types.js";
import {
  createProtectedAutomationWithAdmission,
  patchProtectedAutomationWithAdmission,
  type ProtectedAutomationMutationAuthority,
} from "../../src/state/protected-automation-operations.js";
import type { ProtectedAutomationStorageRecord } from "../../src/state/protected-automations.js";
import {
  protectedAutomationStorageLeaseKeys,
  protectedAutomationStorageLeases,
} from "./automation-storage-leases.js";
import { applyProtectedAutomationPatch, validateProtectedAutomationDraft } from "./automations.js";
import type { StorageAdmission } from "./capacity.js";
import { ProtectedError } from "./errors.js";
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

export type StoredAutomationRecord = Omit<
  ProtectedAutomationRecord,
  "nextCheckAt" | "nextCheckReason"
>;

export type ProtectedAutomationCreationSafety = {
  hasRunHistory(automationId: string): Promise<boolean>;
  enrollPublication(): { finish(outcome: "settled" | "recovery-required"): void };
  retainUncertainCreateCommit(handle: ProtectedAutomationRetirementUncertainCommit): void;
  reconcile(): void;
};

export function projectProtectedAutomationRecord(
  automation: ProtectedAutomationStorageRecord,
): StoredAutomationRecord {
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
  return records.map(projectProtectedAutomationRecord);
}

export async function readProtectedAutomationRecord(
  stateDir: string,
  input: { profileId: string; automationId: string },
  authority: ProtectedAutomationMutationAuthority,
): Promise<StoredAutomationRecord | undefined> {
  const automation = await readAutomation(stateDir, input, authority);
  return automation?.relation === "owner"
    ? projectProtectedAutomationRecord(automation)
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
    "chargeAutomationCreate" | "settleAutomationCreate" | "assertResult" | "retainPendingWrite"
  >,
  safety?: ProtectedAutomationCreationSafety,
): Promise<StoredAutomationRecord | undefined> {
  const workerContext = context(stateDir);
  if (input.definition.contextAccess !== "isolated") {
    const result = await createProtectedAutomationWithAdmission(workerContext, input, {
      ...authority,
      admitStorage: ({ nextStoredBytes }) => storage.chargeAutomationCreate(nextStoredBytes),
      onStorageCommitted: ({ committedStoredBytes, automationId }) =>
        storage.settleAutomationCreate(committedStoredBytes, true, automationId),
      onStorageAborted: ({ nextStoredBytes }) =>
        storage.settleAutomationCreate(nextStoredBytes, false),
    });
    storage.assertResult();
    return result.status === "created" || result.status === "exists"
      ? projectProtectedAutomationRecord(result.automation)
      : undefined;
  }
  if (!safety) {
    throw new Error("Isolated automation creation requires run-chat admission.");
  }
  const automationId = input.automationId ?? randomUUID();
  const lease = protectedAutomationStorageLeases.reserve(
    protectedAutomationStorageLeaseKeys(
      workerContext.admission.databasePath,
      automationId,
      input.profileId,
    ),
  );
  if (!lease) {
    throw new Error("Protected automation creation identity could not be reserved.");
  }
  let enrollment: ReturnType<ProtectedAutomationCreationSafety["enrollPublication"]> | undefined;
  let native:
    | {
        admission: SqliteWorkerOperationAdmission;
        operation: RetainedWorkerTransactionAdmission;
      }
    | undefined;
  let chargedBytes: number | undefined;
  let storageSettled = false;
  let writerSettled = false;
  let retained = false;
  const releasePending = storage.retainPendingWrite();
  const settleStorage = (created: boolean) => {
    if (!storageSettled && chargedBytes !== undefined) {
      storage.settleAutomationCreate(chargedBytes, created, created ? automationId : undefined);
      storageSettled = true;
    }
  };
  const retainNative = () => {
    if (!native || retained) {
      return;
    }
    safety.retainUncertainCreateCommit({
      admission: native.admission,
      retained: native.operation,
      lease,
      verifyReceipt: (facts) =>
        chargedBytes !== undefined &&
        isDeepStrictEqual(facts, {
          kind: "protected-automation",
          action: "create",
          profileId: input.profileId,
          storage: {
            automationId,
            currentStoredBytes: 0,
            nextStoredBytes: chargedBytes,
            committedStoredBytes: chargedBytes,
          },
        }),
      settleStorage: () => {
        settleStorage(true);
        releasePending();
      },
      releaseStorage: () => {
        settleStorage(false);
        releasePending();
      },
    });
    retained = true;
  };
  try {
    enrollment = safety.enrollPublication();
    await lease.wait();
    assertCurrent(workerContext, authority);
    const existing = await readAutomation(
      stateDir,
      { profileId: input.profileId, automationId },
      authority,
    );
    if (!existing && (await safety.hasRunHistory(automationId))) {
      throw new ProtectedError(
        409,
        "automation_history_conflict",
        "This automation ID has existing run history. Start a separate isolated automation.",
      );
    }
    assertCurrent(workerContext, authority);
    const outcome = await createProtectedAutomationWithAdmission(
      workerContext,
      { ...input, automationId },
      {
        ...authority,
        admitStorage: ({ automationId: admittedId, nextStoredBytes }) => {
          if (admittedId !== automationId) {
            throw new Error("Protected automation creation identity changed.");
          }
          storage.chargeAutomationCreate(nextStoredBytes);
          chargedBytes = nextStoredBytes;
        },
        onStorageCommitted: () => settleStorage(true),
        onStorageAborted: () => settleStorage(false),
        onNativeAdmission: (admission, operation) => {
          native = { admission, operation };
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const currentNative = native;
    if (currentNative) {
      const settled = await currentNative.operation.settled;
      writerSettled =
        settled.kind !== "unknown" && (outcome.ok || chargedBytes === undefined || storageSettled);
      if (!writerSettled) {
        retainNative();
        throw new SqliteWorkerError(
          "Protected automation creation requires native reconciliation.",
          "outcome-unknown",
        );
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    storage.assertResult();
    return outcome.value.status === "created" || outcome.value.status === "exists"
      ? projectProtectedAutomationRecord(outcome.value.automation)
      : undefined;
  } finally {
    if (native && !writerSettled && !retained) {
      retainNative();
    }
    if (!retained) {
      lease.release();
      releasePending();
    }
    enrollment?.finish(retained ? "recovery-required" : "settled");
    if (retained) {
      safety.reconcile();
    }
  }
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
  return result.status === "updated" ? projectProtectedAutomationRecord(result.automation) : result;
}

export type SaveProtectedAutomationPatchResult =
  | { status: "updated"; automation: StoredAutomationRecord }
  | { status: "not_found" }
  | { status: "version_mismatch"; currentVersion?: string }
  | { status: "automation_busy" }
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
  if (
    !input.catalog.schedule.pacing &&
    ("pacing" in input.patch || (current.pacing && input.patch.schedule))
  ) {
    return {
      status: "invalid",
      validation: {
        valid: false,
        errors: [
          {
            field: "pacing",
            code: "unsupported_schedule",
            message: "Update Alcove before changing a model-chosen schedule.",
          },
        ],
      },
    };
  }
  // A legacy client can still pause a paced job or edit its name without seeing or changing the bounds.
  const catalog =
    current.pacing && !input.catalog.schedule.pacing
      ? {
          ...input.catalog,
          schedule: { ...input.catalog.schedule, pacing: protectedAutomationPacingLimits },
        }
      : input.catalog;
  const validation = validateProtectedAutomationDraft(
    applyProtectedAutomationPatch(current, input.patch),
    catalog,
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
      case "automation_busy":
      case "scheduler_required":
        return { status: updated.status };
      default:
        return { status: "not_found" };
    }
  } finally {
    storage.release();
  }
}
