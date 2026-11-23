import type { ProtectedAutomationFinishedRun } from "../../packages/gateway-protocol/src/protected-automation-results.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  admitResults,
  isOwner,
  privateRecord,
  typedDatabase,
} from "./protected-automation-results.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";

/** Owner-only retained history, newest first. Foreign, unknown, or revoked ids return undefined. */
export function listProtectedAutomationRuns(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string; id?: string },
): ProtectedAutomationFinishedRun[] | undefined {
  admitResults(database);
  if (!isOwner(database, input.profileId, input.automationId)) {
    return undefined;
  }
  let query = typedDatabase(database.db)
    .selectFrom("protected_automation_runs")
    .selectAll()
    .where("automation_id", "=", input.automationId)
    .where("central_owner_profile_id", "=", input.profileId)
    .orderBy("completed_at_ms", "desc")
    .orderBy("sequence", "desc");
  if (input.id) {
    query = query.where("id", "=", input.id);
  }
  return executeSqliteQuerySync(database.db, query).rows.map((row) =>
    privateRecord(database.db, row),
  );
}

/** Every retained run is charged to its central owner once, whatever the automation's state. */
export function readProtectedAutomationResultStorageUsage(
  database: OpenClawStateDatabase,
): ProtectedAutomationResultStorageEntry[] {
  admitResults(database);
  return executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_automation_runs")
      .select(["id", "central_owner_profile_id as profileId", "charged_bytes as bytes"]),
  ).rows.map((entry) => ({
    id: `protected-automation-run:${entry.id}`,
    profileId: entry.profileId,
    bytes: entry.bytes,
  }));
}
