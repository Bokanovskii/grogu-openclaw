import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  CRON_JOB_SCRATCH_MAX_BYTES,
  CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES,
} from "./scratch-contract.js";
import { migrateCronScratchToProtectedStorageInDatabase } from "./scratch-encryption.js";
import {
  readHeartbeatMonitorScratchFromDatabase,
  readScratchStateFromDatabase,
} from "./scratch-read.kernel.js";
import { writeCronJobScratchInDatabase } from "./scratch-write.kernel.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    disposeSqliteStorageValueEncryption(db);
    db.close();
  }
});

function createDatabase(
  limit = CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES,
  onDecrypt?: (value: Buffer, db: DatabaseSync) => void,
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const encryption = createStorageValueEncryption(Buffer.alloc(32, 7));
  registerSqliteStorageValueEncryption(
    db,
    onDecrypt
      ? {
          ...encryption,
          decryptText(value, context) {
            onDecrypt(value, db);
            return encryption.decryptText(value, context);
          },
        }
      : encryption,
  );
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, declaration_key TEXT, payload_kind TEXT NOT NULL,
      PRIMARY KEY (store_key, job_id)
    ) STRICT;
    CREATE TABLE cron_job_scratch (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, content TEXT, revision INTEGER NOT NULL,
      source_sha256 TEXT, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (store_key, job_id),
      CHECK (content IS NULL OR length(CAST(content AS BLOB)) <= ${limit})
    ) STRICT;
    INSERT INTO cron_jobs VALUES ('store', 'job', 'heartbeat:alpha', 'heartbeat');
  `);
  return db;
}

function write(db: DatabaseSync, content: string | null, expectedRevision: number) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = writeCronJobScratchInDatabase(db, {
      storeKey: "store",
      jobId: "job",
      content,
      expectedRevision,
      nowMs: 42,
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("cron scratch protected storage", () => {
  it("keeps personal values plaintext even when they resemble an envelope", () => {
    const db = createDatabase(CRON_JOB_SCRATCH_MAX_BYTES);
    const content = "OCSEAL1:personal";
    expect(write(db, content, 0).result).toMatchObject({ ok: true, currentRevision: 1 });
    expect(db.prepare("SELECT content FROM cron_job_scratch").get()?.content).toBe(content);
    expect(readScratchStateFromDatabase(db, "store", "job").scratch?.content).toBe(content);
  });

  it("migrates existing content and preserves protected writes, revisions and tombstones", () => {
    const db = createDatabase();
    const content = `OCSEAL1:${"x".repeat(CRON_JOB_SCRATCH_MAX_BYTES - 8)}`;
    write(db, content, 0);
    db.exec("INSERT INTO cron_job_scratch VALUES ('store', 'tombstone', NULL, 5, NULL, 42)");
    db.exec("BEGIN IMMEDIATE");
    migrateCronScratchToProtectedStorageInDatabase(db);
    db.exec("COMMIT");
    const stored = db
      .prepare("SELECT content, revision FROM cron_job_scratch WHERE job_id = 'job'")
      .get();
    expect(stored?.revision).toBe(1);
    expect(stored?.content).not.toContain(content);
    expect(Buffer.byteLength(String(stored?.content))).toBe(
      CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES,
    );
    expect(readScratchStateFromDatabase(db, "store", "tombstone")).toEqual({ currentRevision: 5 });
    setSqliteStorageValueEncryptionStrict(db, true);
    expect(readScratchStateFromDatabase(db, "store", "job").scratch?.content).toBe(content);
    expect(
      readHeartbeatMonitorScratchFromDatabase(db, "store", "alpha")?.state.scratch?.content,
    ).toBe(content);
    expect(write(db, "updated", 0).result).toEqual({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 1,
    });
    expect(write(db, "updated", 1).result).toMatchObject({ ok: true, currentRevision: 2 });
    expect(
      db.prepare("SELECT content FROM cron_job_scratch WHERE job_id = 'job'").get()?.content,
    ).not.toContain("updated");
    expect(readScratchStateFromDatabase(db, "store", "job").scratch?.content).toBe("updated");
    db.exec(`
      INSERT INTO cron_job_scratch
      SELECT store_key, 'other-job', content, revision, source_sha256, updated_at_ms
        FROM cron_job_scratch WHERE job_id = 'job'
    `);
    expect(() => readScratchStateFromDatabase(db, "store", "other-job")).toThrow();
    expect(write(db, "unpaired \ud800", 2).result).toMatchObject({ ok: true, currentRevision: 3 });
    expect(readScratchStateFromDatabase(db, "store", "job").scratch?.content).toBe(
      "unpaired \ufffd",
    );
    expect(write(db, null, 3).result).toMatchObject({ ok: true, currentRevision: 4 });
    expect(readScratchStateFromDatabase(db, "store", "job")).toEqual({ currentRevision: 4 });
    expect(() => write(db, "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), 4)).toThrow(
      "cron scratch exceeds",
    );
  });

  it("verifies ciphertext read from staging before replacing the original", () => {
    let decryptions = 0;
    const db = createDatabase(CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES, (value, database) => {
      decryptions++;
      expect(database.isTransaction).toBe(true);
      expect(
        database.prepare("SELECT content FROM cron_job_scratch WHERE job_id = 'job'").get()
          ?.content,
      ).toBe("original scratch");
      expect(
        database
          .prepare("SELECT content FROM cron_job_scratch_encryption_stage WHERE job_id = 'job'")
          .get()?.content,
      ).toBe(`OCSEAL1:${value.toString("base64")}`);
    });
    write(db, "original scratch", 0);
    db.exec("BEGIN IMMEDIATE");
    migrateCronScratchToProtectedStorageInDatabase(db);
    expect(decryptions).toBeGreaterThan(0);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_job_scratch_encryption_stage'")
        .get(),
    ).toBeUndefined();
    db.exec("COMMIT");
  });

  it("rolls back when decrypting the ciphertext read back from SQLite fails", () => {
    let sawStoredCiphertext = false;
    const db = createDatabase(CRON_JOB_SCRATCH_PROTECTED_MAX_STORED_BYTES, (value, database) => {
      expect(
        database
          .prepare("SELECT content FROM cron_job_scratch_encryption_stage WHERE job_id = 'job'")
          .get()?.content,
      ).toBe(`OCSEAL1:${value.toString("base64")}`);
      sawStoredCiphertext = true;
      throw new Error("injected staged readback failure");
    });
    write(db, "original scratch", 0);
    db.exec(`
      INSERT INTO cron_job_scratch VALUES ('store', 'tombstone', NULL, 5, NULL, 42);
      BEGIN IMMEDIATE;
    `);
    expect(() => migrateCronScratchToProtectedStorageInDatabase(db)).toThrow(
      "injected staged readback failure",
    );
    expect(sawStoredCiphertext).toBe(true);
    expect(
      db.prepare("SELECT content, revision FROM cron_job_scratch WHERE job_id = 'job'").get(),
    ).toEqual({ content: "original scratch", revision: 1 });
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_job_scratch_encryption_stage'")
        .get(),
    ).toBeUndefined();
    db.exec("COMMIT");
    expect(readScratchStateFromDatabase(db, "store", "tombstone")).toEqual({ currentRevision: 5 });
  });

  it("rolls back replacement and removes staging on failure even if the caller commits", () => {
    const db = createDatabase();
    write(db, "first", 0);
    db.exec(`
      INSERT INTO cron_job_scratch VALUES ('store', 'zzz', 'second', 7, NULL, 42);
      CREATE TRIGGER reject_second BEFORE UPDATE ON cron_job_scratch
      WHEN OLD.job_id = 'zzz'
      BEGIN SELECT RAISE(ABORT, 'replacement refused'); END;
      BEGIN IMMEDIATE;
    `);
    expect(() => migrateCronScratchToProtectedStorageInDatabase(db)).toThrow("replacement refused");
    expect(
      db.prepare("SELECT content FROM cron_job_scratch WHERE job_id = 'job'").get()?.content,
    ).toBe("first");
    expect(
      db.prepare("SELECT content FROM cron_job_scratch WHERE job_id = 'zzz'").get()?.content,
    ).toBe("second");
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_job_scratch_encryption_stage'")
        .get(),
    ).toBeUndefined();
    db.exec("COMMIT");
  });

  it("refuses plaintext in strict mode and rolls back an undersized migration", () => {
    const db = createDatabase(CRON_JOB_SCRATCH_MAX_BYTES);
    const content = "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES);
    write(db, content, 0);
    expect(() => migrateCronScratchToProtectedStorageInDatabase(db)).toThrow(
      "requires an unencrypted transaction",
    );
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateCronScratchToProtectedStorageInDatabase(db)).toThrow();
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT content FROM cron_job_scratch").get()?.content).toBe(content);
    setSqliteStorageValueEncryptionStrict(db, true);
    expect(() => readScratchStateFromDatabase(db, "store", "job")).toThrow("unencrypted value");
  });
});
