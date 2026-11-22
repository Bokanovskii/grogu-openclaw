import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";

const PRIVATE_COLUMNS = {
  cron_run_receipts: ["config_revision", "request_run_id", "error_text"],
  cron_job_runtime_authorities: ["authority_json", "authority_input_fingerprint"],
} as const;

type PrivateTable = keyof typeof PRIVATE_COLUMNS;
type PrivateColumn<Table extends PrivateTable> = (typeof PRIVATE_COLUMNS)[Table][number];

export function sealCronReceiptValue<Table extends PrivateTable, Value extends string | null>(
  db: DatabaseSync,
  table: Table,
  column: PrivateColumn<Table>,
  identity: readonly string[],
  value: Value,
): Value extends string ? string : string | null;
export function sealCronReceiptValue(
  db: DatabaseSync,
  table: PrivateTable,
  column: PrivateColumn<PrivateTable>,
  identity: readonly string[],
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? sealSqliteStoragePlaintext(
        db,
        toUSVString(value),
        protectedStorageValueContext(table, column, identity),
      )
    : value;
}

export function openCronReceiptValue<Table extends PrivateTable, Value extends string | null>(
  db: DatabaseSync,
  table: Table,
  column: PrivateColumn<Table>,
  identity: readonly string[],
  value: Value,
): Value extends string ? string : string | null;
export function openCronReceiptValue(
  db: DatabaseSync,
  table: PrivateTable,
  column: PrivateColumn<PrivateTable>,
  identity: readonly string[],
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? openSqliteStorageText(db, value, protectedStorageValueContext(table, column, identity))
    : value;
}

/** Migrate known plaintext v20 rows inside the schema owner's transaction, never admit strict mode. */
export function migrateCronReceiptsToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Cron receipt encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Cron receipt encryption migration requires the protected storage key.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    for (const table of Object.keys(PRIVATE_COLUMNS) as PrivateTable[]) {
      if (!tableExists(db, table)) {
        continue;
      }
      const keys =
        table === "cron_run_receipts"
          ? ["store_key", "job_id", "receipt_id"]
          : ["store_key", "job_id"];
      const columns = PRIVATE_COLUMNS[table];
      // sqlite-allow-raw -- canonical v20 migration and persisted readback in the owning transaction.
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${keys.join(", ")}`);
      const predicate = keys.map((key) => `${key} = ?`).join(" AND ");
      const update = db.prepare(
        `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE ${predicate}`,
      );
      const readback = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${predicate}`);
      for (const row of rows.iterate()) {
        const identity = keys.map((key) => {
          const value = row[key];
          if (typeof value !== "string") {
            throw new Error("Cron receipt encryption migration found an invalid identity.");
          }
          return value;
        });
        const sealed = columns.map((column) => {
          const value = row[column];
          if (value !== null && typeof value !== "string") {
            throw new Error("Cron receipt encryption migration found an invalid value.");
          }
          return value === null
            ? null
            : sealSqliteStoragePlaintext(
                db,
                value,
                protectedStorageValueContext(table, column, identity),
              );
        });
        const result = update.run(...sealed, ...identity);
        const stored = readback.get(...identity);
        if ((result.changes !== 1 && result.changes !== 1n) || !stored) {
          throw new Error("Cron receipt encryption migration could not read its stored row.");
        }
        for (const [index, column] of columns.entries()) {
          const value = stored[column];
          if (
            value !== sealed[index] ||
            (value !== null &&
              (typeof value !== "string" ||
                openSqliteStorageText(
                  db,
                  value,
                  protectedStorageValueContext(table, column, identity),
                ) !== row[column]))
          ) {
            throw new Error("Cron receipt encryption migration could not verify its stored value.");
          }
        }
      }
    }
  });
}
