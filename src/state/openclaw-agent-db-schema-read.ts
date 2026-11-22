import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import {
  readExistingAgentSchemaMeta,
  type ExistingAgentSchemaMeta,
} from "./openclaw-agent-db-metadata.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";

export const PROTECTED_ENCRYPTION_TABLE = "grogu_protected_storage";
export const PROTECTED_ENCRYPTION_KEY_CHECK = "openclaw:protected:key-check";
export const PROTECTED_ENCRYPTION_KEY_CHECK_VALUE = "protected-storage-key-v1";

export { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";

export function getAgentDatabaseTargetSchemaVersion(db: DatabaseSync): number {
  return hasSqliteStorageValueEncryption(db)
    ? PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
    : OPENCLAW_AGENT_SCHEMA_VERSION;
}

function assertProtectedEncryptionAdmission(
  db: DatabaseSync,
  pathname: string,
  userVersion: number,
): void {
  const encryptionEnabled = hasSqliteStorageValueEncryption(db);
  const hasMarker = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(PROTECTED_ENCRYPTION_TABLE),
  );
  if (userVersion === PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION && !hasMarker) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} has an encrypted schema version but no encryption marker; keep it stopped and repair it with a supporting build.`,
    );
  }
  if (hasMarker && userVersion !== PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} has an encryption marker without its schema version; keep it stopped and repair it with a supporting build.`,
    );
  }
  if (!hasMarker) {
    return;
  }
  if (!encryptionEnabled) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} is encrypted but its key is unavailable; restore the protected storage key and restart the protected service.`,
    );
  }
  const row = db.prepare("SELECT key_check FROM grogu_protected_storage WHERE id = 1").get();
  if (typeof row?.key_check !== "string") {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} has an invalid encryption marker; keep it stopped and repair it with a supporting build.`,
    );
  }
  let keyCheck: string;
  try {
    keyCheck = openSqliteStorageText(db, row.key_check, PROTECTED_ENCRYPTION_KEY_CHECK);
  } catch {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} could not be opened with the configured storage key; verify the protected key file and restart the service.`,
    );
  }
  if (keyCheck !== PROTECTED_ENCRYPTION_KEY_CHECK_VALUE) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} has an invalid encryption key check; verify the protected key file and restart the service.`,
    );
  }
  setSqliteStorageValueEncryptionStrict(db, true);
}

export function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): number {
  const userVersion = getAdmittedSqliteSchemaFacts(db)?.userVersion ?? readSqliteUserVersion(db);
  assertProtectedEncryptionAdmission(db, pathname, userVersion);
  const targetVersion = getAgentDatabaseTargetSchemaVersion(db);
  if (userVersion > targetVersion) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      pathname,
      userVersion,
      targetVersion,
    );
  }
  return userVersion;
}

/** Require an existing encrypted agent schema, without migrating plaintext state. */
export function assertRequiredProtectedAgentStorage(db: DatabaseSync, pathname: string): void {
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} requires its storage key; restore the key before starting the service.`,
    );
  }
  if (
    assertSupportedAgentSchemaVersion(db, pathname) !== PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
  ) {
    throw new SqliteSchemaMismatchError(
      `Protected agent database ${pathname} is unmarked or unencrypted; stop the service and run provision-storage-key before starting it.`,
    );
  }
}

/** Readers may pass their immediate check; writers reread the version after integrity work. */
export function assertCanonicalAgentPersistenceVersion(
  db: DatabaseSync,
  pathname: string,
  userVersion = getAdmittedSqliteSchemaFacts(db)?.userVersion ?? readSqliteUserVersion(db),
): void {
  const hasApplicationSchema =
    userVersion === 0 &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1").get();
  const isNewUnownedDatabase =
    userVersion === 0 && readExistingAgentSchemaMeta(db) === null && !hasApplicationSchema;
  if (userVersion < AGENT_MEDIA_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new OpenClawAgentDatabaseMediaMigrationRequiredError(pathname, userVersion);
  }
  if (userVersion < OPENCLAW_AGENT_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} uses schema version ${userVersion}; stop active agents and run openclaw doctor --fix to migrate session identities before using it.`,
    );
  }
}

export function assertExistingAgentSchemaOwner(
  existing: ExistingAgentSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  if (!existing) {
    return;
  }
  // Agent DB files are not interchangeable; opening another role/id would corrupt ownership.
  if (existing.role !== "agent") {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has schema role ${existing.role ?? "unknown"}; expected agent. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  if (!existing.agentId) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has no agent owner. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  if (normalizeAgentId(existing.agentId) !== agentId) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} belongs to agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
}

export function assertCurrentAgentSchemaMetadata(
  metadata: ExistingAgentSchemaMeta | null,
  agentId: string,
  pathname: string,
  schemaVersion = OPENCLAW_AGENT_SCHEMA_VERSION,
): void {
  if (!metadata) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has no schema ownership metadata. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, pathname);
  if (metadata.schemaVersion !== schemaVersion) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${schemaVersion}; run openclaw doctor --fix before using it.`,
    );
  }
}

export function assertCurrentAgentDatabaseSchemaMetadata(
  database: DatabaseSync,
  metadata: ExistingAgentSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  assertCurrentAgentSchemaMetadata(
    metadata,
    agentId,
    pathname,
    getAgentDatabaseTargetSchemaVersion(database),
  );
}
