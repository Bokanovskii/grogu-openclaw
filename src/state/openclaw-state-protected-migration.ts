import type { DatabaseSync } from "node:sqlite";
import { migrateCronScratchToProtectedStorageInDatabase } from "../cron/scratch-encryption.js";
import { migrateCronJobsToProtectedStorageInDatabase } from "../cron/store/job-encryption.js";
import { migrateCronQuarantineToProtectedStorageInDatabase } from "../cron/store/quarantine.kernel.js";
import { migrateCronHistoryToProtectedStorageInDatabase } from "../cron/store/run-history-encryption.js";
import { migrateCronReceiptsToProtectedStorageInDatabase } from "../cron/store/run-receipt-encryption.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { migrateSecretStoreToProtectedStorageInDatabase } from "../secrets/store/secret-store-encryption.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  createProtectedSharedStateKeyCheck,
  PROTECTED_SHARED_STATE_ENCRYPTION_TABLE,
  PROTECTED_SHARED_STATE_SCHEMA_VERSION,
  readProtectedSharedStateMarker,
} from "./openclaw-state-protected-marker.js";
import {
  PROTECTED_SHARED_STATE_SCHEMA_SQL,
  widenProtectedCronScratchInDatabase,
} from "./openclaw-state-protected-schema.js";
import { readStateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";
import { migrateProtectedAutomationsToEncryptedStorageInDatabase } from "./protected-automation-storage-codec.js";

/**
 * Migrate admitted plaintext v20 inside the schema owner's write transaction.
 * The owner must reclaim SQLite remnants after commit before admitting readers.
 */
export function migrateProtectedSharedStateInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Protected shared-state migration requires an unencrypted write transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected shared-state migration requires the protected storage key.");
  }
  if (Number(db.prepare("PRAGMA secure_delete").get()?.secure_delete) !== 1) {
    throw new Error("Protected shared-state migration requires SQLite secure_delete.");
  }
  if (
    readSqliteUserVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION ||
    readStateSchemaContentVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION ||
    tableExists(db, PROTECTED_SHARED_STATE_ENCRYPTION_TABLE)
  ) {
    throw new Error("Protected shared-state migration requires an unencrypted v20 database.");
  }
  if (readStateSchemaPublicationBlocker(db)) {
    throw new Error("Protected shared-state migration must wait for the older updater to finish.");
  }

  runSqliteImmediateTransactionSync(db, () => {
    const legacy = migrateLegacyCronRunLogsToTaskRuns(db);
    if (legacy.malformed > 0) {
      throw new Error(
        "Protected shared-state migration found malformed legacy Cron history; inspect it with Doctor before retrying.",
      );
    }
    widenProtectedCronScratchInDatabase(db);
    migrateSecretStoreToProtectedStorageInDatabase(db);
    migrateProtectedAutomationsToEncryptedStorageInDatabase(db);
    migrateCronJobsToProtectedStorageInDatabase(db);
    migrateCronScratchToProtectedStorageInDatabase(db);
    migrateCronHistoryToProtectedStorageInDatabase(db);
    migrateCronReceiptsToProtectedStorageInDatabase(db);
    migrateCronQuarantineToProtectedStorageInDatabase(db);

    db.exec(
      extractSqliteTableSchema(
        PROTECTED_SHARED_STATE_SCHEMA_SQL,
        PROTECTED_SHARED_STATE_ENCRYPTION_TABLE,
      ),
    );
    const keyCheck = createProtectedSharedStateKeyCheck(db);
    db.prepare(
      `INSERT INTO ${PROTECTED_SHARED_STATE_ENCRYPTION_TABLE} (id, key_check, cleanup_pending) VALUES (1, ?, 1)`,
    ).run(keyCheck);
    const marker = readProtectedSharedStateMarker(db);
    if (!marker.cleanupPending) {
      throw new Error("Protected shared-state migration could not verify its cleanup marker.");
    }
    const updated = db
      .prepare(
        "UPDATE schema_meta SET schema_version = ?, updated_at = ? WHERE meta_key = 'primary' AND role = 'global'",
      )
      .run(PROTECTED_SHARED_STATE_SCHEMA_VERSION, Date.now());
    if (updated.changes !== 1 && updated.changes !== 1n) {
      throw new Error("Protected shared-state migration requires canonical ownership metadata.");
    }
    db.prepare(
      `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
    ).run(CONTENT_VERSION_KEY, String(PROTECTED_SHARED_STATE_SCHEMA_VERSION), Date.now());
    db.exec(`PRAGMA user_version = ${PROTECTED_SHARED_STATE_SCHEMA_VERSION}`);
  });
}
