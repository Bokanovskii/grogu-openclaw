import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../storage/sqlite-encryption.js";

function scratchContentContext(storeKey: string, jobId: string): string {
  return protectedStorageValueContext("cron_job_scratch", "content", [storeKey, jobId]);
}

export function sealCronScratchContent(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  content: string,
): string {
  return isSqliteStorageValueEncryptionStrict(db)
    ? sealSqliteStoragePlaintext(db, toUSVString(content), scratchContentContext(storeKey, jobId))
    : content;
}

export function openCronScratchContent(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  content: string,
): string {
  return isSqliteStorageValueEncryptionStrict(db)
    ? openSqliteStorageText(db, content, scratchContentContext(storeKey, jobId))
    : content;
}

/**
 * The schema owner calls this once for known plaintext rows in its v20-to-v21
 * transaction, after widening the protected scratch CHECK and before publication.
 */
export function migrateCronScratchToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Cron scratch encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Cron scratch encryption migration requires the protected storage key.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: the migration stages only ciphertext in the caller's database transaction.
    db.exec(`
      CREATE TABLE main.cron_job_scratch_encryption_stage (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (store_key, job_id)
      ) STRICT
    `);
    const rows = db.prepare(
      "SELECT store_key, job_id, content FROM cron_job_scratch WHERE content IS NOT NULL ORDER BY store_key, job_id",
    );
    const insert = db.prepare(
      "INSERT INTO main.cron_job_scratch_encryption_stage (store_key, job_id, content) VALUES (?, ?, ?)",
    );
    for (const row of rows.iterate()) {
      if (
        typeof row.store_key !== "string" ||
        typeof row.job_id !== "string" ||
        typeof row.content !== "string"
      ) {
        throw new Error("Cron scratch encryption migration found an invalid row.");
      }
      insert.run(
        row.store_key,
        row.job_id,
        sealSqliteStoragePlaintext(
          db,
          row.content,
          scratchContentContext(row.store_key, row.job_id),
        ),
      );
    }

    const staged = db.prepare(`
      SELECT staged.store_key, staged.job_id, staged.content AS sealed, scratch.content AS original
        FROM main.cron_job_scratch_encryption_stage AS staged
        LEFT JOIN main.cron_job_scratch AS scratch
          ON scratch.store_key = staged.store_key AND scratch.job_id = staged.job_id
       ORDER BY staged.store_key, staged.job_id
    `);
    const verifyStaged = (row: Record<string, unknown>) => {
      if (
        typeof row.store_key !== "string" ||
        typeof row.job_id !== "string" ||
        typeof row.sealed !== "string" ||
        typeof row.original !== "string" ||
        openSqliteStorageText(db, row.sealed, scratchContentContext(row.store_key, row.job_id)) !==
          row.original
      ) {
        throw new Error("Cron scratch encryption migration could not verify staged ciphertext.");
      }
      return { storeKey: row.store_key, jobId: row.job_id, sealed: row.sealed };
    };
    // Verify every persisted envelope while every original value is still present.
    for (const row of staged.iterate()) {
      verifyStaged(row);
    }
    const update = db.prepare(
      "UPDATE main.cron_job_scratch SET content = ? WHERE store_key = ? AND job_id = ?",
    );
    for (const row of staged.iterate()) {
      const { storeKey, jobId, sealed } = verifyStaged(row);
      const result = update.run(sealed, storeKey, jobId);
      if (result.changes !== 1 && result.changes !== 1n) {
        throw new Error("Cron scratch encryption migration could not replace its original value.");
      }
    }
    const mismatch = db
      .prepare(`
        SELECT 1
          FROM main.cron_job_scratch_encryption_stage AS staged
          LEFT JOIN main.cron_job_scratch AS scratch
            ON scratch.store_key = staged.store_key AND scratch.job_id = staged.job_id
         WHERE scratch.content IS NOT staged.content
        UNION ALL
        SELECT 1 FROM main.cron_job_scratch AS scratch
         WHERE scratch.content IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM main.cron_job_scratch_encryption_stage AS staged
            WHERE staged.store_key = scratch.store_key AND staged.job_id = scratch.job_id
         )
        LIMIT 1
      `)
      .get();
    if (mismatch) {
      throw new Error("Cron scratch encryption migration could not verify its stored value.");
    }
    db.exec("DROP TABLE main.cron_job_scratch_encryption_stage");
  });
}
