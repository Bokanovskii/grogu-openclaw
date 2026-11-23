import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import type { KeyedFifoLease } from "../shared/keyed-fifo-lease.js";

/** Built by the native producer after the run and its transcript are durably persisted. */
export type PreparedProtectedAutomationFinishedResult = {
  automationId: string;
  definitionRevision: number;
  centralOwnerProfileId: string;
  jobId: string;
  runAtMs: number;
  runId: string;
  completedAtMs: number;
  automationName: string;
  privateFinalText: string;
  transcript: {
    sessionKey: string;
    sessionId: string;
  };
};

export type ProtectedAutomationResultSealedWrite = {
  id: string;
  version: string;
  automationId: string;
  definitionRevision: number;
  centralOwnerProfileId: string;
  jobId: string;
  runAtMs: number;
  runId: string;
  completedAtMs: number;
  payload: { value: string; storedBytes: number };
};

export type ProtectedAutomationResultStorageEntry = {
  id: string;
  profileId: string;
  bytes: number;
};

export type ProtectedAutomationResultStorageReservation = {
  settle(result: { created: boolean; entries: ProtectedAutomationResultStorageEntry[] }): void;
  release(): void;
};

export type ProtectedAutomationResultCommitReceipt = {
  kind: "protected-automation-result-committed";
  automationId: string;
  definitionRevision: number;
  centralOwnerProfileId: string;
  jobId: string;
  runAtMs: number;
  runId: string;
  id: string;
  version: string;
  entries: ProtectedAutomationResultStorageEntry[];
};

export type ProtectedAutomationResultUncertainCommit = {
  expectedReceipt: ProtectedAutomationResultCommitReceipt;
  reservation: ProtectedAutomationResultStorageReservation;
  reservationSettlementAcknowledged: boolean;
  lease: KeyedFifoLease;
  admission: SqliteWorkerOperationAdmission;
  retained: RetainedWorkerTransactionAdmission;
};

export type ProtectedAutomationResultPublicationOutcome = "settled" | "recovery-required";

/** Enrolled before any effect; the storage owner reports only its observed durable outcome. */
export type ProtectedAutomationResultPublicationEnrollment = {
  finish(outcome: ProtectedAutomationResultPublicationOutcome): void;
};

export type ProtectedAutomationResultAdmission = {
  profileId: string;
  revalidate(): Promise<void>;
  assertCurrent(): void;
  /** Throws once admission is closed; an already enrolled publication still runs to its outcome. */
  enrollPublication(): ProtectedAutomationResultPublicationEnrollment;
  reserveStorage(bytes: number): Promise<ProtectedAutomationResultStorageReservation>;
  retainUncertainCommit(handle: ProtectedAutomationResultUncertainCommit): void;
};
