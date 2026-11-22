import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { assertSecretStoreValueLength } from "../secrets/store/secret-store-value.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { parseUserConnector, type UserConnectorCommand } from "./user-connectors.types.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";
import type { WorkerOperationContext, WorkerOperations } from "./worker-operation-registry.js";

/** Only this aggregate reads connector identity secrets; they never enter generic secret APIs. */
function operate(input: UserConnectorCommand, { open, stateOptions }: WorkerOperationContext) {
  const database = open();
  const db = database.db;
  const query = getNodeSqliteKysely<DB>(db);
  const name = `alcove-connector-${input.kind}`;
  const requireProfile = () => {
    const profile = selectResolvedUserProfileMetadataById(db, input.profileId);
    const denied =
      tableExists(db, "user_profile_access_denials") &&
      executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("user_profile_access_denials")
          .select("profile_id")
          .where("profile_id", "=", input.profileId),
      );
    if (!profile || profile.id !== input.profileId || profile.merged_into || denied) {
      throw new Error("Connector profile is unavailable.");
    }
  };
  const read = () => {
    if (!tableExists(db, "secret_store_entries")) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("secret_store_entries")
        .select(["value", "kind", "allowed_hosts", "deleted_at_ms"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", input.profileId)
        .where("name", "=", name),
    );
    if (!row) {
      return undefined;
    }
    if (row.kind !== "secret" || row.allowed_hosts !== null || row.deleted_at_ms !== null) {
      throw new Error("Connector state is invalid. Disconnect and reconnect the connector.");
    }
    registerSecretValueForRedaction(row.value);
    const connector = parseUserConnector(safeParseJson(row.value));
    if (connector.kind !== input.kind) {
      throw new Error("Connector binding does not match its credential.");
    }
    return connector;
  };
  if (input.action === "read") {
    return runSqliteDeferredTransactionSync(db, () => {
      requireProfile();
      return read();
    });
  }
  ensureSecretStoreSchema(db);
  return runOpenClawStateWriteTransaction(
    () => {
      const facts = { profileId: input.profileId, kind: input.kind, action: input.action };
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
      requireProfile();
      const current = read();
      if ((current?.generation ?? null) !== input.expectedGeneration) {
        throw new Error("Connector changed. Read its current state and try again.");
      }
      if (input.action === "delete") {
        executeSqliteQuerySync(
          db,
          query
            .deleteFrom("secret_store_entries")
            .where("scope_kind", "=", "identity")
            .where("scope_id", "=", input.profileId)
            .where("name", "=", name),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
        return undefined;
      }
      const connector = parseUserConnector(input.connector);
      if (connector.kind !== input.kind || connector.generation === current?.generation) {
        throw new Error("Connector replacement requires a new matching generation.");
      }
      const value = JSON.stringify(connector);
      assertSecretStoreValueLength(value, "secret");
      const now = Date.now();
      const values = {
        value,
        kind: "secret",
        allowed_hosts: null,
        deleted_at_ms: null,
        updated_at_ms: now,
        updated_by: null,
      };
      executeSqliteQuerySync(
        db,
        query
          .insertInto("secret_store_entries")
          .values({
            scope_kind: "identity",
            scope_id: input.profileId,
            name,
            ...values,
            created_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(values),
          ),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
      return connector;
    },
    { ...stateOptions(), database },
    { operationLabel: "userConnectors.change" },
  );
}

export const userConnectorOperations = { "userConnectors.operate": operate };
export type UserConnectorWorkerOperations = WorkerOperations<typeof userConnectorOperations>;
