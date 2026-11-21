import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  sealSqliteStorageText,
} from "../../storage/sqlite-encryption.js";

export const PROTECTED_SESSION_ENTRY_TABLE = "grogu_protected_session_entries";
const PROTECTED_SESSION_ENTRY_CONTEXT = "openclaw:protected-session-entry:";

type ProtectedSessionEntryDatabase = {
  grogu_protected_session_entries: {
    session_key: string;
    encrypted_entry_json: string;
  };
};

const SESSION_ENTRY_REFERENCE_FIELDS = [
  "sessionId",
  "updatedAt",
  "previousSessionId",
  "usageFamilySessionIds",
  "compactionCheckpoints",
  "parentSessionKey",
  "spawnedBy",
  "forkSource",
] as const;

export function protectedSessionEntryContext(sessionKey: string): string {
  if (!sessionKey) {
    throw new Error("Protected session entry storage requires a session key.");
  }
  return `${PROTECTED_SESSION_ENTRY_CONTEXT}${sessionKey}`;
}

export function hasProtectedSessionEntryStorage(database: DatabaseSync): boolean {
  const facts = getAdmittedSqliteSchemaFacts(database);
  if (!facts) {
    if (hasSqliteStorageValueEncryption(database)) {
      throw new Error("Protected session entry storage requires admitted schema facts.");
    }
    return false;
  }
  return facts.tables.has(PROTECTED_SESSION_ENTRY_TABLE);
}

export function protectedSessionEntryPayloadSql(database: DatabaseSync, alias = "session_nodes") {
  if (!/^[a-z][a-z0-9_]*$/u.test(alias)) {
    throw new Error("Protected session entry query requires a canonical table alias.");
  }
  if (!hasProtectedSessionEntryStorage(database)) {
    return undefined;
  }
  return /* kysely-allow-raw: this owner-bound scalar selects only the encrypted session entry value. */ sql<
    string | null
  >`(SELECT protected_entry.encrypted_entry_json
      FROM ${sql.table(PROTECTED_SESSION_ENTRY_TABLE)} AS protected_entry
      WHERE protected_entry.session_key = ${sql.ref(`${alias}.session_key`)})`;
}

export function sessionEntryJsonSql(database: DatabaseSync, alias = "session_nodes") {
  const protectedEntry = protectedSessionEntryPayloadSql(database, alias);
  if (!protectedEntry) {
    return sql.ref<string>(`${alias}.entry_json`);
  }
  const context = sql`${PROTECTED_SESSION_ENTRY_CONTEXT} || ${sql.ref(`${alias}.session_key`)}`;
  return /* kysely-allow-raw: this owner-bound expression opens metadata only for the current SQLite reader and rejects missing ciphertext except for empty lifecycle placeholders. */ sql<string>`CASE
    WHEN ${sql.ref(`${alias}.entry_json`)} = '{}' AND ${protectedEntry} IS NULL THEN '{}'
    ELSE openclaw_storage_text_open(COALESCE(${protectedEntry}, 'OCSEAL1:'), ${context})
  END`;
}

export function openProtectedSessionEntryJson(
  database: DatabaseSync,
  sessionKey: string,
  projectedJson: string,
  encryptedJson: string | null | undefined,
): string {
  if (!hasProtectedSessionEntryStorage(database)) {
    return projectedJson;
  }
  if (projectedJson === "{}" && encryptedJson == null) {
    return projectedJson;
  }
  if (typeof encryptedJson !== "string") {
    throw new Error(
      "Protected session entry ciphertext is missing; refuse partial session metadata.",
    );
  }
  return openSqliteStorageText(database, encryptedJson, protectedSessionEntryContext(sessionKey));
}

export function protectSessionEntryProjection(entryJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(entryJson);
  } catch {
    return "{}";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "{}";
  }
  const record = value as Record<string, unknown>;
  const projection: Record<string, unknown> = {};
  for (const field of SESSION_ENTRY_REFERENCE_FIELDS) {
    if (Object.hasOwn(record, field)) {
      projection[field] = record[field];
    }
  }
  return JSON.stringify(projection);
}

export function writeProtectedSessionEntryJson(
  database: DatabaseSync,
  sessionKey: string,
  entryJson: string,
): void {
  if (!database.isTransaction || !hasProtectedSessionEntryStorage(database)) {
    throw new Error("Protected session entry writes require the admitted entry transaction.");
  }
  const context = protectedSessionEntryContext(sessionKey);
  const encryptedEntryJson = sealSqliteStorageText(database, entryJson, context);
  if (openSqliteStorageText(database, encryptedEntryJson, context) !== entryJson) {
    throw new Error("Protected session entry write failed read-back verification.");
  }
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ProtectedSessionEntryDatabase>(database)
      .insertInto(PROTECTED_SESSION_ENTRY_TABLE)
      .values({ session_key: sessionKey, encrypted_entry_json: encryptedEntryJson })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet((eb) => ({
          encrypted_entry_json: eb.ref("excluded.encrypted_entry_json"),
        })),
      ),
  );
}
