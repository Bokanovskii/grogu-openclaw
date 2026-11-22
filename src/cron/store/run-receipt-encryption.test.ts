import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createStorageValueEncryption } from "../../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../../storage/sqlite-encryption.js";
import type { CronStoredJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { upsertCronJobRow, updateCronRuntimeRow } from "./row-codec.js";
import {
  markCronDeliveryStartedInDatabase,
  readCronDeliveryAttemptStateInDatabase,
} from "./run-receipt-delivery.js";
import { migrateCronReceiptsToProtectedStorageInDatabase } from "./run-receipt-encryption.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import {
  activateCronRunReceiptInDatabase,
  adjudicateActiveCronRunReceiptInDatabase,
  assertCronRunReceiptOwnedInDatabase,
  claimCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.js";
import {
  isCronRunTriggerStateRetiredInDatabase,
  retireCronRunTriggerStateInDatabase,
} from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { observeCronRunRecoveryInDatabase } from "./run-recovery.read.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
  replaceCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";

const databases: DatabaseSync[] = [];
const storeKey = cronStoreKey("protected-cron-store");
const resolveAgentId = (job: CronStoredJob) => job.agentId!;

afterEach(() => {
  for (const db of databases.splice(0)) {
    disposeSqliteStorageValueEncryption(db);
    db.close();
  }
});

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  registerSqliteStorageValueEncryption(db, createStorageValueEncryption(Buffer.alloc(32, 17)));
  db.exec("PRAGMA foreign_keys = ON");
  for (const table of [
    "cron_jobs",
    "cron_run_receipts",
    "cron_run_trigger_state_retirements",
    "cron_job_runtime_authorities",
  ]) {
    db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
  }
  db.exec(`
    CREATE UNIQUE INDEX idx_cron_run_receipts_active_job
      ON cron_run_receipts(store_key, job_id) WHERE status = 'running';
  `);
  return db;
}

function makeJob(id = "job"): CronStoredJob {
  return {
    id,
    agentId: "alpha",
    name: "private job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "private task", toolsAllow: ["read"] },
    delivery: { mode: "none" },
    state: {},
    runtimeAuthority: {
      version: 1,
      runtimeId: "synthetic",
      namespace: "synthetic.apps",
      payload: { token: "private authority" },
    },
  };
}

function seedRetainedRows(db: DatabaseSync): void {
  for (const job of [makeJob(), makeJob("nulls")]) {
    upsertCronJobRow(db, storeKey, job, 0);
  }
  replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [makeJob()] });
  replaceCronRuntimeAuthorityRows({
    db,
    storeKey,
    jobs: [{ ...makeJob("nulls"), runtimeAuthorityRecoveryRequired: true }],
  });
  const insert = db.prepare(`
    INSERT INTO cron_run_receipts (
      receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
      delivery_attempt_state, status, owner_pid, owner_start_time, started_at_ms,
      finished_at_ms, error_text
    ) VALUES (?, ?, ?, 'private revision', 'alpha', ?, 'not-started', 'running', ?, NULL,
      10, NULL, ?)
  `);
  insert.run("retained", storeKey, "job", "OCSEAL1:opaque request", process.pid, "private error");
  insert.run("nulls", storeKey, "nulls", null, process.pid, null);
  db.prepare("INSERT INTO cron_run_trigger_state_retirements VALUES ('retained')").run();
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateCronReceiptsToProtectedStorageInDatabase(db);
  db.exec("COMMIT");
  expect(isSqliteStorageValueEncryptionStrict(db)).toBe(false);
  setSqliteStorageValueEncryptionStrict(db, true);
}

function claim(db: DatabaseSync, job: CronStoredJob, requestRunId = "private request") {
  upsertCronJobRow(db, storeKey, job, 0);
  return claimCronRunReceiptInDatabase({
    database: db,
    prepared: prepareCronRunReceiptClaim({
      storePath: storeKey,
      job,
      agentId: "alpha",
      startedAtMs: 10,
      observed: undefined,
      requestRunId,
    }),
    receiptSchema: prepareCronRunReceiptWriteSchema(db),
    resolveAgentId,
  });
}

describe("protected Cron receipts and runtime authority", () => {
  it("migrates retained payloads and NULLs without changing personal decoding or recovery fences", () => {
    const db = createDatabase();
    seedRetainedRows(db);
    const before = findActiveCronRunReceiptInDatabase({
      database: db,
      storePath: storeKey,
      jobId: "job",
    });
    const personalRow = db
      .prepare("SELECT request_run_id FROM cron_run_receipts WHERE receipt_id = 'retained'")
      .get();
    expect(personalRow?.request_run_id).toBe("OCSEAL1:opaque request");
    const retirements = db.prepare("SELECT * FROM cron_run_trigger_state_retirements").all();
    migrate(db);
    expect(
      findActiveCronRunReceiptInDatabase({ database: db, storePath: storeKey, jobId: "job" }),
    ).toEqual(before);
    const stored = db
      .prepare(
        "SELECT config_revision, request_run_id, error_text FROM cron_run_receipts WHERE receipt_id = 'retained'",
      )
      .get();
    for (const value of Object.values(stored ?? {})) {
      expect(value).toMatch(/^OCSEAL1:/);
      expect(value).not.toContain("private");
    }
    expect(
      db
        .prepare(
          "SELECT request_run_id, error_text FROM cron_run_receipts WHERE receipt_id = 'nulls'",
        )
        .get(),
    ).toEqual({
      request_run_id: null,
      error_text: null,
    });
    expect(
      db
        .prepare(
          "SELECT authority_json, authority_input_fingerprint FROM cron_job_runtime_authorities WHERE job_id = 'nulls'",
        )
        .get(),
    ).toEqual({
      authority_json: null,
      authority_input_fingerprint: null,
    });
    const jobs = [makeJob(), makeJob("nulls")];
    expect(loadCronRuntimeAuthorities({ db, storeKey, jobs })).toEqual({ repairJobIds: [] });
    expect(jobs[0]?.runtimeAuthority).toEqual(makeJob().runtimeAuthority);
    expect(jobs[1]?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(db.prepare("SELECT * FROM cron_run_trigger_state_retirements").all()).toEqual(
      retirements,
    );
    expect(
      readCronDeliveryAttemptStateInDatabase({
        database: db,
        storeKey,
        jobId: "job",
        receiptId: "retained",
        startedAtMs: 10,
      }),
    ).toBe("not-started");
  });

  it("rolls back both tables on persisted readback mismatch and permits a clean retry", () => {
    const db = createDatabase();
    seedRetainedRows(db);
    const receiptsBefore = db.prepare("SELECT * FROM cron_run_receipts ORDER BY receipt_id").all();
    const authoritiesBefore = db
      .prepare("SELECT * FROM cron_job_runtime_authorities ORDER BY job_id")
      .all();
    db.exec(`
      CREATE TRIGGER corrupt_authority_readback AFTER UPDATE ON cron_job_runtime_authorities
      WHEN NEW.job_id = 'job' BEGIN
        UPDATE cron_job_runtime_authorities SET authority_input_fingerprint = 'corrupt'
          WHERE store_key = NEW.store_key AND job_id = NEW.job_id;
      END;
    `);
    expect(() => migrateCronReceiptsToProtectedStorageInDatabase(db)).toThrow(
      "requires an unencrypted transaction",
    );
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateCronReceiptsToProtectedStorageInDatabase(db)).toThrow(
      "could not verify its stored value",
    );
    db.exec("COMMIT");
    expect(db.prepare("SELECT * FROM cron_run_receipts ORDER BY receipt_id").all()).toEqual(
      receiptsBefore,
    );
    expect(db.prepare("SELECT * FROM cron_job_runtime_authorities ORDER BY job_id").all()).toEqual(
      authoritiesBefore,
    );
    db.exec("DROP TRIGGER corrupt_authority_readback");
    migrate(db);
    expect(readActiveCronRunReceiptsInDatabase(db, storeKey, ["job"])[0]?.configRevision).toBe(
      "private revision",
    );
  });

  it("rejects swapped receipt fields and cross-job runtime authority through their readers", () => {
    const db = createDatabase();
    seedRetainedRows(db);
    migrate(db);
    db.exec(`
      UPDATE cron_run_receipts SET error_text = request_run_id WHERE receipt_id = 'retained';
    `);
    expect(() => readActiveCronRunReceiptsInDatabase(db, storeKey, ["job"])).toThrow();
    db.exec(`
      UPDATE cron_job_runtime_authorities SET recovery_required = 0,
        authority_json = (SELECT authority_json FROM cron_job_runtime_authorities WHERE job_id = 'job'),
        authority_input_fingerprint = (SELECT authority_input_fingerprint FROM cron_job_runtime_authorities WHERE job_id = 'job')
        WHERE job_id = 'nulls';
    `);
    expect(() => loadCronRuntimeAuthorities({ db, storeKey, jobs: [makeJob("nulls")] })).toThrow();
  });

  it("seals claims and updates while preserving activation, delivery, retirement, and stale-owner recovery", () => {
    const db = createDatabase();
    setSqliteStorageValueEncryptionStrict(db, true);
    db.exec("BEGIN IMMEDIATE");
    const job = makeJob();
    const queued = claim(db, job, "OCSEAL1:literal request");
    const active = activateCronRunReceiptInDatabase({
      database: db,
      handle: queued,
      startedAtMs: 11,
      resolveAgentId,
    });
    job.state = { runningAtMs: 11, runningReceiptId: active.receiptId };
    updateCronRuntimeRow(db, storeKey, job);
    retireCronRunTriggerStateInDatabase({ database: db, handle: active });
    expect(isCronRunTriggerStateRetiredInDatabase({ database: db, handle: active })).toBe(true);
    markCronDeliveryStartedInDatabase({
      database: db,
      handle: active,
      allowMissingJob: false,
      resolveAgentId,
    });
    const observation = observeCronRunRecoveryInDatabase(db, {
      type: "cron.observeRunRecovery",
      storeKey,
      proposals: [{ jobId: job.id, runningAtMs: 11 }],
    });
    expect(observation).toMatchObject({
      kind: "observed",
      proposals: [{ receipt: active, runningReceiptId: active.receiptId }],
    });
    expect(() =>
      adjudicateActiveCronRunReceiptInDatabase({
        database: db,
        jobId: job.id,
        finishedAtMs: 12,
        prepared: { storeKey, observed: queued, observedStale: true },
      }),
    ).toThrow("already running");
    adjudicateActiveCronRunReceiptInDatabase({
      database: db,
      jobId: job.id,
      finishedAtMs: 12,
      prepared: { storeKey, observed: active, observedStale: true },
    });
    expect(() => assertCronRunReceiptOwnedInDatabase({ database: db, handle: active })).toThrow(
      "no longer current",
    );
    const row = db
      .prepare(
        "SELECT status, error_text, request_run_id FROM cron_run_receipts WHERE receipt_id = ?",
      )
      .get(active.receiptId);
    expect(row).toMatchObject({
      status: "interrupted",
      error_text: expect.stringMatching(/^OCSEAL1:/),
      request_run_id: expect.stringMatching(/^OCSEAL1:/),
    });
    const finished = finishCronRunReceiptInDatabase({
      database: db,
      receiptSchema: prepareCronRunReceiptWriteSchema(db),
      handle: active,
      status: "ok",
      finishedAtMs: 13,
      error: "must not overwrite recovered receipt",
    });
    expect(finished).toMatchObject({
      status: "interrupted",
      requestRunId: "OCSEAL1:literal request",
      error: "cron: job interrupted because owner is unavailable",
    });
    expect(
      readCronDeliveryAttemptStateInDatabase({
        database: db,
        storeKey,
        jobId: job.id,
        receiptId: active.receiptId,
        startedAtMs: 11,
      }),
    ).toBe("started");
    delete job.state.runningAtMs;
    delete job.state.runningReceiptId;
    updateCronRuntimeRow(db, storeKey, job);
    const next = claim(db, job);
    expect(
      finishCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        handle: next,
        status: "error",
        finishedAtMs: 20,
        error: "new private failure",
      })?.error,
    ).toBe("new private failure");
    expect(
      db
        .prepare("SELECT error_text FROM cron_run_receipts WHERE receipt_id = ?")
        .get(next.receiptId)?.error_text,
    ).toMatch(/^OCSEAL1:/);
    db.exec("COMMIT");
  });

  it("reseals runtime updates while preserving unchanged authority and retiring input drift", () => {
    const db = createDatabase();
    setSqliteStorageValueEncryptionStrict(db, true);
    db.exec("BEGIN IMMEDIATE");
    const job = makeJob();
    upsertCronJobRow(db, storeKey, job, 0);
    replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [job] });
    const first = db
      .prepare(
        "SELECT authority_json, authority_input_fingerprint FROM cron_job_runtime_authorities",
      )
      .get();
    expect(first?.authority_json).toMatch(/^OCSEAL1:/);
    expect(first?.authority_input_fingerprint).toMatch(/^OCSEAL1:/);
    const updated = {
      ...job,
      runtimeAuthority: {
        ...job.runtimeAuthority!,
        payload: { token: "updated private authority" },
      },
    };
    replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [updated] });
    const loaded = makeJob();
    expect(loadCronRuntimeAuthorities({ db, storeKey, jobs: [loaded] }).repairJobIds).toEqual([]);
    expect(loaded.runtimeAuthority).toEqual(updated.runtimeAuthority);
    replaceCronRuntimeAuthorityRows({
      db,
      storeKey,
      jobs: [loaded],
      preserveExistingForJobIds: new Set([job.id]),
    });
    const drifted = { ...loaded, payload: { ...loaded.payload, toolsAllow: ["write"] } };
    expect(loadCronRuntimeAuthorities({ db, storeKey, jobs: [drifted] }).repairJobIds).toEqual([
      job.id,
    ]);
    expect(
      repairCronRuntimeAuthorityRows({ db, storeKey, jobs: [drifted], jobIds: [job.id] }),
    ).toBe(true);
    expect(
      db
        .prepare(
          "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities",
        )
        .get(),
    ).toEqual({
      authority_json: null,
      authority_input_fingerprint: null,
      recovery_required: 1,
    });
    db.exec("COMMIT");
  });
});
