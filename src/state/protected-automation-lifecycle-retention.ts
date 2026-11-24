import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import type { ProtectedAutomationLifecycleDatabase } from "./protected-automation-lifecycle.js";
import type { ProtectedAutomationLifecycleWrite } from "./protected-automation-lifecycle.types.js";
import { listProtectedAutomationInboxRecipients } from "./protected-automation-sharing.js";
import {
  readProtectedAutomation,
  type ProtectedAutomationDatabase,
} from "./protected-automations.js";

export function isolatedAutomationHasActiveRun(
  db: DatabaseSync,
  automationId: string,
  definition: ProtectedAutomationDraft,
): boolean {
  if (definition.contextAccess !== "isolated") {
    return false;
  }
  const tables = getAdmittedSqliteSchemaFacts(db)?.tables;
  if (!tables) {
    throw new Error("Protected automation edits require admitted schema facts.");
  }
  if (!tables.has("protected_automation_run_lifecycle")) {
    return false;
  }
  const lifecycle = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(db);
  return Boolean(
    executeSqliteQuerySync(
      db,
      lifecycle
        .selectFrom("protected_automation_run_lifecycle")
        .select("id")
        .where("automation_id", "=", automationId)
        .where("status", "in", ["queued", "running"])
        .limit(1),
    ).rows[0],
  );
}

export function assertIsolatedAutomationCreation(
  db: DatabaseSync,
  automationId: string,
  definition: ProtectedAutomationDraft,
): void {
  if (definition.contextAccess !== "isolated") {
    return;
  }
  const tables = getAdmittedSqliteSchemaFacts(db)?.tables;
  if (!tables) {
    throw new Error("Protected automation creation requires admitted schema facts.");
  }
  const history = getNodeSqliteKysely<
    ProtectedAutomationDatabase & ProtectedAutomationLifecycleDatabase
  >(db);
  for (const table of [
    "protected_automation_run_chats",
    "protected_automation_run_lifecycle",
    "protected_automation_runs",
  ] as const) {
    if (
      tables.has(table) &&
      executeSqliteQuerySync(
        db,
        history
          .selectFrom(table)
          .select("automation_id")
          .where("automation_id", "=", automationId)
          .limit(1),
      ).rows.length
    ) {
      throw new Error("Cannot create an isolated automation over retained run history.");
    }
  }
}

/** A new queue slot also retires legacy result-only history before another result can publish. */
export function prepareProtectedAutomationLifecycleRetirements(
  database: OpenClawStateDatabase,
  write: ProtectedAutomationLifecycleWrite,
  rows: Selectable<ProtectedAutomationLifecycleDatabase["protected_automation_run_lifecycle"]>[],
  chat:
    | Selectable<ProtectedAutomationLifecycleDatabase["protected_automation_run_chats"]>
    | undefined,
) {
  const { command } = write;
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(database.db);
  const allResults = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_runs")
      .selectAll()
      .where("automation_id", "=", command.automationId)
      .orderBy("sequence", "desc"),
  ).rows;
  if (command.kind === "queue" || command.kind === "refuse" || command.kind === "provision") {
    const active = new Set(
      rows
        .filter((row) => row.status === "queued" || row.status === "running")
        .map((row) => row.id),
    );
    const lifecycleIds = new Set(rows.map((row) => row.id));
    const history = [
      ...rows
        .filter((row) => !active.has(row.id))
        .map((row) => ({
          id: row.id,
          at: row.queued_at_ms,
          sequence: row.sequence,
        })),
      ...allResults
        .filter((row) => !lifecycleIds.has(row.native_run_id))
        .map((row) => ({
          id: row.native_run_id,
          at: row.completed_at_ms,
          sequence: row.sequence,
        })),
    ].toSorted((a, b) => b.at - a.at || b.sequence - a.sequence || a.id.localeCompare(b.id));
    const retained = new Set(active);
    const limit = command.kind === "provision" ? 50 : 49;
    for (const row of history) {
      if (retained.size >= limit) {
        break;
      }
      retained.add(row.id);
    }
    write.pruneRunIds = rows.filter((row) => !retained.has(row.id)).map((row) => row.id);
    write.pruneResultIds = allResults
      .filter((row) => !retained.has(row.native_run_id))
      .map((row) => row.id);
  }

  for (const row of rows.filter(
    (candidate) =>
      write.pruneRunIds.includes(candidate.id) &&
      candidate.charged_bytes > 0 &&
      !write.retired.some((entry) => entry.id === `protected-automation-lifecycle:${candidate.id}`),
  )) {
    write.retired.push({
      id: `protected-automation-lifecycle:${row.id}`,
      profileId: row.profile_id,
      bytes: row.charged_bytes,
    });
  }
  const results = allResults.filter(
    (row) =>
      command.kind === "delete" ||
      command.kind === "remove" ||
      write.pruneRunIds.includes(row.native_run_id) ||
      write.pruneResultIds.includes(row.id),
  );
  write.pruneResultIds = results.map((row) => row.id);
  for (const row of results) {
    if (row.central_owner_profile_id !== command.profileId) {
      throw new Error("Protected automation result has a different accounting owner.");
    }
    write.retired.push({
      id: `protected-automation-run:${row.id}`,
      profileId: row.central_owner_profile_id,
      bytes: row.charged_bytes,
    });
  }
  // An automation's retained history owns every recipient's receipt for it; each recipient also
  // owns the quota-eviction candidates in their own inbox.
  const evicted = new Set(write.pruneInbox.map((pruned) => pruned.profileId));
  const inbox = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_owner_inbox")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("automation_id", "=", command.automationId),
          eb("profile_id", "in", [command.profileId, ...evicted]),
        ]),
      )
      .orderBy("sequence"),
  ).rows.filter(
    (row) =>
      ((command.kind === "delete" || command.kind === "remove") &&
        row.automation_id === command.automationId) ||
      write.pruneInbox.some(
        (pruned) => pruned.profileId === row.profile_id && pruned.runId === row.run_id,
      ) ||
      write.pruneResultIds.includes(row.result_id) ||
      (row.automation_id === command.automationId && write.pruneRunIds.includes(row.run_id)),
  );
  write.pruneInbox = inbox.map((row) => ({ profileId: row.profile_id, runId: row.run_id }));
  for (const row of inbox) {
    write.retired.push({
      id: `protected-automation-inbox:${row.run_id}`,
      profileId: row.profile_id,
      bytes: row.charged_bytes,
    });
  }
  if ((command.kind === "delete" || command.kind === "remove") && chat) {
    write.retired.push({
      id: `protected-automation-chat:${command.automationId}`,
      profileId: chat.profile_id,
      bytes: chat.charged_bytes,
    });
  }
}

/** Standalone result callers cannot bypass the lifecycle owner's combined history window. */
export function protectedAutomationResultHistoryFull(
  database: OpenClawStateDatabase,
  input: { automationId: string; runId: string },
) {
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(database.db);
  const results = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_runs")
      .select("native_run_id")
      .where("automation_id", "=", input.automationId)
      .limit(50),
  ).rows;
  if (results.length >= 50) {
    return true;
  }
  const tables = getAdmittedSqliteSchemaFacts(database.db)?.tables;
  if (!tables) {
    throw new Error("Protected automation retention requires admitted schema facts.");
  }
  if (!tables.has("protected_automation_run_lifecycle")) {
    return false;
  }
  const runs = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_run_lifecycle")
      .select("id")
      .where("automation_id", "=", input.automationId)
      .limit(51),
  ).rows;
  return (
    new Set([input.runId, ...runs.map((row) => row.id), ...results.map((row) => row.native_run_id)])
      .size > 50
  );
}

export function protectedAutomationResultLifecycleCurrent(
  database: OpenClawStateDatabase,
  input: {
    automationId: string;
    centralOwnerProfileId: string;
    definitionRevision: number;
    runId: string;
    runAtMs: number;
    transcriptSessionId: string;
    isolated: boolean;
  },
) {
  const tables = getAdmittedSqliteSchemaFacts(database.db)?.tables;
  if (!tables) {
    throw new Error("Protected automation publication requires admitted schema facts.");
  }
  if (!tables.has("protected_automation_run_chats")) {
    return !input.isolated;
  }
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase & ProtectedAutomationDatabase>(
    database.db,
  );
  const pool = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_run_chats")
      .select(["reserved_run_bytes", "chat_id"])
      .where("automation_id", "=", input.automationId),
  ).rows[0];
  if (!pool?.reserved_run_bytes) {
    return !input.isolated;
  }
  if (input.isolated && pool.chat_id !== input.transcriptSessionId) {
    return false;
  }
  return Boolean(
    executeSqliteQuerySync(
      database.db,
      k
        .selectFrom("protected_automation_run_lifecycle as run")
        .innerJoin("protected_automations as automation", "automation.id", "run.automation_id")
        .select("run.id")
        .where("run.id", "=", input.runId)
        .where("run.automation_id", "=", input.automationId)
        .where("run.profile_id", "=", input.centralOwnerProfileId)
        .where("run.status", "=", "running")
        .where("run.definition_revision", "=", input.definitionRevision)
        .where("run.scheduled_at_ms", "=", input.runAtMs)
        .where((eb) => eb.or([eb("run.trigger", "=", "manual"), eb("automation.enabled", "=", 1)]))
        .whereRef("automation.definition_revision", "=", "run.definition_revision")
        .limit(1),
    ).rows[0],
  );
}

/**
 * The owner's receipt first, then each opted-in follower's own, read under the write lock.
 * Followers are only told of runs proven isolated: the run executed under the automation's current
 * isolated revision, so a receipt never points at a legacy private result.
 */
export function prepareProtectedAutomationInboxReceipts(
  database: OpenClawStateDatabase,
  write: ProtectedAutomationLifecycleWrite,
  row: { id: string },
  currentRevision: boolean,
) {
  const { command } = write;
  if (command.kind !== "deliver") {
    return;
  }
  const followers =
    currentRevision &&
    readProtectedAutomation(database, command)?.definition.contextAccess === "isolated"
      ? listProtectedAutomationInboxRecipients(database.db, command.automationId)
      : [];
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(database.db);
  for (const profileId of [
    command.profileId,
    ...followers.filter((recipient) => !command.skipRecipients?.includes(recipient)),
  ]) {
    const inbox = executeSqliteQuerySync(
      database.db,
      k
        .selectFrom("protected_automation_owner_inbox")
        .selectAll()
        .where("profile_id", "=", profileId)
        .orderBy("sequence", "desc"),
    ).rows;
    write.pruneInbox.push(
      ...inbox.slice(199).map((retained) => ({ profileId, runId: retained.run_id })),
    );
    write.entries.push({
      id: `protected-automation-inbox:${row.id}`,
      profileId,
      bytes: write.entryOverheadBytes + 640,
    });
  }
}
