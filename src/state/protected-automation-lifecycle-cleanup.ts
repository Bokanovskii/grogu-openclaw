import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { ProtectedAutomationLifecycleDatabase } from "./protected-automation-lifecycle.types.js";
import type { ProtectedAutomationResultStorageEntry } from "./protected-automation-results.types.js";
import { storedDefinitionCharge } from "./protected-automation-storage-codec.js";
import type {
  ProtectedAutomationDatabase,
  ProtectedAutomationStorageUsage,
} from "./protected-automations.js";

export function retireProtectedAutomationMemberDefinitions(
  db: DatabaseSync,
  profileId: string,
  fenced: boolean,
): ProtectedAutomationStorageUsage["entries"] {
  const k = getNodeSqliteKysely<ProtectedAutomationDatabase>(db);
  let definitions = k
    .deleteFrom("protected_automations")
    .where("central_owner_profile_id", "=", profileId)
    .where("visibility", "=", "private")
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("protected_automation_members")
          .select("automation_id")
          .whereRef("automation_id", "=", "protected_automations.id")
          .where("profile_id", "=", profileId)
          .where("role", "=", "owner"),
      ),
    )
    .where((expression) =>
      expression.not(
        expression.exists(
          expression
            .selectFrom("protected_automation_members")
            .select("automation_id")
            .whereRef("automation_id", "=", "protected_automations.id")
            .where("profile_id", "!=", profileId)
            .where("role", "=", "owner"),
        ),
      ),
    )
    .where((expression) =>
      expression.not(
        expression.exists(
          expression
            .selectFrom("protected_automation_job_bindings")
            .select("automation_id")
            .whereRef("automation_id", "=", "protected_automations.id"),
        ),
      ),
    )
    .returning([
      "id",
      "central_owner_profile_id as profileId",
      storedDefinitionCharge.as("definitionBytes"),
    ]);
  if (!fenced) {
    definitions = definitions.where("creator_profile_id", "=", profileId).where("enabled", "=", 0);
  }
  const retired = executeSqliteQuerySync(db, definitions).rows;
  const remaining = executeSqliteQuerySync(
    db,
    k
      .selectFrom("protected_automations")
      .select("id")
      .where("central_owner_profile_id", "=", profileId)
      .limit(1),
  ).rows[0];
  if (remaining) {
    throw new Error(
      fenced
        ? "Member removal requires the shared or native-scheduler automation owner to retire or transfer remaining custody."
        : "Member removal requires fenced automation retirement authority.",
    );
  }
  if (fenced) {
    executeSqliteQuerySync(
      db,
      k.deleteFrom("protected_automation_members").where("profile_id", "=", profileId),
    );
  }
  return retired;
}

export function hasProtectedAutomationMemberStorage(db: DatabaseSync, profileId: string): boolean {
  const tables = getAdmittedSqliteSchemaFacts(db)?.tables;
  if (!tables) {
    throw new Error("Protected automation member removal requires admitted schema facts.");
  }
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(db);
  const scopes = [
    { table: "protected_automation_owner_inbox", column: "profile_id" },
    { table: "protected_automation_run_lifecycle", column: "profile_id" },
    { table: "protected_automation_run_chats", column: "profile_id" },
    { table: "protected_automation_runs", column: "central_owner_profile_id" },
  ] as const;
  return scopes.some(
    ({ table, column }) =>
      tables.has(table) &&
      executeSqliteQuerySync(
        db,
        k.selectFrom(table).select("automation_id").where(column, "=", profileId).limit(1),
      ).rows.length > 0,
  );
}

/** Only the admitted member-removal transaction may use this after fencing its native writers. */
export function retireProtectedAutomationMemberStorage(
  db: DatabaseSync,
  profileId: string,
): ProtectedAutomationResultStorageEntry[] {
  if (!db.isTransaction) {
    throw new Error("Protected automation member retirement requires its owner transaction.");
  }
  const tables = getAdmittedSqliteSchemaFacts(db)?.tables;
  if (!tables) {
    throw new Error("Protected automation member retirement requires admitted schema facts.");
  }
  const k = getNodeSqliteKysely<ProtectedAutomationLifecycleDatabase>(db);
  const retired: ProtectedAutomationResultStorageEntry[] = [];
  if (tables.has("protected_automation_owner_inbox")) {
    retired.push(
      ...executeSqliteQuerySync(
        db,
        k
          .deleteFrom("protected_automation_owner_inbox")
          .where("profile_id", "=", profileId)
          .returning(["run_id as id", "profile_id as profileId", "charged_bytes as bytes"]),
      ).rows.map((row) => Object.assign(row, { id: `protected-automation-inbox:${row.id}` })),
    );
  }
  if (tables.has("protected_automation_run_lifecycle")) {
    retired.push(
      ...executeSqliteQuerySync(
        db,
        k
          .deleteFrom("protected_automation_run_lifecycle")
          .where("profile_id", "=", profileId)
          .returning(["id", "profile_id as profileId", "charged_bytes as bytes"]),
      )
        .rows.filter((row) => row.bytes > 0)
        .map((row) => Object.assign(row, { id: `protected-automation-lifecycle:${row.id}` })),
    );
  }
  if (tables.has("protected_automation_run_chats")) {
    retired.push(
      ...executeSqliteQuerySync(
        db,
        k
          .deleteFrom("protected_automation_run_chats")
          .where("profile_id", "=", profileId)
          .returning(["automation_id as id", "profile_id as profileId", "charged_bytes as bytes"]),
      ).rows.map((row) => Object.assign(row, { id: `protected-automation-chat:${row.id}` })),
    );
  }
  if (tables.has("protected_automation_runs")) {
    retired.push(
      ...executeSqliteQuerySync(
        db,
        k
          .deleteFrom("protected_automation_runs")
          .where("central_owner_profile_id", "=", profileId)
          .returning(["id", "central_owner_profile_id as profileId", "charged_bytes as bytes"]),
      ).rows.map((row) => Object.assign(row, { id: `protected-automation-run:${row.id}` })),
    );
  }
  return retired;
}
