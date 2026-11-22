import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  PROTECTED_SHARED_STATE_ENCRYPTION_TABLE,
  readProtectedSharedStateMarker,
} from "./openclaw-state-protected-marker.js";

/** Reclaim old SQLite pages after migration and retry safely if cleanup is interrupted. */
export function cleanupProtectedSharedStateAfterMigration(
  db: DatabaseSync,
  assertCurrent: () => void,
): void {
  if (db.isTransaction) {
    throw new Error("Protected shared-state cleanup requires a settled transaction.");
  }
  if (!readProtectedSharedStateMarker(db).cleanupPending) {
    return;
  }
  const checkpoint = () => {
    assertCurrent();
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) {
      throw new Error("Protected shared-state cleanup could not checkpoint its SQLite WAL.");
    }
  };
  assertCurrent();
  db.exec("PRAGMA secure_delete = ON");
  checkpoint();
  assertCurrent();
  db.exec("VACUUM");
  checkpoint();
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertCurrent();
      if (!readProtectedSharedStateMarker(db).cleanupPending) {
        throw new Error("Protected shared-state cleanup marker changed.");
      }
      const updated = db
        .prepare(
          `UPDATE ${PROTECTED_SHARED_STATE_ENCRYPTION_TABLE} SET cleanup_pending = 0 WHERE id = 1`,
        )
        .run();
      if (updated.changes !== 1 && updated.changes !== 1n) {
        throw new Error("Protected shared-state cleanup marker disappeared.");
      }
    },
    { databaseLabel: db.location() ?? "shared state", operationLabel: "state.protected.cleanup" },
  );
  checkpoint();
}
