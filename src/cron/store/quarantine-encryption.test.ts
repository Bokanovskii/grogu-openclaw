import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createStorageValueEncryption } from "../../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../../storage/sqlite-encryption.js";
import {
  migrateCronQuarantineToProtectedStorageInDatabase,
  prepareCronQuarantineRegistration,
  readCronQuarantinedJobsInDatabase,
  registerCronQuarantineInDatabase,
} from "./quarantine.kernel.js";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  registerSqliteStorageValueEncryption(db, createStorageValueEncryption(Buffer.alloc(32, 7)));
  db.exec(`
    CREATE TABLE diagnostic_events (
      scope TEXT NOT NULL, event_key TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, sequence INTEGER NOT NULL,
      PRIMARY KEY (scope, event_key)
    ) STRICT;
  `);
});
afterEach(() => {
  disposeSqliteStorageValueEncryption(db);
  db.close();
});

it("migrates only Cron quarantine and preserves recoverable records and deduplication", () => {
  const entry = { sourceIndex: 0, reason: "invalid-payload", job: { prompt: "private content" } };
  const registration = prepareCronQuarantineRegistration({
    storePath: "test-store",
    entries: [entry],
    nowMs: 42,
  });
  registerCronQuarantineInDatabase(db, registration);
  db.exec(`
    INSERT INTO diagnostic_events VALUES ('other', 'key', '{"ordinary":"visible"}', 1, 1);
    BEGIN IMMEDIATE;
  `);
  migrateCronQuarantineToProtectedStorageInDatabase(db);
  db.exec("COMMIT");
  setSqliteStorageValueEncryptionStrict(db, true);
  expect(readCronQuarantinedJobsInDatabase(db, "test-store")).toEqual([
    { ...entry, quarantinedAtMs: 42 },
  ]);
  registerCronQuarantineInDatabase(db, registration);
  expect(readCronQuarantinedJobsInDatabase(db, "test-store")).toHaveLength(1);
  const rows = db.prepare("SELECT scope, payload_json FROM diagnostic_events").all();
  expect(rows.find((row) => row.scope !== "other")?.payload_json).not.toContain("private content");
  expect(rows.find((row) => row.scope === "other")?.payload_json).toBe('{"ordinary":"visible"}');
});

it("rolls back all migrated values if a later quarantine write fails", () => {
  db.exec(`
    INSERT INTO diagnostic_events VALUES ('cron.quarantine:one', 'a', '{"a":1}', 1, 1);
    INSERT INTO diagnostic_events VALUES ('cron.quarantine:one', 'z', '{"z":1}', 1, 2);
    CREATE TRIGGER reject_second BEFORE UPDATE ON diagnostic_events
    WHEN OLD.event_key = 'z' BEGIN SELECT RAISE(ABORT, 'replacement refused'); END;
    BEGIN IMMEDIATE;
  `);
  expect(() => migrateCronQuarantineToProtectedStorageInDatabase(db)).toThrow(
    "replacement refused",
  );
  expect(
    db.prepare("SELECT payload_json FROM diagnostic_events WHERE event_key = 'a'").get(),
  ).toEqual({ payload_json: '{"a":1}' });
  db.exec("ROLLBACK");
});
