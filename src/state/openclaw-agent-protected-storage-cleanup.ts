import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import {
  resolveSessionColdArchivePath,
  sessionColdArchiveStorageContext,
} from "../config/sessions/session-cold-storage-codec.js";
import { openSessionTranscriptArchiveBytes } from "../config/sessions/session-transcript-archive-encryption.js";
import { syncDirectoryBestEffortSync } from "../infra/directory-durability.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { openSqliteStorageBytes } from "../storage/sqlite-encryption.js";
import { PROTECTED_ENCRYPTION_TABLE } from "./openclaw-agent-db-schema-read.js";

/** Reclaim old plaintext pages after the atomic conversion; retry after interruption. */
export function cleanupProtectedAgentStorageAfterMigration(database: DatabaseSync): void {
  if (database.isTransaction) {
    throw new Error("Protected storage cleanup requires a settled schema transaction.");
  }
  if (
    !database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(PROTECTED_ENCRYPTION_TABLE)
  ) {
    return;
  }
  const marker = database
    .prepare(`SELECT cleanup_pending FROM ${PROTECTED_ENCRYPTION_TABLE} WHERE id = 1`)
    .get();
  if (marker?.cleanup_pending !== 1) {
    return;
  }
  const storePath = database.location();
  if (!storePath) {
    throw new Error("Protected storage cleanup cannot resolve the agent database path.");
  }
  const hasColdArchives = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_cold_archives'",
      )
      .get(),
  );
  const hasTranscriptArchives = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_archives'",
      )
      .get(),
  );
  const archivesToRepublish: Array<{ sessionId: string; generation: string }> = [];
  if (hasTranscriptArchives) {
    const archives = database
      .prepare(
        "SELECT session_id, generation, archive_name, archive_sha256, archive_blob FROM session_transcript_archives",
      )
      .iterate();
    const archiveDirectory = resolveSessionArtifactDirectory(storePath);
    for (const archive of archives) {
      if (
        typeof archive.session_id !== "string" ||
        typeof archive.generation !== "string" ||
        typeof archive.archive_name !== "string" ||
        typeof archive.archive_sha256 !== "string" ||
        !(archive.archive_blob instanceof Uint8Array) ||
        archive.archive_name === "." ||
        archive.archive_name === ".." ||
        path.basename(archive.archive_name) !== archive.archive_name
      ) {
        throw new Error("Protected transcript archive cleanup found an invalid archive.");
      }
      const archivePath = path.resolve(archiveDirectory, archive.archive_name);
      if (path.dirname(archivePath) !== path.resolve(archiveDirectory)) {
        throw new Error("Protected transcript archive path escaped its owner directory.");
      }
      const encrypted = Buffer.from(archive.archive_blob);
      if (createHash("sha256").update(encrypted).digest("hex") !== archive.archive_sha256) {
        throw new Error(
          `Protected transcript archive ${archive.archive_name} failed verification.`,
        );
      }
      const plaintext = openSessionTranscriptArchiveBytes(
        database,
        encrypted,
        archive.session_id,
        archive.generation,
      );
      if (fs.existsSync(archivePath)) {
        const fileBytes = fs.readFileSync(archivePath);
        if (!fileBytes.equals(plaintext) && !fileBytes.equals(encrypted)) {
          throw new Error(
            `Protected transcript archive ${archive.archive_name} changed before plaintext cleanup.`,
          );
        }
        fs.rmSync(archivePath);
        syncDirectoryBestEffortSync(archiveDirectory);
      }
      archivesToRepublish.push({
        sessionId: archive.session_id,
        generation: archive.generation,
      });
    }
  }
  if (hasColdArchives) {
    const archives = database
      .prepare(`
        SELECT session_id, generation, archive_name, archive_blob
        FROM session_transcript_cold_archives
        WHERE storage = 'sqlite'
      `)
      .all();
    for (const archive of archives) {
      if (
        typeof archive.session_id !== "string" ||
        typeof archive.generation !== "string" ||
        typeof archive.archive_name !== "string" ||
        !(archive.archive_blob instanceof Uint8Array)
      ) {
        throw new Error("Protected cold archive cleanup found an invalid stored archive.");
      }
      const archivePath = resolveSessionColdArchivePath(storePath, archive.archive_name);
      if (!fs.existsSync(archivePath)) {
        continue;
      }
      const plaintext = openSqliteStorageBytes(
        database,
        archive.archive_blob,
        sessionColdArchiveStorageContext(archive.session_id, archive.generation),
      );
      const fileBytes = fs.readFileSync(archivePath);
      if (!fileBytes.equals(plaintext) && !fileBytes.equals(archive.archive_blob)) {
        throw new Error(
          `Protected cold archive ${archive.archive_name} changed before plaintext cleanup.`,
        );
      }
      fs.rmSync(archivePath);
      syncDirectoryBestEffortSync(path.dirname(archivePath));
    }
  }
  database.exec("PRAGMA secure_delete = ON;");
  const checkpoint = () => {
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (typeof result?.busy === "number" && result.busy !== 0) {
      throw new Error("Protected storage cleanup could not checkpoint its SQLite WAL.");
    }
  };
  checkpoint();
  database.exec("VACUUM;");
  checkpoint();
  runSqliteImmediateTransactionSync(
    database,
    () => {
      const markUnpublished = database.prepare(`
        UPDATE session_transcript_archives SET published_at = NULL
        WHERE session_id = ? AND generation = ?
      `);
      for (const archive of archivesToRepublish) {
        markUnpublished.run(archive.sessionId, archive.generation);
      }
      const updated = database
        .prepare(`UPDATE ${PROTECTED_ENCRYPTION_TABLE} SET cleanup_pending = 0 WHERE id = 1`)
        .run();
      if (Number(updated.changes) !== 1) {
        throw new Error("Protected storage cleanup marker disappeared.");
      }
    },
    {
      operationLabel: "agent.protected-storage.cleanup",
      databaseLabel: database.location() ?? "agent database",
    },
  );
  checkpoint();
}
