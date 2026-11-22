import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import * as stateReadOnly from "../../state/openclaw-state-db-readonly.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import { mergeUserModelAccounts } from "../../state/user-model-accounts.js";
import { createStorageValueEncryption } from "../../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  registerSqliteStorageValueEncryption,
  sealSqliteStoragePlaintext,
  setSqliteStorageValueEncryptionStrict,
} from "../../storage/sqlite-encryption.js";
import { migrateSecretStoreToProtectedStorageInDatabase } from "./secret-store-encryption.js";
import {
  listHiddenGitHubSecretRecordNames,
  readHiddenGitHubSecretRecord,
  readPersonalGitHubSecret,
  writePersonalGitHubSecret,
} from "./secret-store-hidden-github.js";
import { secretStoreReadOperations } from "./secret-store-metadata.kernel.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  registerSqliteStorageValueEncryption(db, createStorageValueEncryption(Buffer.alloc(32, 7)));
  ensureSecretStoreSchema(db);
  setSqliteStorageValueEncryptionStrict(db, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeSqliteStorageValueEncryption(db);
  db.close();
});

it("opens and registers hidden GitHub values for exact reads and lists", () => {
  const name = "github-oauth-11111111111111111111111111111111";
  const value = "synthetic-hidden-github-token";
  const context = protectedStorageValueContext("secret_store_entries", "value", ["team", "", name]);
  const stored = sealSqliteStoragePlaintext(db, value, context);
  const now = Date.now();
  db.prepare(
    "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms) VALUES ('team', '', ?, ?, 'secret', ?, ?)",
  ).run(name, stored, now, now);
  vi.spyOn(stateReadOnly, "withExistingOpenClawStateDatabaseReadOnly").mockImplementation(
    (operation) => operation({ db, path: ":memory:" }),
  );
  resetSecretRedactionRegistryForTest();
  expect(readHiddenGitHubSecretRecord({ name })).toBe(value);
  expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  resetSecretRedactionRegistryForTest();
  expect(listHiddenGitHubSecretRecordNames({ prefix: "github-oauth" })).toEqual([name]);
  expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
});

it("stores opaque personal values as bounded ciphertext only in strict mode", () => {
  const value = "OCSEAL1:opaque-personal-value";
  writePersonalGitHubSecret(db, "alice", value);
  const stored = db
    .prepare("SELECT value FROM secret_store_entries WHERE scope_id = ?")
    .get("alice")?.value;
  expect(stored).not.toContain(value);
  expect(readPersonalGitHubSecret(db, "alice")).toBe(value);
  expect(() => writePersonalGitHubSecret(db, "alice", "x".repeat(32_768))).toThrow("exceeds 65536");
  expect(readPersonalGitHubSecret(db, "alice")).toBe(value);

  setSqliteStorageValueEncryptionStrict(db, false);
  writePersonalGitHubSecret(db, "bob", value);
  expect(readPersonalGitHubSecret(db, "bob")).toBe(value);
  expect(
    db.prepare("SELECT value FROM secret_store_entries WHERE scope_id = ?").get("bob")?.value,
  ).toBe(value);
});

it("opens team values at the worker read boundary while retaining kind and host policy", () => {
  const context = protectedStorageValueContext("secret_store_entries", "value", [
    "team",
    "",
    "EXAMPLE",
  ]);
  const stored = sealSqliteStoragePlaintext(db, "opaque-value", context);
  db.prepare(
    "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, allowed_hosts, created_at_ms, updated_at_ms) VALUES ('team', '', 'EXAMPLE', ?, 'secret', ?, 1, 1)",
  ).run(stored, '["example.test"]');
  expect(secretStoreReadOperations["secrets.value"]({ name: "EXAMPLE" }, db).row).toEqual({
    value: "opaque-value",
    kind: "secret",
  });
  expect(
    secretStoreReadOperations["secrets.execEnvironment"]({ excludeNames: [] }, db).rows,
  ).toEqual([
    {
      name: "EXAMPLE",
      value: "opaque-value",
      kind: "secret",
      allowed_hosts: '["example.test"]',
    },
  ]);
  expect(
    secretStoreReadOperations["secrets.metadata"]({ scope: { kind: "team" } }, db).rows[0]?.value,
  ).toBe("opaque-value");
});

it("rebinds opaque account ciphertext to the target owner during merge", () => {
  db.exec(
    "CREATE TABLE user_profiles (id TEXT PRIMARY KEY, merged_into TEXT); INSERT INTO user_profiles VALUES ('alice', NULL), ('bob', NULL)",
  );
  const name = "model-account:synthetic";
  const value = 'OCSEAL1:{"token":"opaque"}';
  const sourceContext = protectedStorageValueContext("secret_store_entries", "value", [
    "identity",
    "alice",
    name,
  ]);
  const targetContext = protectedStorageValueContext("secret_store_entries", "value", [
    "identity",
    "bob",
    name,
  ]);
  const sourceCiphertext = sealSqliteStoragePlaintext(db, value, sourceContext);
  db.prepare(
    "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, allowed_hosts, created_at_ms, updated_at_ms) VALUES ('identity', 'alice', ?, ?, 'secret', ?, 1, 2)",
  ).run(name, sourceCiphertext, '["example.test"]');
  db.exec("BEGIN");
  mergeUserModelAccounts(db, "alice", "bob");
  db.exec("COMMIT");
  const row = db
    .prepare("SELECT value, kind, allowed_hosts FROM secret_store_entries WHERE scope_id = 'bob'")
    .get();
  expect(row).toMatchObject({ kind: "secret", allowed_hosts: '["example.test"]' });
  expect(typeof row?.value).toBe("string");
  if (typeof row?.value !== "string") {
    throw new Error("Missing merged account");
  }
  const mergedValue = row.value;
  expect(openSqliteStorageText(db, mergedValue, targetContext)).toBe(value);
  expect(() => openSqliteStorageText(db, mergedValue, sourceContext)).toThrow();
  expect(db.prepare("SELECT name FROM secret_store_entries WHERE scope_id = 'alice'").get()).toBe(
    undefined,
  );
});

it("migrates retained opaque values atomically, including deleted entries and ciphertext limits", () => {
  setSqliteStorageValueEncryptionStrict(db, false);
  const insert = db.prepare(`
    INSERT INTO secret_store_entries
      (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms, deleted_at_ms)
    VALUES ('team', '', ?, ?, 'secret', 1, 1, ?)
  `);
  const opaque = 'OCSEAL1:{"token":"unchanged"}';
  insert.run("A", opaque, null);
  insert.run("Z", "x".repeat(32_768), 1);
  db.exec("BEGIN IMMEDIATE");
  expect(() => migrateSecretStoreToProtectedStorageInDatabase(db)).toThrow("exceeds 65536");
  expect(db.prepare("SELECT value FROM secret_store_entries WHERE name = 'A'").get()?.value).toBe(
    opaque,
  );
  db.exec("ROLLBACK");
  db.prepare("DELETE FROM secret_store_entries WHERE name = 'Z'").run();
  insert.run("Z", "deleted opaque", 1);
  db.exec("BEGIN IMMEDIATE");
  migrateSecretStoreToProtectedStorageInDatabase(db);
  db.exec("COMMIT");
  setSqliteStorageValueEncryptionStrict(db, true);
  for (const [name, expected] of [
    ["A", opaque],
    ["Z", "deleted opaque"],
  ] as const) {
    const stored = db
      .prepare("SELECT value, deleted_at_ms FROM secret_store_entries WHERE name = ?")
      .get(name);
    expect(typeof stored?.value).toBe("string");
    if (typeof stored?.value !== "string") {
      throw new Error("Missing migrated value");
    }
    expect(stored.value).not.toContain(expected);
    expect(
      openSqliteStorageText(
        db,
        stored.value,
        protectedStorageValueContext("secret_store_entries", "value", ["team", "", name]),
      ),
    ).toBe(expected);
    expect(stored.deleted_at_ms).toBe(name === "Z" ? 1 : null);
  }
});
