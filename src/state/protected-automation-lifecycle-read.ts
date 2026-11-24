import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import { readProtectedAutomationLifecycleForOwner } from "./protected-automation-lifecycle-access.js";
import { admit, typed, runRows, chatRow } from "./protected-automation-lifecycle.js";
import type {
  ProtectedAutomationLifecycleAccess,
  ProtectedAutomationLifecycleRun,
  ProtectedAutomationOwnerInboxEntry,
} from "./protected-automation-lifecycle.types.js";
import { readProtectedAutomationCheck } from "./protected-automation-pacing.js";
import { isOwner } from "./protected-automation-results.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";
import { readProtectedAutomation } from "./protected-automations.js";
import { readProtectedAutomationFollowerGrant } from "./protected-automation-sharing.js";

function dto(
  row: ReturnType<typeof runRows>[number],
  chatId: string | null,
): ProtectedAutomationLifecycleRun {
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

export function readProtectedAutomationLifecycle(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
): ProtectedAutomationLifecycleRun[] | undefined {
  admit(database);
  if (!isOwner(database, input.profileId, input.automationId)) {
    return undefined;
  }
  const chat = chatRow(database, input.automationId);
  return runRows(database, input.automationId)
    .slice(0, 50)
    .filter((row) => row.profile_id === input.profileId)
    .map((row) => dto(row, chat?.chat_id ?? null));
}

export function readProtectedIsolatedAutomationRunChat(
  database: OpenClawStateDatabase,
  input: { profileId: string; chatId: string },
): boolean {
  admit(database);
  const origin = executeSqliteQuerySync(
    database.db,
    typed(database.db)
      .selectFrom("protected_automation_run_chats as chat")
      .innerJoin(
        "protected_automation_run_lifecycle as run",
        "run.automation_id",
        "chat.automation_id",
      )
      .select(["chat.automation_id as automationId"])
      .where("chat.profile_id", "=", input.profileId)
      .where("chat.chat_id", "=", input.chatId)
      .whereRef("run.profile_id", "=", "chat.profile_id")
      .limit(1),
  ).rows[0];
  if (!origin || !isOwner(database, input.profileId, origin.automationId)) {
    return false;
  }
  const automation = readProtectedAutomation(database, {
    profileId: input.profileId,
    automationId: origin.automationId,
  });
  return (
    automation?.relation === "owner" &&
    automation.centralOwnerProfileId === input.profileId &&
    automation.definition.contextAccess === "isolated"
  );
}

export function readProtectedAutomationOwnerInbox(
  database: OpenClawStateDatabase,
  input: { profileId: string },
): ProtectedAutomationOwnerInboxEntry[] {
  admit(database);
  const rows = executeSqliteQuerySync(
    database.db,
    typed(database.db)
      .selectFrom("protected_automation_owner_inbox as inbox")
      .innerJoin("protected_automation_run_lifecycle as run", "run.id", "inbox.run_id")
      .innerJoin("protected_automation_runs as result", "result.id", "inbox.result_id")
      .select([
        "inbox.run_id as runId",
        "inbox.automation_id as automationId",
        "inbox.result_id as resultId",
        "inbox.created_at_ms as createdAtMs",
        "run.profile_id as ownerProfileId",
      ])
      .where("inbox.profile_id", "=", input.profileId)
      .where("run.status", "=", "succeeded")
      .whereRef("result.central_owner_profile_id", "=", "run.profile_id")
      .whereRef("run.automation_id", "=", "inbox.automation_id")
      .whereRef("run.result_id", "=", "inbox.result_id")
      .whereRef("result.automation_id", "=", "inbox.automation_id")
      .orderBy("inbox.sequence", "desc")
      .limit(200),
  ).rows;
  // A member's own receipts are visible while they own the automation or follow it as a current
  // member of its published audience; leaving or revocation hides them at once.
  const authorized = new Map<string, string | undefined>();
  return rows
    .filter((row) => {
      if (!authorized.has(row.automationId)) {
        authorized.set(
          row.automationId,
          isOwner(database, input.profileId, row.automationId)
            ? input.profileId
            : readProtectedAutomationFollowerGrant(database, {
                profileId: input.profileId,
                automationId: row.automationId,
              })?.ownerProfileId,
        );
      }
      return authorized.get(row.automationId) === row.ownerProfileId;
    })
    .map(({ ownerProfileId: _owner, ...entry }) => entry);
}

/** The cadence cursor is queue time, not the missed scheduled deadline or Run now. */
export function readProtectedAutomationLastScheduledAttempt(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
) {
  admit(database);
  if (!isOwner(database, input.profileId, input.automationId)) {
    return undefined;
  }
  const chat = chatRow(database, input.automationId);
  const row = executeSqliteQuerySync(
    database.db,
    typed(database.db)
      .selectFrom("protected_automation_run_lifecycle")
      .selectAll()
      .where("automation_id", "=", input.automationId)
      .where("profile_id", "=", input.profileId)
      .where("trigger", "=", "scheduled")
      .orderBy("queued_at_ms", "desc")
      .orderBy("sequence", "desc")
      .limit(1),
  ).rows[0];
  const check = readProtectedAutomationCheck(chat);
  return {
    ...(check ? { check } : {}),
    scheduledAtMs: chat?.last_scheduled_at_ms ?? null,
    run:
      row && chat && row.queued_at_ms === chat.last_scheduled_at_ms ? dto(row, chat.chat_id) : null,
  };
}

export function readProtectedAutomationInterruptedRun(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    automationId: string;
    access: Extract<ProtectedAutomationLifecycleAccess, { kind: "owner" }>;
  },
) {
  admit(database);
  if (!readProtectedAutomationLifecycleForOwner(database, input, input.access)) {
    return undefined;
  }
  const row = runRows(database, input.automationId).find(
    (run) =>
      run.profile_id === input.profileId && (run.status === "queued" || run.status === "running"),
  );
  return row
    ? { runId: row.id, queuedAtMs: row.queued_at_ms, startedAtMs: row.started_at_ms }
    : null;
}

export function readProtectedAutomationRunChat(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
): { runChatId: string | null } | undefined {
  admit(database);
  if (!isOwner(database, input.profileId, input.automationId)) {
    return undefined;
  }
  return { runChatId: chatRow(database, input.automationId)?.chat_id ?? null };
}

/** Zero-charge pool rows are already funded by the retained chat/capacity entry. */
export function readProtectedAutomationLifecycleStorageUsage(
  database: OpenClawStateDatabase,
): ProtectedAutomationResultStorageEntry[] {
  admit(database);
  const k = typed(database.db);
  const runs = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_run_lifecycle")
      .select(["id", "profile_id as profileId", "charged_bytes as bytes"])
      .where("charged_bytes", ">", 0),
  ).rows;
  const chats = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_run_chats")
      .select(["automation_id as id", "profile_id as profileId", "charged_bytes as bytes"]),
  ).rows;
  const inbox = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_owner_inbox")
      .select(["run_id as id", "profile_id as profileId", "charged_bytes as bytes"]),
  ).rows;
  return [
    ...runs.map((entry) =>
      Object.assign(entry, { id: `protected-automation-lifecycle:${entry.id}` }),
    ),
    ...chats.map((entry) => Object.assign(entry, { id: `protected-automation-chat:${entry.id}` })),
    ...inbox.map((entry) => Object.assign(entry, { id: `protected-automation-inbox:${entry.id}` })),
  ];
}
