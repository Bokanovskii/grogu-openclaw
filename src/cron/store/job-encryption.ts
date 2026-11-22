import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";
import type { CronJobReadRow } from "./schema.js";

const CRON_PRIVATE_COLUMNS = [
  "name",
  "description",
  "job_json",
  "state_json",
  "schedule_identity",
] as const;
type CronPrivateColumn = (typeof CRON_PRIVATE_COLUMNS)[number];

export function cronJobStorageContext(
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
): string {
  return protectedStorageValueContext("cron_jobs", column, [
    toUSVString(storeKey),
    toUSVString(jobId),
  ]);
}

export function sealCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string,
): string;
export function sealCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string | null,
): string | null;
export function sealCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? sealSqliteStoragePlaintext(
        db,
        toUSVString(value),
        cronJobStorageContext(storeKey, jobId, column),
      )
    : value;
}

export function openCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string,
): string;
export function openCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string | null,
): string | null;
export function openCronJobValue(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  column: CronPrivateColumn,
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? openSqliteStorageText(db, value, cronJobStorageContext(storeKey, jobId, column))
    : value;
}

/** Decode at the row-owner boundary before applying shared validation or fingerprints. */
export function openCronJobRow<
  T extends Pick<CronJobReadRow, "job_id" | "job_json" | "state_json" | "schedule_identity">,
>(db: DatabaseSync, storeKey: string, row: T): T {
  return {
    ...row,
    job_json: openCronJobValue(db, storeKey, row.job_id, "job_json", row.job_json),
    state_json: openCronJobValue(db, storeKey, row.job_id, "state_json", row.state_json),
    schedule_identity: openCronJobValue(
      db,
      storeKey,
      row.job_id,
      "schedule_identity",
      row.schedule_identity,
    ),
  };
}

/** Call once on known plaintext v20 rows, in the schema owner's write transaction. */
export function migrateCronJobsToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Cron job encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Cron job encryption migration requires the protected storage key.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: migration streams and verifies canonical rows in the owner's transaction.
    const rows = db.prepare(`
      SELECT store_key, job_id, name, description, job_json, state_json, schedule_identity
        FROM cron_jobs ORDER BY store_key, job_id
    `);
    const update = db.prepare(`
      UPDATE cron_jobs SET name = ?, description = ?, job_json = ?, state_json = ?,
        schedule_identity = ? WHERE store_key = ? AND job_id = ?
    `);
    const readback = db.prepare(`
      SELECT name, description, job_json, state_json, schedule_identity
        FROM cron_jobs WHERE store_key = ? AND job_id = ?
    `);
    for (const row of rows.iterate()) {
      if (typeof row.store_key !== "string" || typeof row.job_id !== "string") {
        throw new Error("Cron job encryption migration found an invalid identity.");
      }
      const { store_key: storeKey, job_id: jobId } = row;
      const sealed = CRON_PRIVATE_COLUMNS.map((column) => {
        const value = row[column];
        if (value !== null && typeof value !== "string") {
          throw new Error("Cron job encryption migration found an invalid value.");
        }
        return value === null
          ? null
          : sealSqliteStoragePlaintext(db, value, cronJobStorageContext(storeKey, jobId, column));
      });
      const result = update.run(...sealed, storeKey, jobId);
      const stored = readback.get(storeKey, jobId);
      if ((result.changes !== 1 && result.changes !== 1n) || !stored) {
        throw new Error("Cron job encryption migration could not read its stored row.");
      }
      for (const [index, column] of CRON_PRIVATE_COLUMNS.entries()) {
        const value = stored[column];
        if (
          value !== sealed[index] ||
          (value !== null &&
            (typeof value !== "string" ||
              openSqliteStorageText(db, value, cronJobStorageContext(storeKey, jobId, column)) !==
                row[column]))
        ) {
          throw new Error("Cron job encryption migration could not verify its stored value.");
        }
      }
    }
  });
}
