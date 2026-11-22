import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectCronOwnerRowsForDoctor,
  inspectCronRowsForDoctor,
} from "../../commands/doctor/cron/store-inventory.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { backfillCronJobsFromJobJson } from "../../state/openclaw-state-db-legacy-backfills.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createStorageValueEncryption } from "../../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../../storage/sqlite-encryption.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { fingerprintCronRuntimeRows, readCronJobsFingerprint } from "./fingerprint.js";
import { migrateCronJobsToProtectedStorageInDatabase, sealCronJobValue } from "./job-encryption.js";
import { readCronJobNamesInDatabase } from "./job-name.kernel.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  updateCronRuntimeRow,
  upsertCronJobRow,
} from "./row-codec.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    disposeSqliteStorageValueEncryption(db);
    db.close();
  }
});

function createDatabase(onDecrypt?: (value: Buffer, db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const encryption = createStorageValueEncryption(Buffer.alloc(32, 19));
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
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "cron_jobs"));
  return db;
}

function sampleJob(id = "job-1") {
  return makeCronJob({
    id,
    name: "private name",
    description: "private description",
    createdAtMs: 100,
    updatedAtMs: 100,
    payload: { kind: "agentTurn", message: "private message" },
    state: { triggerState: { cursor: "private cursor" } },
  });
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateCronJobsToProtectedStorageInDatabase(db);
  db.exec("COMMIT");
  setSqliteStorageValueEncryptionStrict(db, true);
}

describe("protected Cron job rows", () => {
  it("migrates private content while preserving planning, Doctor and fingerprints", () => {
    const db = createDatabase();
    const job = sampleJob();
    upsertCronJobRow(db, "store", job, 0);
    const beforeRows = loadCronRows(db, "store");
    const beforeJobFingerprint = readCronJobsFingerprint(db, "store");
    const beforeRuntimeFingerprint = fingerprintCronRuntimeRows(beforeRows);
    const beforeDoctor = inspectCronRowsForDoctor(db);
    migrate(db);

    const stored = db
      .prepare("SELECT name, description, job_json, state_json, schedule_identity FROM cron_jobs")
      .get();
    for (const value of Object.values(stored ?? {})) {
      expect(value).toMatch(/^OCSEAL1:/);
      expect(value).not.toContain("private");
    }
    expect(loadCronRows(db, "store")).toEqual(beforeRows);
    expect(readCronJobsFingerprint(db, "store")).toBe(beforeJobFingerprint);
    expect(fingerprintCronRuntimeRows(loadCronRows(db, "store"))).toBe(beforeRuntimeFingerprint);
    expect(inspectCronRowsForDoctor(db)).toEqual(beforeDoctor);
    expect(inspectCronOwnerRowsForDoctor(db, "store")[0]?.job_json).toContain("private message");
    expect(readCronJobNamesInDatabase(db, [job.id], "store").get(job.id)).toBe("private name");
    expect(loadedCronStoreFromRows(loadCronRows(db, "store")).store.jobs[0]).toMatchObject({
      name: "private name",
      description: "private description",
      state: { triggerState: { cursor: "private cursor" } },
    });

    updateCronRuntimeRow(db, "store", job);
    expect(readCronJobsFingerprint(db, "store")).toBe(beforeJobFingerprint);
    expect(fingerprintCronRuntimeRows(loadCronRows(db, "store"))).toBe(beforeRuntimeFingerprint);
    upsertCronJobRow(db, "store", job, 0);
    expect(db.prepare("SELECT grant_definition_generation FROM cron_jobs").get()).toEqual({
      grant_definition_generation: 1,
    });
  });

  it("repairs legacy job projections without exposing protected names", () => {
    const db = createDatabase();
    const job = sampleJob();
    upsertCronJobRow(db, "store", job, 0);
    migrate(db);
    db.prepare("UPDATE cron_jobs SET name = ?, payload_kind = 'message'").run(
      sealCronJobValue(db, "store", job.id, "name", ""),
    );

    backfillCronJobsFromJobJson(db);

    expect(readCronJobNamesInDatabase(db, [job.id], "store").get(job.id)).toBe("private name");
    expect(loadCronRows(db, "store")[0]?.payload_kind).toBe("agentTurn");
    expect(db.prepare("SELECT name FROM cron_jobs").get()?.name).toMatch(/^OCSEAL1:/);
  });

  it("updates enabled atomically and invalidates a stale definition generation guard", () => {
    const db = createDatabase();
    const job = sampleJob();
    upsertCronJobRow(db, "store", job, 0);
    migrate(db);
    const disabled = { ...job, enabled: false };
    updateCronRuntimeRow(db, "store", disabled, true);
    expect(loadedCronStoreFromRows(loadCronRows(db, "store")).store.jobs[0]?.enabled).toBe(false);
    const stored = db.prepare("SELECT enabled, job_json FROM cron_jobs").get();
    expect(stored?.enabled).toBe(0);
    expect(stored?.job_json).toMatch(/^OCSEAL1:/);

    const snapshot = loadCronRows(db, "store", new Set([job.id]), {
      includeGrantDefinitionProjection: true,
    })[0]!;
    const changed = { ...JSON.parse(snapshot.job_json), description: "concurrent edit" };
    db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
      sealCronJobValue(db, "store", job.id, "job_json", JSON.stringify(changed)),
      "store",
      job.id,
    );
    upsertCronJobRow(db, "store", disabled, 0, { knownExistingRow: snapshot });
    expect(db.prepare("SELECT grant_definition_generation FROM cron_jobs").get()).toEqual({
      grant_definition_generation: 2,
    });
  });

  it("rolls back all rows if SQLite ciphertext readback fails", () => {
    let decryptions = 0;
    const db = createDatabase((value, database) => {
      decryptions += 1;
      if (decryptions === 6) {
        expect(
          database.prepare("SELECT name FROM cron_jobs WHERE job_id = 'job-2'").get()?.name,
        ).toBe(`OCSEAL1:${value.toString("base64")}`);
        throw new Error("injected job readback failure");
      }
    });
    upsertCronJobRow(db, "store", sampleJob(), 0);
    upsertCronJobRow(db, "store", sampleJob("job-2"), 1);
    const before = db.prepare("SELECT * FROM cron_jobs ORDER BY job_id").all();
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateCronJobsToProtectedStorageInDatabase(db)).toThrow(
      "injected job readback failure",
    );
    db.exec("COMMIT");
    expect(db.prepare("SELECT * FROM cron_jobs ORDER BY job_id").all()).toEqual(before);
  });

  it("rejects a private definition copied to another job", () => {
    const db = createDatabase();
    upsertCronJobRow(db, "store", sampleJob(), 0);
    upsertCronJobRow(db, "store", sampleJob("job-2"), 1);
    migrate(db);
    db.prepare(`
      UPDATE cron_jobs SET job_json = (SELECT job_json FROM cron_jobs WHERE job_id = 'job-1')
       WHERE job_id = 'job-2'
    `).run();
    expect(() => loadCronRows(db, "store")).toThrow();
  });

  it("keeps personal rows plaintext, including envelope-like content and nulls", () => {
    const db = createDatabase();
    const job = { ...sampleJob(), name: "OCSEAL1:literal", description: undefined };
    upsertCronJobRow(db, "store", job, 0);
    db.prepare("UPDATE cron_jobs SET schedule_identity = NULL").run();
    expect(readCronJobNamesInDatabase(db, [job.id], "store").get(job.id)).toBe("OCSEAL1:literal");
    expect(db.prepare("SELECT name, description, schedule_identity FROM cron_jobs").get()).toEqual({
      name: "OCSEAL1:literal",
      description: null,
      schedule_identity: null,
    });
    migrate(db);
    expect(readCronJobNamesInDatabase(db, [job.id], "store").get(job.id)).toBe("OCSEAL1:literal");
    expect(db.prepare("SELECT description, schedule_identity FROM cron_jobs").get()).toEqual({
      description: null,
      schedule_identity: null,
    });
  });
});
