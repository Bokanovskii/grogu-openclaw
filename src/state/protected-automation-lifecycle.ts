import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Generated, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import {
  readProtectedAutomationLifecycleAuthority,
  isProtectedAutomationLifecycleMemberActive,
} from "./protected-automation-lifecycle-access.js";
import { prepareProtectedAutomationLifecycleRetirements } from "./protected-automation-lifecycle-retention.js";
import type {
  ProtectedAutomationLifecycleCommand,
  ProtectedAutomationLifecycleAccess,
  ProtectedAutomationLifecycleReceipt,
  ProtectedAutomationLifecycleRun,
  ProtectedAutomationLifecycleWrite,
  ProtectedAutomationRunError,
  ProtectedAutomationRunStatus,
} from "./protected-automation-lifecycle.types.js";
import {
  admitResults,
  type ProtectedAutomationResultDatabase,
} from "./protected-automation-results.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";

export type ProtectedAutomationLifecycleDatabase = ProtectedAutomationResultDatabase & {
  protected_automation_run_chats: {
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
type RunRow = Selectable<
  ProtectedAutomationLifecycleDatabase["protected_automation_run_lifecycle"]
>;

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_automation_run_chats",
  additionalTables: ["protected_automation_run_lifecycle", "protected_automation_owner_inbox"],
  indexes: [
    "idx_protected_automation_lifecycle_history",
    "idx_protected_automation_lifecycle_scheduled",
    "idx_protected_automation_lifecycle_active",
    "idx_protected_automation_owner_inbox_recipient",
  ],
  endMarker: "  ON protected_automation_owner_inbox(profile_id, sequence DESC);\n",
  operationLabel: "protected.automationLifecycle.schema",
});

export function typed(db: DatabaseSync) {
  return getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(db);
}
export function admit(database: OpenClawStateDatabase) {
  admitResults(database);
  ensureSchema({ database, path: database.path });
}
function boundedId(value: string) {
  if (typeof value !== "string" || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 128) {
    throw new Error("Protected automation reference must be between 1 and 128 bytes.");
  }
}
function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Protected automation timestamp is invalid.");
  }
}
export function runRows(database: OpenClawStateDatabase, automationId: string) {
  return executeSqliteQuerySync(
    database.db,
    typed(database.db)
      .selectFrom("protected_automation_run_lifecycle")
      .selectAll()
      .where("automation_id", "=", automationId)
      .orderBy("sequence", "desc"),
  ).rows;
}
export function chatRow(database: OpenClawStateDatabase, automationId: string) {
  return executeSqliteQuerySync(
    database.db,
    typed(database.db)
      .selectFrom("protected_automation_run_chats")
      .selectAll()
      .where("automation_id", "=", automationId),
  ).rows[0];
}
export function dto(row: RunRow, chatId: string | null): ProtectedAutomationLifecycleRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    profileId: row.profile_id,
    definitionRevision: row.definition_revision,
    trigger: row.trigger,
    scheduledAtMs: row.scheduled_at_ms,
    queuedAtMs: row.queued_at_ms,
    status: row.status,
    runChatId: chatId,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    errorCode: row.error_code,
    resultId: row.result_id,
    delivery:
      row.status === "succeeded" ? (row.delivered_at_ms === null ? "pending" : "delivered") : null,
  };
}

export type PrepareProtectedAutomationLifecycleOutcome =
  | {
      status:
        | "not-owner"
        | "conflict"
        | "busy"
        | "disabled"
        | "definition-changed"
        | "result-missing";
    }
  | { status: "unchanged" }
  | { status: "not-provisioned" }
  | { status: "prepared"; write: ProtectedAutomationLifecycleWrite };

/** Exact allocation and retirement plan; the commit owner recomputes it under the write lock. */
export function prepareProtectedAutomationLifecycle(
  database: OpenClawStateDatabase,
  input: {
    command: ProtectedAutomationLifecycleCommand;
    entryOverheadBytes: number;
    access?: ProtectedAutomationLifecycleAccess;
  },
): PrepareProtectedAutomationLifecycleOutcome {
  const { command, entryOverheadBytes } = input;
  boundedId(command.profileId);
  boundedId(command.automationId);
  if (!Number.isSafeInteger(entryOverheadBytes) || entryOverheadBytes < 0) {
    throw new Error("Protected automation entry overhead is invalid.");
  }
  if (command.kind !== "delete" && command.kind !== "provision") {
    boundedId(command.runId);
    timestamp(command.now);
  }
  admit(database);
  const access = input.access ?? { kind: "member" };
  const automation = readProtectedAutomationLifecycleAuthority(database, command, access);
  if (!automation) {
    return { status: "not-owner" };
  }
  const rows = runRows(database, command.automationId);
  if (rows.some((row) => row.profile_id !== command.profileId)) {
    throw new Error("Protected automation lifecycle has a different accounting owner.");
  }
  const chat = chatRow(database, command.automationId);
  if (chat && chat.profile_id !== command.profileId) {
    throw new Error("Protected automation chat binding has a different accounting owner.");
  }
  const write: ProtectedAutomationLifecycleWrite = {
    kind: "protected-automation-lifecycle-write",
    command: structuredClone(command),
    access: structuredClone(access),
    entryOverheadBytes,
    entries: [],
    retired: [],
    pruneRunIds: [],
    pruneResultIds: [],
    pruneInboxRunIds: [],
  };
  const entry = (id: string, bytes: number): ProtectedAutomationResultStorageEntry => ({
    id,
    profileId: command.profileId,
    bytes: entryOverheadBytes + bytes,
  });
  const capacityBytes = 50 * (entryOverheadBytes + 1024);
  if (!Number.isSafeInteger(capacityBytes)) {
    throw new Error("Protected automation metadata capacity is invalid.");
  }
  if (command.kind === "provision") {
    const charged = rows
      .filter((row) => row.charged_bytes > 0)
      .map((row) => ({
        id: `protected-automation-lifecycle:${row.id}`,
        profileId: row.profile_id,
        bytes: row.charged_bytes,
      }));
    if (chat?.reserved_run_bytes === capacityBytes && charged.length === 0) {
      return { status: "unchanged" };
    }
    if (chat?.reserved_run_bytes && chat.reserved_run_bytes !== capacityBytes) {
      throw new Error("Protected automation metadata capacity needs an explicit migration.");
    }
    const current = entry(`protected-automation-chat:${command.automationId}`, 512 + capacityBytes);
    write.entries.push(current);
    const previous = [
      ...(chat
        ? [
            {
              id: current.id,
              profileId: chat.profile_id,
              bytes: chat.charged_bytes,
            },
          ]
        : []),
      ...charged,
    ];
    if (previous.length) {
      write.replacement = { previous, current: [current] };
    }
    write.retired.push(...charged);
  } else if (command.kind === "queue" || command.kind === "refuse") {
    if (chat?.reserved_run_bytes !== capacityBytes) {
      return { status: "not-provisioned" };
    }
    if (
      command.kind === "refuse" &&
      command.errorCode === "member_inactive" &&
      (access.kind !== "owner" ||
        isProtectedAutomationLifecycleMemberActive(database, command.profileId, access.issuer))
    ) {
      return { status: "not-owner" };
    }
    timestamp(command.scheduledAtMs);
    if (!Number.isSafeInteger(command.definitionRevision) || command.definitionRevision < 1) {
      throw new Error("Protected automation revision is invalid.");
    }
    if (command.trigger !== "manual" && command.trigger !== "scheduled") {
      throw new Error("Protected automation trigger is invalid.");
    }
    const existing = rows.find((row) => row.id === command.runId);
    if (existing) {
      return {
        status:
          existing.profile_id === command.profileId &&
          existing.definition_revision === command.definitionRevision &&
          existing.trigger === command.trigger &&
          existing.scheduled_at_ms === command.scheduledAtMs &&
          existing.queued_at_ms === command.now &&
          (command.kind === "queue" ||
            (existing.status === "skipped" && existing.error_code === command.errorCode))
            ? "unchanged"
            : "conflict",
      };
    }
    if (automation.definitionRevision !== command.definitionRevision) {
      return { status: "definition-changed" };
    }
    if (!automation.enabled) {
      return { status: "disabled" };
    }
    if (
      command.kind === "queue" &&
      rows.some((row) => row.status === "queued" || row.status === "running")
    ) {
      return { status: "busy" };
    }
  } else if (command.kind === "delete") {
    if (rows.some((row) => row.status === "queued" || row.status === "running")) {
      return { status: "busy" };
    }
    write.pruneRunIds = rows.map((row) => row.id);
  } else {
    const row = rows.find((retained) => retained.id === command.runId);
    if (!row || row.profile_id !== command.profileId) {
      return { status: "conflict" };
    }
    if (command.kind === "start") {
      boundedId(command.chatId);
      if (row.status === "running") {
        return {
          status:
            chat?.chat_id === command.chatId && row.started_at_ms === command.now
              ? "unchanged"
              : "conflict",
        };
      }
      if (row.status !== "queued" || command.now < row.queued_at_ms) {
        return { status: "conflict" };
      }
      if (!automation.enabled) {
        return { status: "disabled" };
      }
      if (automation.definitionRevision !== row.definition_revision) {
        return { status: "definition-changed" };
      }
      if (!chat || (chat.chat_id !== null && chat.chat_id !== command.chatId)) {
        return { status: "conflict" };
      }
    } else if (command.kind === "finish") {
      if (
        command.outcome.status !== "succeeded" &&
        command.outcome.errorCode === "member_inactive" &&
        isProtectedAutomationLifecycleMemberActive(
          database,
          command.profileId,
          access.kind === "owner" ? access.issuer : undefined,
        )
      ) {
        return { status: "conflict" };
      }
      if (command.now < (row.started_at_ms ?? row.queued_at_ms)) {
        return { status: "conflict" };
      }
      const { outcome } = command;
      if (outcome.status === "succeeded") {
        boundedId(outcome.resultId);
        if (!matchingResult(database, row, outcome.resultId)) {
          return { status: "result-missing" };
        }
      } else if (
        ![
          "interrupted",
          "member_inactive",
          "automation_disabled",
          "definition_changed",
          "quota_exceeded",
          "provider_timeout",
          "provider_busy",
          "provider_rejected",
          "provider_failed",
          "plan_limit",
          "model_unavailable",
          "chat_too_long",
          "turn_failed",
          "result_failed",
        ].includes(outcome.errorCode)
      ) {
        throw new Error("Protected automation error code is invalid.");
      }
      if (row.status !== "queued" && row.status !== "running") {
        return {
          status:
            row.status === outcome.status &&
            row.finished_at_ms === command.now &&
            row.result_id === (outcome.status === "succeeded" ? outcome.resultId : null) &&
            row.error_code === (outcome.status === "succeeded" ? null : outcome.errorCode)
              ? "unchanged"
              : "conflict",
        };
      }
      if (outcome.status === "succeeded" && row.status !== "running") {
        return { status: "conflict" };
      }
    } else {
      if (
        row.status !== "succeeded" ||
        !row.result_id ||
        !matchingResult(database, row, row.result_id)
      ) {
        return { status: "result-missing" };
      }
      if (row.delivered_at_ms !== null) {
        return { status: "unchanged" };
      }
      if (command.now < (row.finished_at_ms ?? row.queued_at_ms)) {
        return { status: "conflict" };
      }
      const inbox = executeSqliteQuerySync(
        database.db,
        typed(database.db)
          .selectFrom("protected_automation_owner_inbox")
          .selectAll()
          .where("profile_id", "=", command.profileId)
          .orderBy("sequence", "desc"),
      ).rows;
      write.pruneInboxRunIds = inbox.slice(199).map((retained) => retained.run_id);
      write.entries.push(entry(`protected-automation-inbox:${row.id}`, 640));
    }
  }
  prepareProtectedAutomationLifecycleRetirements(database, write, rows, chat);
  if (
    command.kind !== "delete" &&
    write.pruneRunIds.some((id) =>
      rows.some((row) => row.id === id && (row.status === "queued" || row.status === "running")),
    )
  ) {
    return { status: "busy" };
  }
  return { status: "prepared", write };
}

function matchingResult(database: OpenClawStateDatabase, row: RunRow, id: string) {
  const result = executeSqliteQuerySync(
    database.db,
    typed(database.db).selectFrom("protected_automation_runs").selectAll().where("id", "=", id),
  ).rows[0];
  return (
    result &&
    result.automation_id === row.automation_id &&
    result.central_owner_profile_id === row.profile_id &&
    result.native_run_id === row.id &&
    result.definition_revision === row.definition_revision &&
    result.run_at_ms === row.scheduled_at_ms
  );
}

export function commitProtectedAutomationLifecycle(
  database: OpenClawStateDatabase,
  write: ProtectedAutomationLifecycleWrite,
): { status: "committed" } {
  admit(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: write });
      const current = prepareProtectedAutomationLifecycle(database, write);
      if (current.status !== "prepared" || !isDeepStrictEqual(current.write, write)) {
        throw new Error(
          "Protected automation lifecycle plan changed; prepare again after settlement.",
        );
      }
      applyWrite(database, write);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: write });
      const receipt: ProtectedAutomationLifecycleReceipt = {
        kind: "protected-automation-lifecycle-committed",
        write,
      };
      deferSqliteWorkerCommitReceipt(db, receipt);
      return { status: "committed" as const };
    },
    { path: database.path },
    { operationLabel: "protected.automationLifecycle.commit" },
  );
}

function applyWrite(database: OpenClawStateDatabase, write: ProtectedAutomationLifecycleWrite) {
  const { db } = database;
  const k = typed(db);
  const { command } = write;
  if (write.pruneInboxRunIds.length) {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("protected_automation_owner_inbox")
        .where("profile_id", "=", command.profileId)
        .where("run_id", "in", write.pruneInboxRunIds),
    );
  }
  for (const removed of write.retired.filter((row) =>
    row.id.startsWith("protected-automation-run:"),
  )) {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("protected_automation_runs")
        .where("id", "=", removed.id.slice("protected-automation-run:".length)),
    );
  }
  if (write.pruneRunIds.length) {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("protected_automation_run_lifecycle")
        .where("automation_id", "=", command.automationId)
        .where("id", "in", write.pruneRunIds),
    );
  }
  if (command.kind === "delete") {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("protected_automation_run_chats")
        .where("automation_id", "=", command.automationId),
    );
  } else if (command.kind === "provision") {
    const [poolEntry] = write.entries;
    if (!poolEntry) {
      throw new Error("Protected automation has no reserved metadata pool.");
    }
    const capacity = 50 * (write.entryOverheadBytes + 1024);
    const chat = chatRow(database, command.automationId);
    if (!chat) {
      executeSqliteQuerySync(
        db,
        k.insertInto("protected_automation_run_chats").values({
          automation_id: command.automationId,
          profile_id: command.profileId,
          chat_id: null,
          charged_bytes: poolEntry.bytes,
          reserved_run_bytes: capacity,
          last_scheduled_at_ms: null,
        }),
      );
    } else {
      executeSqliteQuerySync(
        db,
        k
          .updateTable("protected_automation_run_chats")
          .set({ charged_bytes: poolEntry.bytes, reserved_run_bytes: capacity })
          .where("automation_id", "=", command.automationId),
      );
    }
    executeSqliteQuerySync(
      db,
      k
        .updateTable("protected_automation_run_lifecycle")
        .set({ charged_bytes: 0 })
        .where("automation_id", "=", command.automationId),
    );
  } else if (command.kind === "queue" || command.kind === "refuse") {
    executeSqliteQuerySync(
      db,
      k.insertInto("protected_automation_run_lifecycle").values({
        id: command.runId,
        automation_id: command.automationId,
        profile_id: command.profileId,
        definition_revision: command.definitionRevision,
        trigger: command.trigger,
        scheduled_at_ms: command.scheduledAtMs,
        queued_at_ms: command.now,
        status: command.kind === "refuse" ? "skipped" : "queued",
        started_at_ms: null,
        finished_at_ms: command.kind === "refuse" ? command.now : null,
        error_code: command.kind === "refuse" ? command.errorCode : null,
        result_id: null,
        delivered_at_ms: null,
        charged_bytes: 0,
      }),
    );
    if (command.trigger === "scheduled") {
      const previous = chatRow(database, command.automationId)?.last_scheduled_at_ms ?? 0;
      executeSqliteQuerySync(
        db,
        k
          .updateTable("protected_automation_run_chats")
          .set({ last_scheduled_at_ms: Math.max(previous, command.now) })
          .where("automation_id", "=", command.automationId),
      );
    }
  } else if (command.kind === "start") {
    executeSqliteQuerySync(
      db,
      k
        .updateTable("protected_automation_run_chats")
        .set({ chat_id: command.chatId })
        .where("automation_id", "=", command.automationId),
    );
    executeSqliteQuerySync(
      db,
      k
        .updateTable("protected_automation_run_lifecycle")
        .set({ status: "running", started_at_ms: command.now })
        .where("id", "=", command.runId),
    );
  } else if (command.kind === "finish") {
    executeSqliteQuerySync(
      db,
      k
        .updateTable("protected_automation_run_lifecycle")
        .set({
          status: command.outcome.status,
          finished_at_ms: command.now,
          result_id: command.outcome.status === "succeeded" ? command.outcome.resultId : null,
          error_code: command.outcome.status === "succeeded" ? null : command.outcome.errorCode,
        })
        .where("id", "=", command.runId),
    );
  } else {
    const row = runRows(database, command.automationId).find(
      (candidate) => candidate.id === command.runId,
    );
    const [inboxEntry] = write.entries;
    if (!row?.result_id || !inboxEntry) {
      throw new Error("Protected automation delivery has no committed result or capacity.");
    }
    executeSqliteQuerySync(
      db,
      k.insertInto("protected_automation_owner_inbox").values({
        run_id: row.id,
        automation_id: row.automation_id,
        profile_id: command.profileId,
        result_id: row.result_id,
        created_at_ms: command.now,
        charged_bytes: inboxEntry.bytes,
      }),
    );
    executeSqliteQuerySync(
      db,
      k
        .updateTable("protected_automation_run_lifecycle")
        .set({ delivered_at_ms: command.now })
        .where("id", "=", row.id),
    );
  }
}
