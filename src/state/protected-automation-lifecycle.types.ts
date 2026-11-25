import type { Generated } from "kysely";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import type { KeyedFifoLease } from "../shared/keyed-fifo-lease.js";
import type {
  ProtectedAutomationCheckColumns,
  ProtectedAutomationCheckDecision,
} from "./protected-automation-pacing.js";
import type { ProtectedAutomationResultDatabase } from "./protected-automation-results.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";
import type { ProtectedAutomationDatabase } from "./protected-automations.js";

export type ProtectedAutomationLifecycleDatabase = ProtectedAutomationResultDatabase &
  ProtectedAutomationDatabase & {
    protected_automation_run_chats: ProtectedAutomationCheckColumns & {
      automation_id: string;
      profile_id: string;
      chat_id: string | null;
      last_scheduled_at_ms: number | null;
      reserved_run_bytes: number;
      charged_bytes: number;
    };
    protected_automation_run_lifecycle: {
      sequence: Generated<number>;
      id: string;
      automation_id: string;
      profile_id: string;
      definition_revision: number;
      trigger: "scheduled" | "manual";
      scheduled_at_ms: number;
      queued_at_ms: number;
      status: ProtectedAutomationRunStatus;
      started_at_ms: number | null;
      finished_at_ms: number | null;
      error_code: ProtectedAutomationRunError | null;
      result_id: string | null;
      delivered_at_ms: number | null;
      charged_bytes: number;
    };
    protected_automation_owner_inbox: {
      sequence: Generated<number>;
      run_id: string;
      automation_id: string;
      profile_id: string;
      result_id: string;
      created_at_ms: number;
      charged_bytes: number;
    };
  };

export type ProtectedAutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";
export type ProtectedAutomationRunError =
  | "interrupted"
  | "member_inactive"
  | "automation_disabled"
  | "definition_changed"
  | "quota_exceeded"
  | "provider_timeout"
  | "provider_busy"
  | "provider_rejected"
  | "provider_failed"
  | "plan_limit"
  | "model_unavailable"
  | "chat_too_long"
  | "turn_failed"
  | "result_failed";

export type ProtectedAutomationLifecycleRun = {
  id: string;
  automationId: string;
  profileId: string;
  definitionRevision: number;
  trigger: "scheduled" | "manual";
  scheduledAtMs: number;
  queuedAtMs: number;
  status: ProtectedAutomationRunStatus;
  runChatId: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  errorCode: ProtectedAutomationRunError | null;
  resultId: string | null;
  delivery: "pending" | "delivered" | null;
};

export type ProtectedAutomationOwnerInboxEntry = {
  runId: string;
  automationId: string;
  resultId: string;
  createdAtMs: number;
};

export type ProtectedAutomationLifecycleCommand = {
  profileId: string;
  automationId: string;
} & (
  | { kind: "provision" }
  | {
      kind: "queue";
      runId: string;
      definitionRevision: number;
      contextAccess: "member" | "isolated";
      trigger: "scheduled" | "manual";
      scheduledAtMs: number;
      now: number;
    }
  | {
      kind: "refuse";
      runId: string;
      definitionRevision: number;
      trigger: "scheduled" | "manual";
      scheduledAtMs: number;
      now: number;
      errorCode: "quota_exceeded" | "member_inactive";
    }
  | { kind: "start"; runId: string; chatId: string; now: number }
  | {
      kind: "finish";
      runId: string;
      now: number;
      outcome:
        | { status: "succeeded"; resultId: string; proposedDelayMs?: number }
        | { status: "failed" | "skipped"; errorCode: ProtectedAutomationRunError };
    }
  | {
      kind: "deliver";
      runId: string;
      now: number;
      /** Followers whose own quota could not take the entry; the owner is never skipped. */
      skipRecipients?: string[];
    }
  | { kind: "delete" }
  | { kind: "remove"; expectedRevision: number }
);

export type ProtectedAutomationLifecycleAccess =
  | { kind: "member" }
  | { kind: "owner"; profileId: string; issuer: string; subject: string };

export type ProtectedAutomationLifecycleWrite = {
  kind: "protected-automation-lifecycle-write";
  command: ProtectedAutomationLifecycleCommand;
  access: ProtectedAutomationLifecycleAccess;
  entryOverheadBytes: number;
  entries: ProtectedAutomationResultStorageEntry[];
  retired: ProtectedAutomationResultStorageEntry[];
  pruneRunIds: string[];
  pruneResultIds: string[];
  pruneInbox: { profileId: string; runId: string }[];
  admission?: { definitionRevision: number; contextAccess: "member" | "isolated" };
  check?: ProtectedAutomationCheckDecision;
  retiredDefinition?: { id: string; profileId: string; definitionBytes: number };
  replacement?: {
    previous: ProtectedAutomationResultStorageEntry[];
    current: ProtectedAutomationResultStorageEntry[];
  };
};

export type ProtectedAutomationLifecycleReceipt = {
  kind: "protected-automation-lifecycle-committed";
  write: ProtectedAutomationLifecycleWrite;
};

export type ProtectedAutomationLifecycleUncertainCommit = {
  expectedReceipt: ProtectedAutomationLifecycleReceipt;
  lease: KeyedFifoLease;
  admission: SqliteWorkerOperationAdmission;
  retained: RetainedWorkerTransactionAdmission;
  storageSettlementAcknowledged: boolean;
  settleStorage(): void;
  releaseStorage(): void;
};

export type ProtectedAutomationLifecycleAuthority = {
  profileId: string;
  revalidate(): Promise<void>;
  assertCurrent(): void;
  enrollPublication(): { finish(outcome: "settled" | "recovery-required"): void };
  reserveStorage(bytes: number): Promise<{
    settle(result: { created: boolean; entries: ProtectedAutomationResultStorageEntry[] }): void;
    release(): void;
  }>;
  reserveReplacement(change: {
    previous: ProtectedAutomationResultStorageEntry;
    current: ProtectedAutomationResultStorageEntry;
  }): Promise<{
    settle(committed: ProtectedAutomationResultStorageEntry): void;
    release(rolledBack: ProtectedAutomationResultStorageEntry): void;
  }>;
  reserveBatchReplacement(change: {
    previous: ProtectedAutomationResultStorageEntry[];
    current: ProtectedAutomationResultStorageEntry[];
  }): Promise<{
    settle(committed: readonly ProtectedAutomationResultStorageEntry[]): void;
    release(rolledBack: readonly ProtectedAutomationResultStorageEntry[]): void;
  }>;
  /** Charges a follower's own inbox entry; undefined when that member cannot take it. */
  reserveRecipient(
    profileId: string,
    change: {
      previous?: ProtectedAutomationResultStorageEntry;
      current: ProtectedAutomationResultStorageEntry;
    },
  ): Promise<{ settle(): void; release(): void } | undefined>;
  retireStorage(entries: readonly ProtectedAutomationResultStorageEntry[]): void;
  retireDefinition?(entry: { id: string; profileId: string; definitionBytes: number }): void;
  retainUncertainCommit(handle: ProtectedAutomationLifecycleUncertainCommit): void;
};

/** Existing configured service-owner control; profileId is the accounting target, not the actor. */
export type ProtectedAutomationLifecycleOwnerAuthority = ProtectedAutomationLifecycleAuthority & {
  operator: Omit<Extract<ProtectedAutomationLifecycleAccess, { kind: "owner" }>, "kind">;
  assertOwnerCurrent(): void;
  /** Required for interruption/deletion, at both native transaction and commit admission. */
  assertRunStopped(automationId: string): void;
};

export type ProtectedAutomationRetirementUncertainCommit = {
  admission: SqliteWorkerOperationAdmission;
  retained: RetainedWorkerTransactionAdmission;
  lease: KeyedFifoLease;
  verifyReceipt(facts: unknown): boolean;
  settleStorage(): void;
  releaseStorage(): void;
};

export type ProtectedAutomationMemberRetirementAuthority = {
  profileId: string | null;
  admissionRevision: number;
  revalidate(): Promise<void>;
  assertWritersStopped(profileId: string | null): void;
  enrollPublication(): { finish(outcome: "settled" | "recovery-required"): void };
  retireStorage(entries: readonly ProtectedAutomationResultStorageEntry[]): void;
  retainUncertainRemovalCommit(handle: ProtectedAutomationRetirementUncertainCommit): void;
};
