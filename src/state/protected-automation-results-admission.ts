import { isDeepStrictEqual } from "node:util";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  ProtectedAutomationResultAdmission,
  ProtectedAutomationResultSealedWrite,
  ProtectedAutomationResultStorageEntry,
} from "./protected-automation-results.types.js";

export type ProtectedAutomationResultWriteFacts = {
  kind: "protected-automation-result";
  input: ProtectedAutomationResultSealedWrite;
  reservedBytes: number;
  entries: ProtectedAutomationResultStorageEntry[];
};

/** Binds one exact write to the worker transaction and commit stages, then to live authority. */
export function prepareProtectedAutomationResultWriteAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedAutomationResultSealedWrite,
  reservedBytes: number,
  entries: ProtectedAutomationResultStorageEntry[],
  authority: ProtectedAutomationResultAdmission,
): {
  facts: ProtectedAutomationResultWriteFacts;
  createAdmission: SqliteWorkerAdmissionFactory;
  getAdmission: () => SqliteWorkerOperationAdmission | undefined;
  getRetained: () => RetainedWorkerTransactionAdmission | undefined;
} {
  if (input.centralOwnerProfileId !== authority.profileId) {
    throw new Error("Protected automation result owner does not match its authority.");
  }
  const expected: ProtectedAutomationResultWriteFacts = structuredClone({
    kind: "protected-automation-result",
    input,
    reservedBytes,
    entries,
  });
  let admission: SqliteWorkerOperationAdmission | undefined;
  let retained: RetainedWorkerTransactionAdmission | undefined;
  return {
    facts: structuredClone(expected),
    createAdmission: (operation) => {
      retained = operation;
      admission = createSqliteWorkerOperationAdmission((request, grant) => {
        if (
          (request.stage !== "transaction" && request.stage !== "commit") ||
          !isDeepStrictEqual(request.facts, expected)
        ) {
          throw new Error("Protected automation result requires exact write admission.");
        }
        context.admission.assertCurrent();
        authority.assertCurrent();
        if (!grant()) {
          throw new Error("Protected automation result write admission was not granted.");
        }
      });
      return { admission, nativeLocations: [context.admission.databasePath] };
    },
    getAdmission: () => admission,
    getRetained: () => retained,
  };
}
