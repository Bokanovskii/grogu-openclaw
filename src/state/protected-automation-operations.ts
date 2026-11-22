import { isDeepStrictEqual } from "node:util";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import type { ProtectedAutomationWorkerOperations } from "./protected-automations.worker.js";

export type ProtectedAutomationMutationAuthority = {
  profileId: string;
  assertCurrent: () => void;
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
  return (_operation) => ({
    admission: createSqliteWorkerOperationAdmission((request, grant) => {
      if (
        (request.stage !== "transaction" && request.stage !== "commit") ||
        !isDeepStrictEqual(request.facts, facts)
      ) {
        throw new Error("Protected automation mutation requires exact member admission.");
      }
      context.admission.assertCurrent();
      authority.assertCurrent();
      if (!grant()) {
        throw new Error("Protected automation mutation admission was not granted.");
      }
    }),
    nativeLocations: [context.admission.databasePath],
  });
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
