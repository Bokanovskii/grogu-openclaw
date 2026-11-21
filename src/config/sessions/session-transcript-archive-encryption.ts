import type { DatabaseSync } from "node:sqlite";
import {
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageBytes,
  protectedStorageValueContext,
  sealSqliteStorageBytes,
} from "../../storage/sqlite-encryption.js";

export function sessionTranscriptArchiveStorageContext(
  sessionId: string,
  generation: string,
): string {
  return protectedStorageValueContext("session_transcript_archives", "archive_blob", [
    sessionId,
    generation,
  ]);
}

export function isProtectedSessionTranscriptArchiveStore(database: DatabaseSync): boolean {
  return isSqliteStorageValueEncryptionStrict(database);
}

export function sealSessionTranscriptArchiveBytes(
  database: DatabaseSync,
  bytes: Uint8Array,
  sessionId: string,
  generation: string,
): Buffer {
  return sealSqliteStorageBytes(
    database,
    bytes,
    sessionTranscriptArchiveStorageContext(sessionId, generation),
  );
}

export function openSessionTranscriptArchiveBytes(
  database: DatabaseSync,
  bytes: Uint8Array,
  sessionId: string,
  generation: string,
): Buffer {
  return openSqliteStorageBytes(
    database,
    bytes,
    sessionTranscriptArchiveStorageContext(sessionId, generation),
  );
}
