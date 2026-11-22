import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  migrateProtectedAutomationsToEncryptedStorageInDatabase,
  readStoredDefinition,
} from "./protected-automation-storage-codec.js";

const db = new DatabaseSync(":memory:");
registerSqliteStorageValueEncryption(db, createStorageValueEncryption(Buffer.alloc(32, 7)));
db.exec(`
  CREATE TABLE protected_automations (
    id TEXT PRIMARY KEY, definition_json TEXT NOT NULL CHECK (json_valid(definition_json))
  ) STRICT;
  INSERT INTO protected_automations VALUES ('a', '{"instructions":"sensitive"}');
  INSERT INTO protected_automations VALUES ('z', '{"instructions":"retained"}');
`);

afterEach(() => {
  disposeSqliteStorageValueEncryption(db);
  db.close();
});

it("migrates automation definitions atomically and reads encrypted JSON envelopes", () => {
  db.exec(`
    CREATE TRIGGER reject_second BEFORE UPDATE ON protected_automations
    WHEN OLD.id = 'z' BEGIN SELECT RAISE(ABORT, 'replacement refused'); END;
    BEGIN IMMEDIATE;
  `);
  expect(() => migrateProtectedAutomationsToEncryptedStorageInDatabase(db)).toThrow(
    "replacement refused",
  );
  expect(
    db.prepare("SELECT definition_json FROM protected_automations WHERE id = 'a'").get(),
  ).toEqual({ definition_json: '{"instructions":"sensitive"}' });
  db.exec("ROLLBACK; DROP TRIGGER reject_second; BEGIN IMMEDIATE;");
  migrateProtectedAutomationsToEncryptedStorageInDatabase(db);
  db.exec("COMMIT");
  setSqliteStorageValueEncryptionStrict(db, true);
  const row = db
    .prepare("SELECT id, definition_json FROM protected_automations WHERE id = 'a'")
    .get();
  if (typeof row?.id !== "string" || typeof row.definition_json !== "string") {
    throw new Error("Missing migrated automation");
  }
  expect(row.definition_json).not.toContain("sensitive");
  expect(readStoredDefinition(db, { id: row.id, definition_json: row.definition_json })).toBe(
    '{"instructions":"sensitive"}',
  );
});
