import type { DatabaseSync } from "node:sqlite";
import {
  hasSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import { assertSupportedAgentSchemaVersion } from "./openclaw-agent-db-schema-read.js";
import { cleanupProtectedAgentStorageAfterMigration } from "./openclaw-agent-protected-storage-cleanup.js";
import { migrateProtectedAgentStorageInTransaction } from "./openclaw-agent-protected-storage-migration.js";

export function isProtectedStorageMigration(
  database: DatabaseSync,
  originalVersion: number,
  targetVersion: number,
): boolean {
  return (
    hasSqliteStorageValueEncryption(database) &&
    originalVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    targetVersion === PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
  );
}

export function prepareProtectedAgentStorageMigration(database: DatabaseSync): void {
  if (hasSqliteStorageValueEncryption(database)) {
    database.exec("PRAGMA secure_delete = ON;");
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
  migrateProtectedAgentStorageInTransaction(database);
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
