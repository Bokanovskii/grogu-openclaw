import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";

const HISTORY_CONTENT_COLUMNS = [
  "task",
  "label",
  "progress_summary",
  "terminal_summary",
  "error",
  "detail_json",
] as const;
type HistoryContentColumn = (typeof HISTORY_CONTENT_COLUMNS)[number];

function historyContext(taskId: string, column: HistoryContentColumn): string {
  return protectedStorageValueContext("task_runs", column, [taskId]);
}

export function sealCronHistoryValue(
  db: DatabaseSync,
  taskId: string,
  column: HistoryContentColumn,
  value: string,
): string;
export function sealCronHistoryValue(
  db: DatabaseSync,
  taskId: string,
  column: HistoryContentColumn,
  value: string | null,
): string | null;
export function sealCronHistoryValue(
  db: DatabaseSync,
  taskId: string,
  column: HistoryContentColumn,
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? sealSqliteStoragePlaintext(db, toUSVString(value), historyContext(taskId, column))
    : value;
}

export function openCronHistoryValue(
  db: DatabaseSync,
  taskId: string,
  column: HistoryContentColumn,
  value: string | null,
): string | null {
  return value !== null && isSqliteStorageValueEncryptionStrict(db)
    ? openSqliteStorageText(db, value, historyContext(taskId, column))
    : value;
}

const detailProjectionConnections = new WeakSet<DatabaseSync>();

/** Install the SQL projection adapter once per strict connection. */
export function registerCronHistoryDetailProjection(db: DatabaseSync): void {
  if (detailProjectionConnections.has(db)) {
    return;
  }
  db.function(
    "openclaw_cron_history_detail_open",
    { deterministic: true, directOnly: true },
    (value: unknown, taskId: unknown) => {
      if (value === null) {
        return null;
      }
      if (typeof value !== "string" || typeof taskId !== "string") {
        throw new Error("Cron history detail requires its task identity.");
      }
      return openCronHistoryValue(db, taskId, "detail_json", value);
    },
  );
  detailProjectionConnections.add(db);
}

/**
 * The schema owner calls this once for known plaintext v20 rows, inside its
 * write transaction after legacy imports and before publishing protected v21.
 */
export function migrateCronHistoryToProtectedStorageInDatabase(db: DatabaseSync): void {
  if (!db.isTransaction || isSqliteStorageValueEncryptionStrict(db)) {
    throw new Error("Cron history encryption migration requires an unencrypted transaction.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Cron history encryption migration requires the protected storage key.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw: migration streams and verifies the original table in its owning transaction.
    const rows = db.prepare(`
      SELECT task_id, task, label, progress_summary, terminal_summary, error, detail_json
        FROM task_runs WHERE runtime = 'cron' ORDER BY task_id
    `);
    const update = db.prepare(`
      UPDATE task_runs SET task = ?, label = ?, progress_summary = ?, terminal_summary = ?,
        error = ?, detail_json = ? WHERE runtime = 'cron' AND task_id = ?
    `);
    const readback = db.prepare(`
      SELECT task, label, progress_summary, terminal_summary, error, detail_json
        FROM task_runs WHERE runtime = 'cron' AND task_id = ?
    `);
    for (const row of rows.iterate()) {
      if (typeof row.task_id !== "string" || typeof row.task !== "string") {
        throw new Error("Cron history encryption migration found an invalid row.");
      }
      const taskId = row.task_id;
      const sealed = HISTORY_CONTENT_COLUMNS.map((column) => {
        const value = row[column];
        if (value !== null && typeof value !== "string") {
          throw new Error("Cron history encryption migration found an invalid value.");
        }
        return value === null
          ? null
          : sealSqliteStoragePlaintext(db, value, historyContext(taskId, column));
      });
      const result = update.run(...sealed, taskId);
      const stored = readback.get(taskId);
      if ((result.changes !== 1 && result.changes !== 1n) || !stored) {
        throw new Error("Cron history encryption migration could not read its stored row.");
      }
      for (const [index, column] of HISTORY_CONTENT_COLUMNS.entries()) {
        const value = stored[column];
        if (
          value !== sealed[index] ||
          (value !== null &&
            (typeof value !== "string" ||
              openSqliteStorageText(db, value, historyContext(taskId, column)) !== row[column]))
        ) {
          throw new Error("Cron history encryption migration could not verify its stored value.");
        }
      }
    }
  });
}
