import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import type { ProtectedAutomationLifecycleDatabase } from "./protected-automation-lifecycle.js";
import type { ProtectedAutomationLifecycleWrite } from "./protected-automation-lifecycle.types.js";
import type { ProtectedAutomationDatabase } from "./protected-automations.js";

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
  const inbox = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_owner_inbox")
      .selectAll()
      .where("profile_id", "=", command.profileId)
      .orderBy("sequence"),
  ).rows.filter(
    (row) =>
      ((command.kind === "delete" || command.kind === "remove") &&
        row.automation_id === command.automationId) ||
      write.pruneInboxRunIds.includes(row.run_id) ||
      write.pruneResultIds.includes(row.result_id) ||
      (row.automation_id === command.automationId && write.pruneRunIds.includes(row.run_id)),
  );
  write.pruneInboxRunIds = inbox.map((row) => row.run_id);
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
  },
) {
  const tables = getAdmittedSqliteSchemaFacts(database.db)?.tables;
  if (!tables) {
    throw new Error("Protected automation publication requires admitted schema facts.");
  }
  if (!tables.has("protected_automation_run_chats")) {
    return true;
  }
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase & ProtectedAutomationDatabase>(
    database.db,
  );
  const pool = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automation_run_chats")
      .select("reserved_run_bytes")
      .where("automation_id", "=", input.automationId),
  ).rows[0];
  if (!pool?.reserved_run_bytes) {
    return true;
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
