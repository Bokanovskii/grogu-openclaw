import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
  type PreparedSqliteAuditRecord,
} from "../../infra/sqlite-audit-record.kernel.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import { cronStoreKey } from "./key.js";

type CronQuarantineDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

export type CronQuarantineRegistration = {
  storeKey: string;
  records: PreparedSqliteAuditRecord[];
};

function cronQuarantineScope(storePath: string): string {
  return `cron.quarantine:${cronStoreKey(storePath)}`;
}

function quarantineContext(scope: string, key: string): string {
  return protectedStorageValueContext("diagnostic_events", "payload_json", [scope, key]);
}

function cronQuarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const identity = JSON.stringify({
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function prepareCronQuarantineRegistration(params: {
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
  nowMs: number;
}): CronQuarantineRegistration {
  const storeKey = cronStoreKey(params.storePath);
  const scope = cronQuarantineScope(storeKey);
  const records = params.entries.map((entry) => {
    const quarantinedAtMs = "quarantinedAtMs" in entry ? entry.quarantinedAtMs : params.nowMs;
    return prepareSqliteAuditRecord(scope, {
      key: cronQuarantineEntryKey(entry),
      value: { ...entry, quarantinedAtMs },
      createdAt: quarantinedAtMs,
    });
  });
  return { storeKey, records };
}

/** The caller owns the complete synchronous transaction, including other Cron changes. */
export function registerCronQuarantineInDatabase(
  database: DatabaseSync,
  input: CronQuarantineRegistration,
): void {
  if (input.records.length === 0) {
    return;
  }
  const scope = cronQuarantineScope(input.storeKey);
  const records = isSqliteStorageValueEncryptionStrict(database)
    ? input.records.map((record) => ({
        ...record,
        payload_json: JSON.stringify(
          sealSqliteStoragePlaintext(
            database,
            record.payload_json,
            quarantineContext(scope, record.event_key),
          ),
        ),
      }))
    : input.records;
  createSqliteAuditRecordKernel<CronQuarantinedJob>(database, {
    scope,
    // Quarantine contains recoverable operator jobs, not disposable audit history.
    maxEntries: Number.MAX_SAFE_INTEGER,
  }).registerLegacyMany(records);
}

/** Deletes quarantine rows inside the caller-owned SQLite transaction. */
export function deleteCronQuarantinedJobsFromDatabase(params: {
  database: DatabaseSync;
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
}): void {
  if (params.entries.length === 0) {
    return;
  }
  const scope = cronQuarantineScope(params.storePath);
  for (const entry of params.entries) {
    executeSqliteQuerySync(
      params.database,
      getNodeSqliteKysely<CronQuarantineDatabase>(params.database)
        .deleteFrom("diagnostic_events")
        .where("scope", "=", scope)
        .where("event_key", "=", cronQuarantineEntryKey(entry)),
    );
  }
}

export function readCronQuarantinedJobsInDatabase(
  database: DatabaseSync,
  storeKey: string,
): CronQuarantinedJob[] {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<CronQuarantineDatabase>(database)
      .selectFrom("diagnostic_events")
      .select(["event_key", "payload_json"])
      .where("scope", "=", cronQuarantineScope(storeKey))
      .orderBy("sequence", "asc"),
  ).rows.map((row) => {
    let payload = row.payload_json;
    if (isSqliteStorageValueEncryptionStrict(database)) {
      const envelope: unknown = JSON.parse(payload);
      if (typeof envelope !== "string") {
        throw new Error("Protected Cron quarantine contains an invalid encrypted envelope.");
      }
      payload = openSqliteStorageText(
        database,
        envelope,
        quarantineContext(cronQuarantineScope(storeKey), row.event_key),
      );
    }
    // SAFETY: This scope stores CronQuarantinedJob payloads serialized by the quarantine owner.
    return JSON.parse(payload) as CronQuarantinedJob;
  });
}

/** Encrypt retained recoverable Cron diagnostics inside the shared-state schema transaction. */
export function migrateCronQuarantineToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Cron quarantine encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Cron quarantine encryption migration requires the protected storage key.");
  }
  if (!tableExists(db, "diagnostic_events")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: migration streams only Cron-owned diagnostic rows.
    const rows = db.prepare(`
      SELECT scope, event_key, payload_json FROM diagnostic_events
      WHERE scope GLOB 'cron.quarantine:*' ORDER BY scope, event_key
    `);
    const update = db.prepare(`
      UPDATE diagnostic_events SET payload_json = ? WHERE scope = ? AND event_key = ?
    `);
    const readback = db.prepare(`
      SELECT payload_json FROM diagnostic_events WHERE scope = ? AND event_key = ?
    `);
    for (const row of rows.iterate()) {
      if (
        typeof row.scope !== "string" ||
        typeof row.event_key !== "string" ||
        typeof row.payload_json !== "string"
      ) {
        throw new Error("Cron quarantine encryption migration found an invalid row.");
      }
      const context = quarantineContext(row.scope, row.event_key);
      const sealed = JSON.stringify(sealSqliteStoragePlaintext(db, row.payload_json, context));
      const result = update.run(sealed, row.scope, row.event_key);
      const stored = readback.get(row.scope, row.event_key)?.payload_json;
      if (
        (result.changes !== 1 && result.changes !== 1n) ||
        typeof stored !== "string" ||
        stored !== sealed
      ) {
        throw new Error("Cron quarantine encryption migration could not verify its stored value.");
      }
      const envelope: unknown = JSON.parse(stored);
      if (
        typeof envelope !== "string" ||
        openSqliteStorageText(db, envelope, context) !== row.payload_json
      ) {
        throw new Error("Cron quarantine encryption migration could not open its stored value.");
      }
    }
  });
}
