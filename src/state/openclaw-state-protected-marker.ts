import type { DatabaseSync } from "node:sqlite";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../storage/sqlite-encryption.js";

export const PROTECTED_SHARED_STATE_ENCRYPTION_TABLE = "grogu_protected_shared_state";
export const PROTECTED_SHARED_STATE_SCHEMA_VERSION = 21;
const KEY_CHECK = "grogu-protected-shared-state-v21";
const KEY_CHECK_CONTEXT = protectedStorageValueContext(
  PROTECTED_SHARED_STATE_ENCRYPTION_TABLE,
  "key_check",
  [1],
);

/** Authenticate the marker even before the connection enters strict mode. */
export function readProtectedSharedStateMarker(db: DatabaseSync): { cleanupPending: boolean } {
  const marker = db
    .prepare(
      `SELECT key_check, cleanup_pending FROM ${PROTECTED_SHARED_STATE_ENCRYPTION_TABLE} WHERE id = 1`,
    )
    .get();
  if (
    typeof marker?.key_check !== "string" ||
    !marker.key_check.startsWith("OCSEAL1:") ||
    (marker.cleanup_pending !== 0 && marker.cleanup_pending !== 1)
  ) {
    throw new Error("Protected shared-state encryption marker is invalid.");
  }
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error(
      "Protected shared state is encrypted but its key is unavailable; restore the key before starting the service.",
    );
  }
  let keyCheck: string;
  try {
    keyCheck = openSqliteStorageText(db, marker.key_check, KEY_CHECK_CONTEXT);
  } catch (cause) {
    throw new Error(
      "Protected shared state could not be opened with the configured storage key; verify the key and retry.",
      { cause },
    );
  }
  if (keyCheck !== KEY_CHECK) {
    throw new Error("Protected shared-state encryption key check failed.");
  }
  return { cleanupPending: marker.cleanup_pending === 1 };
}

export function createProtectedSharedStateKeyCheck(db: DatabaseSync): string {
  return sealSqliteStoragePlaintext(db, KEY_CHECK, KEY_CHECK_CONTEXT);
}
