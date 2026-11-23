import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../../src/infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../src/infra/sqlite-worker-operation-settlement.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedAdmissionAutomationRetirementFacts } from "../../src/state/protected-admission.js";
import type { ProtectedAutomationMemberRetirementAuthority } from "../../src/state/protected-automation-lifecycle.types.js";
import type { ProtectedAutomationStorageUsage } from "../../src/state/protected-automations.js";
import { readProtectedAutomationRetirementReceipt } from "./automation-retirement-receipt.js";
import { protectedAutomationStorageLeases } from "./automation-storage-leases.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type { ProtectedAccessRequest } from "../../src/state/protected-admission.js";
export type { ProtectedAutomationMemberRetirementAuthority } from "../../src/state/protected-automation-lifecycle.types.js";

export function submitProtectedAccessRequest(
  stateDir: string,
  input: { email: string; name: string; note: string; receipt?: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.submit",
    input: { ...input, now: Date.now() },
  });
}

export function readProtectedAccessRequest(stateDir: string, receipt: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.read",
    input: { receipt },
  });
}

export function editProtectedAccessRequest(
  stateDir: string,
  input: { receipt: string; name: string; note: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.edit",
    input: { ...input, now: Date.now() },
  });
}

export function withdrawProtectedAccessRequest(stateDir: string, receipt: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.withdraw",
    input: { receipt, now: Date.now() },
  });
}

export function listProtectedAccessRequests(stateDir: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.list",
    input: undefined,
  });
}

function ownerMutationAdmission(
  context: ReturnType<typeof captureProtectedStateWorkerContext>,
  status: "approved" | "denied" | "removed" | "retry_policy",
  assertCurrent: () => void,
  onRemovalCommitted: (
    subject: string | undefined,
    profileId: string | undefined,
    retiredAutomations: ProtectedAutomationStorageUsage["entries"],
  ) => void,
  onPolicyChanged: () => void,
  onNativeRemovalCommitted?: () => void,
  removalFacts?: ProtectedAdmissionAutomationRetirementFacts,
) {
  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
    assertCurrent();
    if (
      (status === "removed" && request.stage !== "transaction" && request.stage !== "commit") ||
      !isDeepStrictEqual(request.facts, removalFacts ?? status)
    ) {
      throw new Error("Access request mutation lost its authority.");
    }
    const granted = grant();
    if (status === "removed" && !granted) {
      throw new Error("Member removal native admission was not granted.");
    }
  });
  observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
    if (status !== "removed") {
      if (status === "approved" || status === "retry_policy") {
        onPolicyChanged();
      }
      return;
    }
    if (
      !isRecord(facts) ||
      facts.status !== "removed" ||
      (facts.subject !== undefined && typeof facts.subject !== "string") ||
      (facts.profileId !== undefined && typeof facts.profileId !== "string") ||
      !Array.isArray(facts.retiredAutomations) ||
      !facts.retiredAutomations.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.profileId === "string" &&
          typeof entry.definitionBytes === "number" &&
          Number.isSafeInteger(entry.definitionBytes) &&
          entry.definitionBytes >= 0,
      )
    ) {
      throw new Error("Access removal committed with invalid publication facts.");
    }
    if (onNativeRemovalCommitted) {
      onNativeRemovalCommitted();
      return;
    }
    onRemovalCommitted(facts.subject, facts.profileId, facts.retiredAutomations);
    onPolicyChanged();
  });
  return { nativeLocations: [context.admission.databasePath], admission };
}

export function setProtectedRequestStatus(
  stateDir: string,
  input: {
    id: string;
    status: "approved" | "denied";
    issuer: string;
  },
  assertCurrent: () => void,
  onPolicyChanged: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "protectedAccess.setStatus", input: { ...input, now: Date.now() } }),
    {
      assertCurrent: assertOwnerCurrent,
      createAdmission: () =>
        ownerMutationAdmission(
          context,
          input.status,
          assertOwnerCurrent,
          () => {},
          onPolicyChanged,
        ),
    },
  );
}

export function removeProtectedAdmission(
  stateDir: string,
  input: { id: string; issuer: string; ownerSubject: string },
  assertCurrent: () => void,
  onRemovalCommitted: (
    subject: string | undefined,
    profileId: string | undefined,
    retiredAutomations: ProtectedAutomationStorageUsage["entries"],
  ) => void,
  onPolicyChanged: () => void,
  retirement?: ProtectedAutomationMemberRetirementAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const captured = { id: input.id, issuer: input.issuer, ownerSubject: input.ownerSubject };
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  if (retirement) {
    return removeWithAutomationStorage(
      context,
      captured,
      assertOwnerCurrent,
      onRemovalCommitted,
      onPolicyChanged,
      retirement,
    );
  }
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "protectedAccess.removeAdmission",
        input: { ...captured, now: Date.now() },
      }),
    {
      assertCurrent: assertOwnerCurrent,
      createAdmission: () =>
        ownerMutationAdmission(
          context,
          "removed",
          assertOwnerCurrent,
          onRemovalCommitted,
          onPolicyChanged,
        ),
    },
  );
}

async function removeWithAutomationStorage(
  context: ReturnType<typeof captureProtectedStateWorkerContext>,
  input: { id: string; issuer: string; ownerSubject: string },
  assertOwnerCurrent: () => void,
  onRemovalCommitted: (
    subject: string | undefined,
    profileId: string | undefined,
    retiredAutomations: ProtectedAutomationStorageUsage["entries"],
  ) => void,
  onPolicyChanged: () => void,
  retirement: ProtectedAutomationMemberRetirementAuthority,
) {
  const target = {
    profileId: retirement.profileId,
    admissionRevision: retirement.admissionRevision,
  };
  if (
    (target.profileId !== null && (typeof target.profileId !== "string" || !target.profileId)) ||
    !Number.isSafeInteger(target.admissionRevision) ||
    target.admissionRevision < 1 ||
    target.admissionRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      "Member retirement requires its bound admission revision and accounting profile.",
    );
  }
  const expected = { ...input, ...target };
  const lease = protectedAutomationStorageLeases.reserve([
    JSON.stringify([context.admission.databasePath, "member-removal", input.id]),
  ]);
  if (!lease) {
    throw new Error("Protected member removal could not retain its native identity.");
  }
  const native: {
    admission?: ReturnType<typeof ownerMutationAdmission>["admission"];
    retained?: RetainedWorkerTransactionAdmission;
  } = {};
  let enrollment: ReturnType<typeof retirement.enrollPublication> | undefined;
  let handedOff = false;
  let started = false;
  let settled = false;
  let chargedRetired = false;
  let published = false;
  let policyNotified = false;
  const assertControl = () => {
    assertOwnerCurrent();
    retirement.assertWritersStopped(target.profileId);
  };
  const verifyReceipt = (facts: unknown) =>
    Boolean(readProtectedAutomationRetirementReceipt(facts, expected));
  const settleStorage = () => {
    const receipt = readProtectedAutomationRetirementReceipt(
      native.admission?.committed?.facts,
      expected,
    );
    if (!receipt) {
      throw new Error("Member removal requires its atomic automation retirement receipt.");
    }
    if (!chargedRetired) {
      retirement.retireStorage(receipt.retiredStoredData);
      chargedRetired = true;
    }
    if (!published) {
      onRemovalCommitted(receipt.subject, receipt.profileId, receipt.retiredAutomations);
      published = true;
    }
    if (!policyNotified) {
      onPolicyChanged();
      policyNotified = true;
    }
    settled = true;
  };
  const retain = () => {
    if (!native.admission || !native.retained) {
      return false;
    }
    retirement.retainUncertainRemovalCommit({
      admission: native.admission,
      retained: native.retained,
      lease,
      verifyReceipt,
      settleStorage,
      releaseStorage: () => {},
    });
    handedOff = true;
    return true;
  };
  try {
    enrollment = retirement.enrollPublication();
    await lease.wait();
    await retirement.revalidate();
    assertControl();
    const nativeInput = {
      ...input,
      now: Date.now(),
      retireAutomationStorage: true as const,
      expectedProfileId: target.profileId,
      expectedRevision: target.admissionRevision,
    };
    const removalFacts: ProtectedAdmissionAutomationRetirementFacts = {
      kind: "protected-member-automation-retirement",
      id: input.id,
      issuer: input.issuer,
      ownerSubject: input.ownerSubject,
      now: nativeInput.now,
      expectedProfileId: target.profileId,
      expectedRevision: target.admissionRevision,
    };
    started = true;
    const outcome = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "protectedAccess.removeAdmission",
          input: nativeInput,
        }),
      {
        assertCurrent: assertControl,
        createAdmission: (operation) => {
          native.retained = operation;
          const created = ownerMutationAdmission(
            context,
            "removed",
            assertControl,
            onRemovalCommitted,
            onPolicyChanged,
            () => {
              assertControl();
              settleStorage();
            },
            removalFacts,
          );
          native.admission = created.admission;
          return created;
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!native.admission || !native.retained) {
      started = false;
      if (!outcome.ok) {
        throw outcome.error;
      }
      throw new Error("Member removal completed without native admission.");
    }
    const result = await native.retained.settled;
    const stopped =
      result.kind !== "unknown" ||
      result.nativeStopped === true ||
      native.admission.settlement?.kind === "completed";
    if (settled && stopped) {
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    }
    if (
      result.kind === "not-entered" ||
      (result.kind === "completed" &&
        native.admission.settlement?.kind === "completed" &&
        !native.admission.committed)
    ) {
      started = false;
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    }
    retain();
    throw new SqliteWorkerError(
      "Member removal requires storage reconciliation",
      "outcome-unknown",
    );
  } finally {
    if (!handedOff && started && !settled) {
      retain();
    }
    if (!handedOff) {
      lease.release();
    }
    enrollment?.finish(handedOff ? "recovery-required" : "settled");
  }
}

export function migrateProtectedSubjects(
  stateDir: string,
  input: { subjects: readonly string[]; issuer: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.migrate",
    input: { ...input, now: Date.now() },
  });
}

export function addProtectedSubject(stateDir: string, input: { issuer: string; subject: string }) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.addSubject",
    input: { ...input, now: Date.now() },
  });
}

export function bindProtectedAdmission(
  stateDir: string,
  input: { issuer: string; email: string; subject: string },
  assertCurrent: () => void,
  onCommitted: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const assertIdentityCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "protectedAccess.bind", input: { ...input, now: Date.now() } }),
    {
      assertCurrent: assertIdentityCurrent,
      createAdmission: () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          assertIdentityCurrent();
          if (request.facts !== input.subject) {
            throw new Error("Identity binding lost its authority.");
          }
          grant();
        });
        observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
          if (!isRecord(facts) || facts.subject !== input.subject) {
            throw new Error("Identity binding committed with invalid publication facts.");
          }
          onCommitted();
        });
        return { nativeLocations: [context.admission.databasePath], admission };
      },
    },
  );
}

export function listProtectedAdmissions(stateDir: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.listAdmissions",
    input: undefined,
  });
}

export function isProtectedAdmissionCurrent(
  stateDir: string,
  input: { id: string; profileId: string; issuer: string; subject: string; revision: number },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.isAdmissionCurrent",
    input,
  });
}

export function listPendingProtectedPolicy(stateDir: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.listPendingPolicy",
    input: undefined,
  });
}

export function beginProtectedPolicy(
  stateDir: string,
  input: { id: string; email: string; revision: number },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.beginPolicy",
    input,
  });
}

export function settleProtectedPolicy(
  stateDir: string,
  input: { id: string; email: string; revision: number; state: "synced" | "failed" | "unknown" },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.settlePolicy",
    input,
  });
}

export function retryProtectedPolicy(
  stateDir: string,
  input: { id: string; issuer: string },
  assertCurrent: () => void,
  onPolicyChanged: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAccess.retryPolicy", input }),
    {
      assertCurrent: assertOwnerCurrent,
      createAdmission: () =>
        ownerMutationAdmission(
          context,
          "retry_policy",
          assertOwnerCurrent,
          () => {},
          onPolicyChanged,
        ),
    },
  );
}

export function bindProtectedProfile(
  stateDir: string,
  input: { issuer: string; subject: string; profileId: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.bindProfile",
    input: { ...input, now: Date.now() },
  });
}

export function readProtectedStorageLimit(
  stateDir: string,
  input: { id: string; issuer: string; ownerSubject: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.storageLimit.read",
    input,
  });
}

export function readProtectedProfileStorageLimit(
  stateDir: string,
  input: { profileId: string; issuer: string },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedAccess.storageLimit.forProfile",
    input,
  });
}

export function setProtectedStorageLimit(
  stateDir: string,
  input: {
    id: string;
    issuer: string;
    ownerSubject: string;
    expectedLimitBytes: number | null;
    limitBytes: number | null;
  },
  assertCurrent: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "protectedAccess.storageLimit.set",
        input: { ...input, now: Date.now() },
      }),
    {
      assertCurrent: assertOwnerCurrent,
      createAdmission: () => {
        // Recheck the owner's live grant at the transaction and commit boundaries.
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          assertOwnerCurrent();
          if (request.facts !== "storage_limit") {
            throw new Error("Storage limit mutation lost its authority.");
          }
          grant();
        });
        return { nativeLocations: [context.admission.databasePath], admission };
      },
    },
  );
}
