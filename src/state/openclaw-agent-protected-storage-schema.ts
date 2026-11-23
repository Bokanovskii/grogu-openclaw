import type { DatabaseSync } from "node:sqlite";
import {
  openSessionSuggestionFields,
  sealSessionSuggestionFields,
} from "../config/sessions/session-suggestion-encryption.js";
import {
  hasSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import {
  assertSupportedAgentSchemaVersion,
  PROTECTED_ENCRYPTION_TABLE,
} from "./openclaw-agent-db-schema-read.js";
import { cleanupProtectedAgentStorageAfterMigration } from "./openclaw-agent-protected-storage-cleanup.js";
import { migrateProtectedAgentStorageInTransaction } from "./openclaw-agent-protected-storage-migration.js";

const ARCHIVE_COLUMNS_SQL = "PRAGMA table_info(session_transcript_archives)";
const SUGGESTION_COLUMNS = "id, session_key, author_id, author_label, text";
const SUGGESTION_ROWS_SQL = `SELECT ${SUGGESTION_COLUMNS} FROM session_suggestions ORDER BY session_key, id`;
const SUGGESTION_UPDATE_SQL =
  "UPDATE session_suggestions SET author_id = ?, author_label = ?, text = ? WHERE id = ? AND session_key = ?";
const SUGGESTION_READ_SQL = `SELECT ${SUGGESTION_COLUMNS} FROM session_suggestions WHERE id = ? AND session_key = ?`;

export function isProtectedStorageMigration(
  database: DatabaseSync,
  originalVersion: number,
  targetVersion: number,
): boolean {
  return (
    hasSqliteStorageValueEncryption(database) &&
    originalVersion >= OPENCLAW_AGENT_SCHEMA_VERSION &&
    originalVersion < PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION &&
    targetVersion === PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
  );
}

export function assertProtectedAgentMigrationPredecessor(
  database: DatabaseSync,
  version: number,
): void {
  if (
    !hasSqliteStorageValueEncryption(database) ||
    version <= OPENCLAW_AGENT_SCHEMA_VERSION ||
    version >= PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
  ) {
    return;
  }
  const columns = database.prepare(ARCHIVE_COLUMNS_SQL).all(); // sqlite-allow-raw -- Migration schema shape.
  const attribution = columns.some((column) => column.name === "protected_attribution");
  if (!columns.length || attribution !== (version === OPENCLAW_AGENT_SCHEMA_VERSION + 2)) {
    throw new Error("Protected agent storage predecessor has an inconsistent attribution schema.");
  }
}

export function prepareProtectedAgentStorageMigration(database: DatabaseSync): void {
  if (hasSqliteStorageValueEncryption(database)) {
    database.exec("PRAGMA secure_delete = ON;"); // sqlite-allow-raw -- Connection-local migration policy.
  }
}

export function migrateProtectedAgentStorageIfNeeded(
  database: DatabaseSync,
  previousVersion: number,
  targetVersion: number,
): void {
  if (!hasSqliteStorageValueEncryption(database) || previousVersion >= targetVersion) {
    return;
  }
  if (targetVersion !== PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION) {
    throw new Error("Protected storage encryption requires its dedicated agent schema version.");
  }
  renewAgentDatabaseMaintenanceAuthorityIfPresent();
  if (previousVersion <= OPENCLAW_AGENT_SCHEMA_VERSION) {
    migrateProtectedAgentStorageInTransaction(database);
  }
  const columns = database.prepare(ARCHIVE_COLUMNS_SQL).all(); // sqlite-allow-raw -- Migration schema shape.
  if (!columns.some((column) => column.name === "protected_attribution")) {
    // sqlite-allow-raw -- Versioned additive DDL inside the migration transaction.
    database.exec("ALTER TABLE session_transcript_archives ADD COLUMN protected_attribution TEXT");
  }
  // These statements run inside the versioned migration before v28 is published.
  const rows = database.prepare(SUGGESTION_ROWS_SQL); // sqlite-allow-raw -- Versioned row migration.
  const update = database.prepare(SUGGESTION_UPDATE_SQL); // sqlite-allow-raw -- Versioned row migration.
  const read = database.prepare(SUGGESTION_READ_SQL); // sqlite-allow-raw -- Versioned row migration.
  let sealedRows = 0;
  for (const row of rows.iterate()) {
    sealedRows += 1;
    renewAgentDatabaseMaintenanceAuthorityIfPresent();
    if (
      typeof row.id !== "string" ||
      typeof row.session_key !== "string" ||
      typeof row.author_id !== "string" ||
      (row.author_label !== null && typeof row.author_label !== "string") ||
      typeof row.text !== "string"
    ) {
      throw new Error("Invalid suggestion during protected storage migration.");
    }
    const plaintext = {
      id: row.id,
      session_key: row.session_key,
      author_id: row.author_id,
      author_label: row.author_label,
      text: row.text,
    };
    const sealed = sealSessionSuggestionFields(database, plaintext);
    if (
      Number(
        update.run(
          sealed.author_id,
          sealed.author_label,
          sealed.text,
          sealed.id,
          sealed.session_key,
        ).changes,
      ) !== 1
    ) {
      throw new Error("Suggestion changed during protected storage migration.");
    }
    const stored = read.get(sealed.id, sealed.session_key);
    if (
      stored?.id !== sealed.id ||
      stored.session_key !== sealed.session_key ||
      typeof stored.author_id !== "string" ||
      (stored.author_label !== null && typeof stored.author_label !== "string") ||
      typeof stored.text !== "string"
    ) {
      throw new Error("Protected suggestion migration failed persisted read-back.");
    }
    const opened = openSessionSuggestionFields(database, {
      id: stored.id,
      session_key: stored.session_key,
      author_id: stored.author_id,
      author_label: stored.author_label,
      text: stored.text,
    });
    if (
      opened.author_id !== plaintext.author_id ||
      opened.author_label !== plaintext.author_label ||
      opened.text !== plaintext.text
    ) {
      throw new Error("Protected suggestion migration failed persisted read-back.");
    }
  }
  // In-place sealing leaves prior plaintext pages in the WAL and free space; the
  // post-migration cleanup reclaims them only while its marker is pending.
  if (
    sealedRows > 0 &&
    Number(
      database // sqlite-allow-raw -- Versioned cleanup marker inside the migration transaction.
        .prepare(`UPDATE ${PROTECTED_ENCRYPTION_TABLE} SET cleanup_pending = 1 WHERE id = 1`)
        .run().changes,
    ) !== 1
  ) {
    throw new Error("Protected storage marker is missing during suggestion migration.");
  }
}

export function cleanupProtectedAgentStorageIfNeeded(database: DatabaseSync): void {
  if (hasSqliteStorageValueEncryption(database)) {
    cleanupProtectedAgentStorageAfterMigration(database);
  }
}

export function admitProtectedAgentStorage(database: DatabaseSync, pathname: string): void {
  if (hasSqliteStorageValueEncryption(database)) {
    setSqliteStorageValueEncryptionStrict(database, true);
    assertSupportedAgentSchemaVersion(database, pathname);
  }
}
