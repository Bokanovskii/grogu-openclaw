import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import type {
  ProtectedAutomationCommittedBytes,
  ProtectedAutomationStoredBytes,
} from "./protected-automations.js";
import type { ProtectedAutomationWorkerOperations } from "./protected-automations.worker.js";

export type ProtectedAutomationMutationAuthority = {
  profileId: string;
  assertCurrent: () => void;
  admitStorage?: (facts: ProtectedAutomationStoredBytes) => void;
  onStorageCommitted?: (facts: ProtectedAutomationCommittedBytes) => void;
  onStorageAborted?: (facts: ProtectedAutomationStoredBytes) => void;
};

function assertMutationProfile(profileId: string, authority: ProtectedAutomationMutationAuthority) {
  if (profileId !== authority.profileId) {
    throw new Error("Protected automation mutation profile does not match its authority.");
  }
}

function createMutationAdmission(
  context: OpenClawStateWorkerContext,
  authority: ProtectedAutomationMutationAuthority,
  facts: Record<string, unknown>,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    let admittedStorage: ProtectedAutomationStoredBytes | undefined;
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      context.admission.assertCurrent();
      authority.assertCurrent();
      if (request.stage !== "transaction" && request.stage !== "commit") {
        throw new Error("Protected automation mutation requires exact member admission.");
      }
      if (isDeepStrictEqual(request.facts, facts)) {
        if (
          request.stage === "commit" &&
          (facts.action === "create" || facts.action === "patch") &&
          !admittedStorage
        ) {
          throw new Error("Protected automation commit requires stored-size admission.");
        }
        if (!grant()) {
          throw new Error("Protected automation mutation admission was not granted.");
        }
        return;
      }
      if (
        request.stage !== "transaction" ||
        admittedStorage ||
        !isRecord(request.facts) ||
        !isRecord(request.facts.storage)
      ) {
        throw new Error("Protected automation storage requires exact member admission.");
      }
      const { storage, ...baseFacts } = request.facts;
      const { automationId, currentStoredBytes, nextStoredBytes } = storage;
      if (
        !isDeepStrictEqual(baseFacts, facts) ||
        (facts.action !== "create" && facts.action !== "patch") ||
        typeof automationId !== "string" ||
        !automationId ||
        (facts.action === "patch" && automationId !== facts.automationId) ||
        typeof currentStoredBytes !== "number" ||
        !Number.isSafeInteger(currentStoredBytes) ||
        currentStoredBytes < 0 ||
        (facts.action === "create" && currentStoredBytes !== 0) ||
        typeof nextStoredBytes !== "number" ||
        !Number.isSafeInteger(nextStoredBytes) ||
        nextStoredBytes < 0 ||
        !isDeepStrictEqual(storage, { automationId, currentStoredBytes, nextStoredBytes })
      ) {
        throw new Error("Protected automation storage facts are invalid.");
      }
      const capturedStorage = { automationId, currentStoredBytes, nextStoredBytes };
      if (
        !grant(() => {
          authority.admitStorage?.(capturedStorage);
          admittedStorage = capturedStorage;
        })
      ) {
        throw new Error("Protected automation mutation admission was not granted.");
      }
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts: committed }) => {
      if (facts.action !== "create" && facts.action !== "patch") {
        return;
      }
      if (!isRecord(committed) || !isRecord(committed.storage) || !admittedStorage) {
        throw new Error("Protected automation commit is missing storage facts.");
      }
      const { storage, ...baseFacts } = committed;
      const { committedStoredBytes, ...storedBytes } = storage;
      if (
        !isDeepStrictEqual(baseFacts, facts) ||
        !isDeepStrictEqual(storedBytes, admittedStorage) ||
        typeof committedStoredBytes !== "number" ||
        committedStoredBytes !== admittedStorage.nextStoredBytes
      ) {
        throw new Error("Protected automation commit has invalid storage facts.");
      }
      authority.onStorageCommitted?.({ ...admittedStorage, committedStoredBytes });
    });
    void operation.settled.then((outcome) => {
      if (outcome.kind !== "unknown" && admittedStorage && !admission.committed) {
        authority.onStorageAborted?.(admittedStorage);
      }
    });
    return { admission, nativeLocations: [context.admission.databasePath] };
  };
}

export function createProtectedAutomationWithAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedAutomationWorkerOperations["protectedAutomations.create"]["input"],
  authority: ProtectedAutomationMutationAuthority,
) {
  const captured = structuredClone(input);
  assertMutationProfile(captured.profileId, authority);
  const facts = {
    kind: "protected-automation",
    action: "create",
    profileId: captured.profileId,
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomations.create", input: captured }),
    {
      assertCurrent: () => authority.assertCurrent(),
      createAdmission: createMutationAdmission(context, authority, facts),
    },
  );
}

export function bindProtectedAutomationJobWithAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedAutomationWorkerOperations["protectedAutomations.bindJob"]["input"],
  authority: ProtectedAutomationMutationAuthority,
) {
  const captured = structuredClone(input);
  assertMutationProfile(captured.profileId, authority);
  const facts = {
    kind: "protected-automation",
    action: "bind-job",
    profileId: captured.profileId,
    automationId: captured.automationId,
    jobId: captured.jobId,
    definitionRevision: captured.definitionRevision,
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomations.bindJob", input: captured }),
    {
      assertCurrent: () => authority.assertCurrent(),
      createAdmission: createMutationAdmission(context, authority, facts),
    },
  );
}

export function patchProtectedAutomationWithAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedAutomationWorkerOperations["protectedAutomations.patch"]["input"],
  authority: ProtectedAutomationMutationAuthority,
) {
  const captured = structuredClone(input);
  assertMutationProfile(captured.profileId, authority);
  const facts = {
    kind: "protected-automation",
    action: "patch",
    profileId: captured.profileId,
    automationId: captured.automationId,
    expectedRevision: captured.expectedRevision,
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomations.patch", input: captured }),
    {
      assertCurrent: () => authority.assertCurrent(),
      createAdmission: createMutationAdmission(context, authority, facts),
    },
  );
}
