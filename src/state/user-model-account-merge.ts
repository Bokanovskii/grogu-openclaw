import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  openSecretStoreValue,
  sealSecretStoreValue,
} from "../secrets/store/secret-store-encryption.js";
import { isSqliteStorageValueEncryptionStrict } from "../storage/sqlite-encryption.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Rebind retained credential values without interpreting provider token content. */
export function transferUserModelAccountRecords(db: DatabaseSync, source: string, target: string) {
  const query = getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db);
  if (isSqliteStorageValueEncryptionStrict(db)) {
    const sourceRows = query
      .selectFrom("secret_store_entries")
      .selectAll()
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", source)
      .where("name", "like", "model-account:%");
    for (const row of iterateSqliteQuerySync(db, sourceRows)) {
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("secret_store_entries")
          .select("name")
          .where("scope_kind", "=", "identity")
          .where("scope_id", "=", target)
          .where("name", "=", row.name),
      );
      if (existing) {
        continue;
      }
      if (row.kind !== "secret" && row.kind !== "env") {
        throw new Error("Stored model-account credential has an invalid secret kind.");
      }
      const value = openSecretStoreValue(db, row, row.value);
      executeSqliteQuerySync(
        db,
        query.insertInto("secret_store_entries").values({
          ...row,
          scope_id: target,
          value: sealSecretStoreValue(db, { ...row, scope_id: target }, value, row.kind),
        }),
      );
    }
  } else {
    executeSqliteQuerySync(
      db,
      query
        .insertInto("secret_store_entries")
        .columns([
          "scope_kind",
          "scope_id",
          "name",
          "value",
          "kind",
          "allowed_hosts",
          "created_at_ms",
          "updated_at_ms",
          "updated_by",
          "deleted_at_ms",
        ])
        .expression(
          query
            .selectFrom("secret_store_entries")
            .select((eb) => [
              "scope_kind",
              eb.val(target).as("scope_id"),
              "name",
              "value",
              "kind",
              "allowed_hosts",
              "created_at_ms",
              "updated_at_ms",
              "updated_by",
              "deleted_at_ms",
            ])
            .where("scope_kind", "=", "identity")
            .where("scope_id", "=", source)
            .where("name", "like", "model-account:%"),
        )
        .onConflict((conflict) => conflict.columns(["scope_kind", "scope_id", "name"]).doNothing()),
    );
  }
  executeSqliteQuerySync(
    db,
    query
      .deleteFrom("secret_store_entries")
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", source)
      .where((eb) =>
        eb.or([eb("name", "=", "model-accounts"), eb("name", "like", "model-account:%")]),
      ),
  );
}
