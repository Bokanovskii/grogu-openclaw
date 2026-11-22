import type { DatabaseSync } from "node:sqlite";
import {
  CRON_JOB_SCRATCH_MAX_BYTES,
  CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES,
} from "../cron/scratch-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { isSqliteStorageValueEncryptionStrict } from "../storage/sqlite-encryption.js";
import { PROTECTED_SHARED_STATE_ENCRYPTION_TABLE } from "./openclaw-state-protected-marker.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const scratchSchema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "cron_job_scratch", {
  errorMessage: "Canonical Cron scratch schema is missing.",
});
const originalBound = `length(CAST(content AS BLOB)) <= ${CRON_JOB_SCRATCH_MAX_BYTES}`;
if (!scratchSchema.includes(originalBound)) {
  throw new Error("Canonical Cron scratch size constraint has changed.");
}
const protectedScratchSchema = scratchSchema.replace(
  originalBound,
  `length(CAST(content AS BLOB)) <= ${CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES}`,
);

export const PROTECTED_SHARED_STATE_SCHEMA_SQL = `${OPENCLAW_STATE_SCHEMA_SQL.replace(
  scratchSchema,
  protectedScratchSchema,
)}
CREATE TABLE IF NOT EXISTS ${PROTECTED_SHARED_STATE_ENCRYPTION_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_check TEXT NOT NULL,
  cleanup_pending INTEGER NOT NULL CHECK (cleanup_pending IN (0, 1))
) STRICT;
`;

export function getAdmittedSharedStateSchema(db: DatabaseSync): string {
  return isSqliteStorageValueEncryptionStrict(db)
    ? PROTECTED_SHARED_STATE_SCHEMA_SQL
    : OPENCLAW_STATE_SCHEMA_SQL;
}

/** Rebuild the protected-only constraint without changing personal v20's canonical schema. */
export function widenProtectedCronScratchInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("Protected Cron scratch schema migration requires a transaction.");
  }
  // sqlite-allow-raw: SQLite cannot alter an existing CHECK constraint in place.
  db.exec(`
    ALTER TABLE cron_job_scratch RENAME TO cron_job_scratch_v20;
    ${protectedScratchSchema}
    INSERT INTO cron_job_scratch
      SELECT store_key, job_id, content, revision, source_sha256, updated_at_ms
      FROM cron_job_scratch_v20;
    DROP TABLE cron_job_scratch_v20;
    CREATE INDEX idx_cron_job_scratch_store_updated
      ON cron_job_scratch(store_key, updated_at_ms DESC, job_id);
  `);
}
