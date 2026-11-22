import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createStorageValueEncryption } from "../../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../../storage/sqlite-encryption.js";
import { cronRunLogEntryToDetail } from "../run-history-detail.js";
import { findCronRunRecoveryInDatabase } from "../service/run-history-recovery.js";
import { migrateCronHistoryToProtectedStorageInDatabase } from "./run-history-encryption.js";
import {
  pruneCronRunHistoryInDatabase,
  readCronRunRecordsInDatabase,
  reconcileCronRunHistoryInDatabase,
  recordCronRunInDatabase,
} from "./run-history.kernel.js";

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
  const encryption = createStorageValueEncryption(Buffer.alloc(32, 11));
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
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "task_runs"));
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "task_delivery_state"));
  return db;
}

function insertRetainedRow(
  db: DatabaseSync,
  params: {
    taskId: string;
    runtime?: string;
    status?: string;
    runId?: string;
    detail?: string | null;
  },
) {
  db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, task, label, progress_summary, terminal_summary, error, detail_json,
      source_id, run_id, owner_key, scope_kind, status, delivery_status, notify_policy,
      created_at, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'job', ?, '', 'system', ?, 'not_applicable', 'silent',
      10, 10, ?)
  `).run(
    params.taskId,
    params.runtime ?? "cron",
    "legacy task",
    "private label",
    "private progress",
    "private summary",
    "OCSEAL1:legacy error",
    params.detail ?? null,
    params.runId ?? null,
    params.status ?? "succeeded",
    params.status === "running" ? null : 20,
  );
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateCronHistoryToProtectedStorageInDatabase(db);
  db.exec("COMMIT");
  setSqliteStorageValueEncryptionStrict(db, true);
}

describe("protected Cron run history", () => {
  it("migrates only Cron rows and preserves SQL planning and receipt recovery", () => {
    const db = createDatabase();
    const detail = cronRunLogEntryToDetail(
      {
        jobId: "job",
        action: "finished",
        ts: 20,
        status: "ok",
        runId: "receipt",
        triggerFired: true,
      },
      { storeKey: "store", triggerEval: { fired: true, stateChanged: true, state: { secret: 1 } } },
    );
    insertRetainedRow(db, {
      taskId: "cron-row",
      runId: "cron:job:10:receipt",
      detail: JSON.stringify(detail),
    });
    insertRetainedRow(db, { taskId: "malformed", detail: "{malformed" });
    insertRetainedRow(db, { taskId: "scalar-fields", detail: '{"kind":true,"storeKey":false}' });
    insertRetainedRow(db, { taskId: "other", runtime: "task", status: "running" });
    const personalPlanning = readCronRunRecordsInDatabase(db, undefined, undefined, {
      planningOnly: true,
    });
    const otherBefore = db.prepare("SELECT * FROM task_runs WHERE task_id = 'other'").get();
    migrate(db);
    expect(db.prepare("SELECT * FROM task_runs WHERE task_id = 'other'").get()).toEqual(
      otherBefore,
    );
    const stored = db
      .prepare(
        "SELECT task, label, progress_summary, terminal_summary, error, detail_json FROM task_runs WHERE task_id = 'cron-row'",
      )
      .get();
    for (const value of Object.values(stored ?? {})) {
      expect(value).toMatch(/^OCSEAL1:/);
      expect(value).not.toContain("private");
    }
    const full = readCronRunRecordsInDatabase(db);
    expect(full.find((row) => row.id === "cron-row")).toMatchObject({
      error: "OCSEAL1:legacy error",
      summary: "private summary",
      detail,
    });
    expect(full.find((row) => row.id === "malformed")?.detail).toBeUndefined();
    const planning = readCronRunRecordsInDatabase(db, undefined, undefined, {
      planningOnly: true,
    });
    expect(planning).toEqual(personalPlanning);
    expect(planning.find((row) => row.id === "cron-row")).toMatchObject({
      error: "OCSEAL1:legacy error",
      summary: undefined,
      detail: { kind: "cron-run", storeKey: "store" },
    });
    expect(planning.find((row) => row.id === "malformed")?.detail).toBeUndefined();
    expect(
      findCronRunRecoveryInDatabase({
        database: db,
        jobId: "job",
        startedAt: 10,
        storeKey: "store",
        receiptId: "receipt",
      }).finalized,
    ).toMatchObject({
      entry: { status: "ok", runId: "receipt" },
      triggerEval: { fired: true, stateChanged: true, state: { secret: 1 } },
    });
  });

  it("seals new outcomes and recovery updates while retention keeps non-Cron rows", () => {
    const db = createDatabase();
    insertRetainedRow(db, { taskId: "other", runtime: "task", status: "running" });
    migrate(db);
    db.exec("BEGIN IMMEDIATE");
    recordCronRunInDatabase(db, {
      storeKey: "store",
      jobId: "job",
      runId: "cron:job:10:new",
      startedAt: 10,
      endedAt: 20,
      status: "failed",
      error: "private failure",
      summary: "private result",
      detail: { kind: "cron-run", storeKey: "store", status: "error", runId: "new" },
    });
    const record = readCronRunRecordsInDatabase(db)[0];
    expect(record).toMatchObject({ error: "private failure", summary: "private result" });
    recordCronRunInDatabase(db, {
      storeKey: "store",
      jobId: "job",
      runId: "cron:job:10:new",
      startedAt: 10,
      endedAt: 21,
      status: "failed",
      error: "private failure",
      summary: "updated result",
      detail: { kind: "cron-run", storeKey: "store", status: "error", runId: "new" },
    });
    expect(readCronRunRecordsInDatabase(db)).toMatchObject([
      { id: record!.id, summary: "updated result" },
    ]);
    const stored = db
      .prepare(
        "SELECT task, error, terminal_summary, detail_json FROM task_runs WHERE runtime = 'cron'",
      )
      .get();
    for (const value of Object.values(stored ?? {})) {
      expect(value).toMatch(/^OCSEAL1:/);
    }
    // Turn the row into an unfinished legacy occurrence using the same protected payload.
    db.prepare("UPDATE task_runs SET status = 'running', ended_at = NULL WHERE task_id = ?").run(
      record!.id,
    );
    const active = readCronRunRecordsInDatabase(db);
    expect(reconcileCronRunHistoryInDatabase(db, active, 400_000, new Set())).toEqual(
      new Set([record!.id]),
    );
    expect(readCronRunRecordsInDatabase(db)[0]).toMatchObject({ status: "lost" });
    expect(
      db.prepare("SELECT error FROM task_runs WHERE task_id = ?").get(record!.id)?.error,
    ).toMatch(/^OCSEAL1:/);
    expect(
      pruneCronRunHistoryInDatabase(db, 100_000_000, {
        cronRunReceipts: false,
        executionOwnerLifecycleBindings: false,
      }),
    ).toBe(1);
    expect(db.prepare("SELECT runtime FROM task_runs WHERE task_id = 'other'").get()?.runtime).toBe(
      "task",
    );
    db.exec("COMMIT");
  });

  it("rolls back a SQLite readback failure without modifying unrelated rows", () => {
    let sawStoredCiphertext = false;
    const db = createDatabase((value, database) => {
      expect(
        database.prepare("SELECT task FROM task_runs WHERE task_id = 'cron-row'").get()?.task,
      ).toBe(`OCSEAL1:${value.toString("base64")}`);
      sawStoredCiphertext = true;
      throw new Error("injected history readback failure");
    });
    insertRetainedRow(db, { taskId: "cron-row", detail: '{"kind":"cron-run"}' });
    insertRetainedRow(db, { taskId: "other", runtime: "task", status: "running" });
    const before = db.prepare("SELECT * FROM task_runs ORDER BY task_id").all();
    expect(() => migrateCronHistoryToProtectedStorageInDatabase(db)).toThrow(
      "requires an unencrypted transaction",
    );
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateCronHistoryToProtectedStorageInDatabase(db)).toThrow(
      "injected history readback failure",
    );
    expect(sawStoredCiphertext).toBe(true);
    db.exec("COMMIT");
    expect(db.prepare("SELECT * FROM task_runs ORDER BY task_id").all()).toEqual(before);
  });

  it("leaves personal v20 opaque values plaintext", () => {
    const db = createDatabase();
    insertRetainedRow(db, { taskId: "cron-row", detail: '{"kind":"cron-run"}' });
    expect(readCronRunRecordsInDatabase(db)[0]?.error).toBe("OCSEAL1:legacy error");
    expect(db.prepare("SELECT error FROM task_runs WHERE task_id = 'cron-row'").get()?.error).toBe(
      "OCSEAL1:legacy error",
    );
  });
});
