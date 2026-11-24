import type {
  ProtectedAutomationFinishedRun,
  ProtectedPublicAutomationRun,
} from "../../packages/gateway-protocol/src/protected-automation-results.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqlitePinnedReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import type { ProtectedAutomationLifecycleDatabase } from "./protected-automation-lifecycle.js";
import {
  admitResults,
  isOwner,
  privateRecord,
  typedDatabase,
} from "./protected-automation-results.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";
import { readProtectedAutomationFollowerGrant } from "./protected-automation-sharing.js";
import { readProtectedAutomation } from "./protected-automations.js";

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

export function listProtectedPublicAutomationRuns(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string; id?: string },
): ProtectedPublicAutomationRun[] | undefined {
  admitResults(database);
  const db = database.db;
  return runSqliteReadOperationSync(db, () =>
    runSqlitePinnedReadSnapshotSync(db, () => {
      if (!getAdmittedSqliteSchemaFacts(db)?.tables.has("protected_automation_run_lifecycle")) {
        return undefined;
      }
      const grant = readProtectedAutomationFollowerGrant(database, input);
      if (!grant) {
        return undefined;
      }
      const automation = readProtectedAutomation(database, {
        profileId: grant.ownerProfileId,
        automationId: input.automationId,
      });
      if (automation?.definition.contextAccess !== "isolated") {
        return undefined;
      }
      let query = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(db)
        .selectFrom("protected_automation_runs as result")
        .innerJoin("protected_automation_run_lifecycle as run", (join) =>
          join
            .onRef("run.id", "=", "result.native_run_id")
            .onRef("run.result_id", "=", "result.id")
            .onRef("run.automation_id", "=", "result.automation_id")
            .onRef("run.profile_id", "=", "result.central_owner_profile_id")
            .onRef("run.definition_revision", "=", "result.definition_revision")
            .onRef("run.scheduled_at_ms", "=", "result.run_at_ms"),
        )
        .selectAll("result")
        .where("result.automation_id", "=", input.automationId)
        .where("result.central_owner_profile_id", "=", grant.ownerProfileId)
        .where("run.status", "=", "succeeded")
        .orderBy("result.completed_at_ms", "desc")
        .orderBy("result.sequence", "desc");
      if (input.id) {
        query = query.where("result.id", "=", input.id);
      }
      return executeSqliteQuerySync(db, query).rows.map((row) => {
        const { id, runAtMs, completedAtMs, text } = privateRecord(db, row);
        return { id, runAtMs, completedAtMs, text };
      });
    }),
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
