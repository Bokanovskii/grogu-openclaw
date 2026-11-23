import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../../src/infra/sqlite-worker-operation-admission.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedAutomationStorageUsage } from "../../src/state/protected-automations.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type { ProtectedAccessRequest } from "../../src/state/protected-admission.js";

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
) {
  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
    assertCurrent();
    if (request.facts !== status) {
      throw new Error("Access request mutation lost its authority.");
    }
    grant();
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
        type: "protectedAccess.removeAdmission",
        input: { ...input, now: Date.now() },
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
