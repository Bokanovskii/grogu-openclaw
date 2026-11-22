import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
  sealSqliteStorageText,
} from "../storage/sqlite-encryption.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { ProtectedAutomationDatabase } from "./protected-automations.js";

export function protectedAutomationDefinitionContext(id: string): string {
  return protectedStorageValueContext("protected_automations", "definition_json", [id]);
}

export function storedDefinition(db: DatabaseSync, id: string, definitionJson: string): string {
  if (!isSqliteStorageValueEncryptionStrict(db)) {
    return definitionJson;
  }
  // The existing schema requires valid JSON, including for protected ciphertext.
  return JSON.stringify(
    sealSqliteStorageText(db, definitionJson, protectedAutomationDefinitionContext(id)),
  );
}

export function storedDefinitionBytes(db: DatabaseSync, id: string): number {
  const row = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ProtectedAutomationDatabase>(db)
      .selectFrom("protected_automations")
      .select(sql<number>`length(CAST(definition_json AS BLOB))`.as("bytes"))
      .where("id", "=", id),
  ).rows[0];
  if (!row) {
    throw new Error("Protected automation disappeared while measuring its stored size.");
  }
  return row.bytes;
}

export function assertStoredDefinitionBytes(
  db: DatabaseSync,
  id: string,
  expected: number,
): number {
  const bytes = storedDefinitionBytes(db, id);
  if (bytes !== expected) {
    throw new Error("Protected automation stored size did not match its write.");
  }
  return bytes;
}

export function readStoredDefinition(
  db: DatabaseSync,
  row: { id: string; definition_json: string },
): string {
  if (!isSqliteStorageValueEncryptionStrict(db)) {
    return row.definition_json;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(row.definition_json);
  } catch {
    throw new Error("Stored protected automation envelope is invalid JSON.");
  }
  if (typeof envelope !== "string") {
    throw new Error("Stored protected automation envelope is invalid.");
  }
  return openSqliteStorageText(db, envelope, protectedAutomationDefinitionContext(row.id));
}

/** Rewrites existing definitions within the shared-state schema transaction. */
export function migrateProtectedAutomationsToEncryptedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Protected automation migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected automation migration requires the protected storage key.");
  }
  if (!tableExists(db, "protected_automations")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: migration streams definitions through the admitted schema connection.
    const rows = db.prepare("SELECT id, definition_json FROM protected_automations ORDER BY id");
    const update = db.prepare("UPDATE protected_automations SET definition_json = ? WHERE id = ?");
    const readback = db.prepare("SELECT definition_json FROM protected_automations WHERE id = ?");
    for (const row of rows.iterate()) {
      if (typeof row.id !== "string" || typeof row.definition_json !== "string") {
        throw new Error("Protected automation migration found an invalid definition.");
      }
      const owner = protectedAutomationDefinitionContext(row.id);
      const sealed = JSON.stringify(sealSqliteStoragePlaintext(db, row.definition_json, owner));
      const result = update.run(sealed, row.id);
      const stored = readback.get(row.id)?.definition_json;
      if (
        (result.changes !== 1 && result.changes !== 1n) ||
        typeof stored !== "string" ||
        stored !== sealed
      ) {
        throw new Error("Protected automation migration could not verify its stored definition.");
      }
      const envelope: unknown = JSON.parse(stored);
      if (
        typeof envelope !== "string" ||
        openSqliteStorageText(db, envelope, owner) !== row.definition_json
      ) {
        throw new Error("Protected automation migration could not open its stored definition.");
      }
    }
  });
}
