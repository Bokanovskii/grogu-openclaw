import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openCronJobValue } from "./job-encryption.js";
import { loadCronRows } from "./row-codec.js";
import { getCronStoreKysely, type CronJobReadRow, type CronJobRow } from "./schema.js";

/** Fingerprints raw definition rows without mutating their config order. */
export function fingerprintCronJobRows(
  rows: readonly Pick<CronJobRow, "job_id" | "job_json" | "sort_order">[],
): string {
  // This internal, transient Doctor token uses one encoding-independent ID order.
  // Keep raw fields so every definition edit invalidates the snapshot.
  const ordered = rows
    .map(({ job_id, job_json, sort_order }) => ({
      idBytes: Buffer.from(job_id),
      definition: { job_id, job_json, sort_order },
    }))
    .toSorted((left, right) => Buffer.compare(left.idBytes, right.idBytes));
  return sha256Hex(JSON.stringify(ordered.map(({ definition }) => definition)));
}

/** Reads only definition JSON and order while excluding runtime-owned state. */
export function readCronJobsFingerprint(db: DatabaseSync, storeKey: string): string {
  const rows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json", "sort_order"])
      .where("store_key", "=", storeKey),
  ).rows;
  return fingerprintCronJobRows(
    rows.map((row) => ({
      job_id: row.job_id,
      sort_order: row.sort_order,
      job_json: openCronJobValue(db, storeKey, row.job_id, "job_json", row.job_json),
    })),
  );
}

/** Binds a scheduler snapshot before its in-memory pacing and catch-up adjustments. */
export function fingerprintCronRuntimeRows(rows: readonly CronJobReadRow[]): string {
  const ordered = rows
    .map(({ job_id, state_json, runtime_updated_at_ms, updated_at, schedule_identity }) => ({
      job_id,
      state_json,
      runtime_updated_at_ms,
      updated_at,
      schedule_identity,
    }))
    .toSorted((left, right) => Buffer.compare(Buffer.from(left.job_id), Buffer.from(right.job_id)));
  return sha256Hex(JSON.stringify(ordered));
}

/** Capture both row owners together; Doctor's definition-only token stays unchanged. */
export function readCronStoreFingerprints(db: DatabaseSync, storeKey: string) {
  const rows = loadCronRows(db, storeKey);
  return {
    jobsFingerprint: fingerprintCronJobRows(rows),
    runtimeFingerprint: fingerprintCronRuntimeRows(rows),
  };
}
