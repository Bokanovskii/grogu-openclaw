import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";
import type { SecretStoreKind } from "./secret-store.types.js";

type SecretStoreIdentity = {
  scope_kind: string;
  scope_id: string;
  name: string;
};

function context(identity: SecretStoreIdentity): string {
  return protectedStorageValueContext("secret_store_entries", "value", [
    identity.scope_kind,
    identity.scope_id,
    identity.name,
  ]);
}

export function openSecretStoreValue(
  db: DatabaseSync,
  identity: SecretStoreIdentity,
  value: string,
): string {
  if (!isSqliteStorageValueEncryptionStrict(db)) {
    return value;
  }
  assertSecretStoreValueLength(value, "env");
  return openSqliteStorageText(db, value, context(identity));
}

export function sealSecretStoreValue(
  db: DatabaseSync,
  identity: SecretStoreIdentity,
  value: string,
  kind: SecretStoreKind,
): string {
  if (!isSqliteStorageValueEncryptionStrict(db)) {
    return value;
  }
  const sealed = sealSqliteStoragePlaintext(db, value, context(identity));
  assertSecretStoreValueLength(sealed, kind);
  return sealed;
}

/** Rewrites every retained value, including deleted entries, in the schema transaction. */
export function migrateSecretStoreToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Secret store encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Secret store encryption migration requires the protected storage key.");
  }
  if (!tableExists(db, "secret_store_entries")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: schema migration streams values through their owning connection.
    const rows = db.prepare(`
      SELECT scope_kind, scope_id, name, value, kind FROM secret_store_entries
      ORDER BY scope_kind, scope_id, name
    `);
    const update = db.prepare(`
      UPDATE secret_store_entries SET value = ?
      WHERE scope_kind = ? AND scope_id = ? AND name = ?
    `);
    const readback = db.prepare(`
      SELECT value FROM secret_store_entries
      WHERE scope_kind = ? AND scope_id = ? AND name = ?
    `);
    for (const row of rows.iterate()) {
      if (
        (row.scope_kind !== "team" && row.scope_kind !== "identity") ||
        typeof row.scope_id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.value !== "string" ||
        (row.kind !== "secret" && row.kind !== "env")
      ) {
        throw new Error("Secret store encryption migration found an invalid row.");
      }
      const identity = { scope_kind: row.scope_kind, scope_id: row.scope_id, name: row.name };
      const sealed = sealSqliteStoragePlaintext(db, row.value, context(identity));
      assertSecretStoreValueLength(sealed, row.kind);
      const result = update.run(sealed, row.scope_kind, row.scope_id, row.name);
      const stored = readback.get(row.scope_kind, row.scope_id, row.name)?.value;
      if (
        (result.changes !== 1 && result.changes !== 1n) ||
        typeof stored !== "string" ||
        stored !== sealed ||
        openSqliteStorageText(db, stored, context(identity)) !== row.value
      ) {
        throw new Error("Secret store encryption migration could not verify its stored value.");
      }
    }
  });
}
