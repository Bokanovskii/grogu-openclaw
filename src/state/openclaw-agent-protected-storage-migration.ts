import { createHash } from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { acpParentStreamEventStorageContext } from "../agents/subagents/spawn/acp-parent-stream-storage.js";
import {
  resolveSessionColdArchivePath,
  sessionColdArchiveStorageContext,
} from "../config/sessions/session-cold-storage-codec.js";
import {
  PROTECTED_SESSION_ENTRY_TABLE,
  protectSessionEntryProjection,
  protectedSessionEntryContext,
} from "../config/sessions/session-entry-encryption.js";
import {
  openSessionInputCompletionOutcome,
  openSessionPendingInputMessage,
  sealSessionInputCompletionOutcome,
  sealSessionPendingInputMessage,
} from "../config/sessions/session-pending-input-encryption.js";
import {
  openSessionTranscriptArchiveBytes,
  sealSessionTranscriptArchiveBytes,
} from "../config/sessions/session-transcript-archive-encryption.js";
import {
  readTranscriptPayload,
  transcriptEventStorageContext,
} from "../config/sessions/transcript-payload.js";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  openSqliteStorageBytes,
  sealSqliteStorageText,
  sealSqliteStorageBytes,
} from "../storage/sqlite-encryption.js";
import { trajectoryRuntimeEventStorageContext } from "../trajectory/storage-context.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import {
  PROTECTED_ENCRYPTION_KEY_CHECK,
  PROTECTED_ENCRYPTION_KEY_CHECK_VALUE,
  PROTECTED_ENCRYPTION_TABLE,
} from "./openclaw-agent-db-schema-read.js";

function assertProtectedMigrationOwner(database: DatabaseSync): void {
  if (!database.isTransaction || !hasSqliteStorageValueEncryption(database)) {
    throw new Error(
      "Protected storage migration requires an encrypted connection inside the admitted schema transaction.",
    );
  }
  if (
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(PROTECTED_ENCRYPTION_TABLE)
  ) {
    throw new Error("Protected storage migration found an unexpected existing encryption marker.");
  }
}

/** Encrypt transcript payloads and remove their searchable plaintext projection atomically. */
export function migrateProtectedAgentStorageInTransaction(database: DatabaseSync): void {
  assertProtectedMigrationOwner(database);
  const rows = database.prepare(`
    SELECT session_id, seq, event_json, event_zstd, event_utf8_bytes
    FROM transcript_events
    ORDER BY session_id, seq
  `);
  rows.setReadBigInts(true);
  const update = database.prepare(`
    UPDATE transcript_events
    SET event_json = ?, event_zstd = NULL, navigation_json = NULL
    WHERE session_id = ? AND seq = ?
  `);
  let renewedAt = performance.now();
  for (const row of rows.iterate()) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    if (
      typeof row.session_id !== "string" ||
      typeof row.seq !== "bigint" ||
      row.seq < 0n ||
      row.seq > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Invalid transcript identity during protected storage migration.");
    }
    const seq = Number(row.seq);
    const rawBytes =
      typeof row.event_utf8_bytes === "bigint" &&
      row.event_utf8_bytes >= 0n &&
      row.event_utf8_bytes <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(row.event_utf8_bytes)
        : typeof row.event_utf8_bytes === "number"
          ? row.event_utf8_bytes
          : null;
    const plaintext = readTranscriptPayload(
      {
        event_json: typeof row.event_json === "string" ? row.event_json : null,
        event_zstd: row.event_zstd instanceof Uint8Array ? row.event_zstd : null,
        event_utf8_bytes: rawBytes,
      },
      { database, sessionId: row.session_id, seq },
    );
    const context = transcriptEventStorageContext(row.session_id, seq);
    const encrypted = sealSqliteStorageText(database, plaintext, context);
    if (openSqliteStorageText(database, encrypted, context) !== plaintext) {
      throw new Error("Protected transcript migration failed read-back verification.");
    }
    const result = update.run(encrypted, row.session_id, row.seq);
    if (Number(result.changes) !== 1) {
      throw new Error("Transcript event changed during protected storage migration.");
    }
    const stored = database
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
      .get(row.session_id, row.seq);
    if (
      typeof stored?.event_json !== "string" ||
      readTranscriptPayload(
        {
          event_json: stored.event_json,
          event_zstd: null,
          event_utf8_bytes: rawBytes,
        },
        { database, sessionId: row.session_id, seq },
      ) !== plaintext
    ) {
      throw new Error("Protected transcript migration failed persisted read-back verification.");
    }
  }
  const trajectoryRows = database.prepare(`
    SELECT session_id, seq, event_json
    FROM trajectory_runtime_events
    ORDER BY session_id, seq
  `);
  trajectoryRows.setReadBigInts(true);
  const updateTrajectory = database.prepare(`
    UPDATE trajectory_runtime_events SET event_json = ?
    WHERE session_id = ? AND seq = ?
  `);
  for (const row of trajectoryRows.iterate()) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    if (
      typeof row.session_id !== "string" ||
      typeof row.seq !== "bigint" ||
      row.seq < 0n ||
      row.seq > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof row.event_json !== "string"
    ) {
      throw new Error("Invalid trajectory event during protected storage migration.");
    }
    const seq = Number(row.seq);
    const context = trajectoryRuntimeEventStorageContext(row.session_id, seq);
    const encrypted = sealSqliteStorageText(database, row.event_json, context);
    if (openSqliteStorageText(database, encrypted, context) !== row.event_json) {
      throw new Error("Protected trajectory migration failed read-back verification.");
    }
    const result = updateTrajectory.run(encrypted, row.session_id, row.seq);
    if (Number(result.changes) !== 1) {
      throw new Error("Protected trajectory event changed during storage migration.");
    }
    const stored = database
      .prepare("SELECT event_json FROM trajectory_runtime_events WHERE session_id = ? AND seq = ?")
      .get(row.session_id, row.seq);
    if (
      typeof stored?.event_json !== "string" ||
      openSqliteStorageText(database, stored.event_json, context) !== row.event_json
    ) {
      throw new Error("Protected trajectory migration failed persisted read-back verification.");
    }
  }
  const hasAcpParentStreams = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'acp_parent_stream_events'",
      )
      .get(),
  );
  if (hasAcpParentStreams) {
    const streamRows = database.prepare(`
      SELECT session_id, run_id, seq, event_json
      FROM acp_parent_stream_events
      ORDER BY session_id, run_id, seq
    `);
    const updateStream = database.prepare(`
      UPDATE acp_parent_stream_events SET event_json = ?
      WHERE session_id = ? AND run_id = ? AND seq = ?
    `);
    for (const row of streamRows.iterate()) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.run_id !== "string" ||
        typeof row.seq !== "number" ||
        typeof row.event_json !== "string"
      ) {
        throw new Error("Invalid ACP parent-stream event during protected storage migration.");
      }
      if (performance.now() - renewedAt >= 1_000) {
        renewAgentDatabaseMaintenanceAuthorityIfPresent();
        renewedAt = performance.now();
      }
      const context = acpParentStreamEventStorageContext(row.session_id, row.run_id, row.seq);
      const encrypted = sealSqliteStorageText(database, row.event_json, context);
      if (openSqliteStorageText(database, encrypted, context) !== row.event_json) {
        throw new Error("Protected ACP parent-stream migration failed read-back verification.");
      }
      const result = updateStream.run(encrypted, row.session_id, row.run_id, row.seq);
      if (Number(result.changes) !== 1) {
        throw new Error("ACP parent-stream event changed during protected storage migration.");
      }
      const stored = database
        .prepare(
          "SELECT event_json FROM acp_parent_stream_events WHERE session_id = ? AND run_id = ? AND seq = ?",
        )
        .get(row.session_id, row.run_id, row.seq);
      if (
        typeof stored?.event_json !== "string" ||
        openSqliteStorageText(database, stored.event_json, context) !== row.event_json
      ) {
        throw new Error("Protected ACP parent-stream migration failed persisted read-back.");
      }
    }
  }
  const transcriptArchivesExist = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_archives'",
      )
      .get(),
  );
  if (transcriptArchivesExist) {
    const archiveRows = database.prepare(`
      SELECT session_id, generation, archive_name, archive_blob, archive_sha256
      FROM session_transcript_archives
      ORDER BY session_id, generation
    `);
    const updateArchive = database.prepare(`
      UPDATE session_transcript_archives SET archive_blob = ?, archive_sha256 = ?
      WHERE session_id = ? AND generation = ?
    `);
    for (const row of archiveRows.iterate()) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.generation !== "string" ||
        typeof row.archive_name !== "string" ||
        typeof row.archive_sha256 !== "string" ||
        !(row.archive_blob instanceof Uint8Array)
      ) {
        throw new Error("Invalid transcript archive during protected storage migration.");
      }
      const plaintext = Buffer.from(row.archive_blob);
      if (createHash("sha256").update(plaintext).digest("hex") !== row.archive_sha256) {
        throw new Error(
          `Transcript archive ${row.archive_name} failed verification during migration.`,
        );
      }
      const encrypted = sealSessionTranscriptArchiveBytes(
        database,
        plaintext,
        row.session_id,
        row.generation,
      );
      if (
        !openSessionTranscriptArchiveBytes(
          database,
          encrypted,
          row.session_id,
          row.generation,
        ).equals(plaintext)
      ) {
        throw new Error("Protected transcript archive migration failed read-back verification.");
      }
      const digest = createHash("sha256").update(encrypted).digest("hex");
      const result = updateArchive.run(encrypted, digest, row.session_id, row.generation);
      if (Number(result.changes) !== 1) {
        throw new Error("Transcript archive changed during protected storage migration.");
      }
      const stored = database
        .prepare(
          "SELECT archive_blob, archive_sha256 FROM session_transcript_archives WHERE session_id = ? AND generation = ?",
        )
        .get(row.session_id, row.generation);
      if (
        !(stored?.archive_blob instanceof Uint8Array) ||
        stored.archive_sha256 !== digest ||
        !openSessionTranscriptArchiveBytes(
          database,
          stored.archive_blob,
          row.session_id,
          row.generation,
        ).equals(plaintext)
      ) {
        throw new Error("Protected transcript archive migration failed persisted read-back.");
      }
    }
  }
  const coldArchivesExist = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_cold_archives'",
      )
      .get(),
  );
  if (coldArchivesExist) {
    const archiveRows = database.prepare(`
      SELECT session_id, generation, archive_name, archive_sha256, archive_bytes, storage, archive_blob
      FROM session_transcript_cold_archives
      ORDER BY session_id
    `);
    const updateArchive = database.prepare(`
      UPDATE session_transcript_cold_archives
      SET archive_sha256 = ?, archive_bytes = ?, storage = 'sqlite', archive_blob = ?
      WHERE session_id = ? AND generation = ?
    `);
    for (const row of archiveRows.iterate()) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.generation !== "string" ||
        typeof row.archive_name !== "string" ||
        typeof row.archive_sha256 !== "string" ||
        typeof row.archive_bytes !== "number" ||
        (row.storage !== "file" && row.storage !== "sqlite")
      ) {
        throw new Error("Invalid cold transcript archive during protected storage migration.");
      }
      if (performance.now() - renewedAt >= 1_000) {
        renewAgentDatabaseMaintenanceAuthorityIfPresent();
        renewedAt = performance.now();
      }
      const storePath = database.location();
      if (!storePath) {
        throw new Error("Protected cold archive migration cannot resolve the agent database path.");
      }
      const archiveBlob = row.archive_blob;
      let sourceBytes: Buffer;
      if (row.storage === "sqlite") {
        if (!(archiveBlob instanceof Uint8Array)) {
          throw new Error("SQLite cold transcript archive is missing its stored bytes.");
        }
        sourceBytes = Buffer.from(archiveBlob);
      } else {
        sourceBytes = fs.readFileSync(resolveSessionColdArchivePath(storePath, row.archive_name));
      }
      if (
        sourceBytes.length !== row.archive_bytes ||
        createHash("sha256").update(sourceBytes).digest("hex") !== row.archive_sha256
      ) {
        throw new Error(
          `Cold transcript archive ${row.archive_name} failed verification during protected storage migration.`,
        );
      }
      const context = sessionColdArchiveStorageContext(row.session_id, row.generation);
      const plaintext = openSqliteStorageBytes(database, sourceBytes, context);
      const encrypted = sealSqliteStorageBytes(database, plaintext, context);
      if (!openSqliteStorageBytes(database, encrypted, context).equals(plaintext)) {
        throw new Error("Protected cold archive migration failed read-back verification.");
      }
      const digest = createHash("sha256").update(encrypted).digest("hex");
      const result = updateArchive.run(
        digest,
        encrypted.length,
        encrypted,
        row.session_id,
        row.generation,
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Cold transcript archive changed during protected storage migration.");
      }
      const stored = database
        .prepare(
          "SELECT archive_sha256, archive_bytes, storage, archive_blob FROM session_transcript_cold_archives WHERE session_id = ? AND generation = ?",
        )
        .get(row.session_id, row.generation);
      if (
        stored?.storage !== "sqlite" ||
        stored.archive_sha256 !== digest ||
        stored.archive_bytes !== encrypted.length ||
        !(stored.archive_blob instanceof Uint8Array) ||
        !openSqliteStorageBytes(database, stored.archive_blob, context).equals(plaintext)
      ) {
        throw new Error(
          "Protected cold archive migration failed persisted read-back verification.",
        );
      }
    }
  }
  const hasPendingInputs = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_pending_inputs'",
      )
      .get(),
  );
  if (hasPendingInputs) {
    const pendingRows = database.prepare(
      "SELECT input_id, message_json FROM session_pending_inputs ORDER BY seq",
    );
    const updatePending = database.prepare(
      "UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?",
    );
    for (const row of pendingRows.iterate()) {
      if (typeof row.input_id !== "string" || typeof row.message_json !== "string") {
        throw new Error("Invalid pending input during protected storage migration.");
      }
      const plaintext = openSessionPendingInputMessage(database, row.input_id, row.message_json);
      const encrypted = sealSessionPendingInputMessage(database, row.input_id, plaintext);
      if (openSessionPendingInputMessage(database, row.input_id, encrypted) !== plaintext) {
        throw new Error("Protected pending input migration failed read-back verification.");
      }
      const result = updatePending.run(encrypted, row.input_id);
      if (Number(result.changes) !== 1) {
        throw new Error("Pending input changed during protected storage migration.");
      }
      const stored = database
        .prepare("SELECT message_json FROM session_pending_inputs WHERE input_id = ?")
        .get(row.input_id);
      if (
        typeof stored?.message_json !== "string" ||
        openSessionPendingInputMessage(database, row.input_id, stored.message_json) !== plaintext
      ) {
        throw new Error(
          "Protected pending input migration failed persisted read-back verification.",
        );
      }
    }
  }
  const hasInputCompletions = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_input_completions'",
      )
      .get(),
  );
  if (hasInputCompletions) {
    const completionRows = database.prepare(
      "SELECT session_id, idempotency_key, outcome_json FROM session_input_completions",
    );
    const updateCompletion = database.prepare(`
      UPDATE session_input_completions SET outcome_json = ?
      WHERE session_id = ? AND idempotency_key = ?
    `);
    for (const row of completionRows.iterate()) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.idempotency_key !== "string" ||
        typeof row.outcome_json !== "string"
      ) {
        throw new Error("Invalid pending input completion during protected storage migration.");
      }
      const plaintext = openSessionInputCompletionOutcome(
        database,
        row.session_id,
        row.idempotency_key,
        row.outcome_json,
      );
      const encrypted = sealSessionInputCompletionOutcome(
        database,
        row.session_id,
        row.idempotency_key,
        plaintext,
      );
      if (
        openSessionInputCompletionOutcome(
          database,
          row.session_id,
          row.idempotency_key,
          encrypted,
        ) !== plaintext
      ) {
        throw new Error("Protected input completion migration failed read-back verification.");
      }
      const result = updateCompletion.run(encrypted, row.session_id, row.idempotency_key);
      if (Number(result.changes) !== 1) {
        throw new Error("Input completion changed during protected storage migration.");
      }
      const stored = database
        .prepare(
          "SELECT outcome_json FROM session_input_completions WHERE session_id = ? AND idempotency_key = ?",
        )
        .get(row.session_id, row.idempotency_key);
      if (
        typeof stored?.outcome_json !== "string" ||
        openSessionInputCompletionOutcome(
          database,
          row.session_id,
          row.idempotency_key,
          stored.outcome_json,
        ) !== plaintext
      ) {
        throw new Error(
          "Protected input completion migration failed persisted read-back verification.",
        );
      }
    }
  }
  database.exec(`
    CREATE TABLE ${PROTECTED_SESSION_ENTRY_TABLE} (
      session_key TEXT NOT NULL PRIMARY KEY
        REFERENCES session_nodes(session_key) ON DELETE CASCADE,
      encrypted_entry_json TEXT NOT NULL
    ) STRICT;
  `);
  const sessionNodes = database.prepare(`
    SELECT session_key, entry_json
    FROM session_nodes
    ORDER BY session_key
  `);
  const sessionSnapshots = database.prepare(`
    SELECT field, value_json
    FROM session_entry_snapshots
    WHERE session_key = ?
  `);
  const insertProtectedEntry = database.prepare(`
    INSERT INTO ${PROTECTED_SESSION_ENTRY_TABLE} (session_key, encrypted_entry_json)
    VALUES (?, ?)
  `);
  const updateSessionNode = database.prepare(`
    UPDATE session_nodes
    SET entry_json = ?, label = NULL, display_name = NULL
    WHERE session_key = ?
  `);
  const clearWindowDisplayName = database.prepare(
    "UPDATE session_windows SET display_name = NULL WHERE session_key = ?",
  );
  const clearSnapshots = database.prepare(
    "DELETE FROM session_entry_snapshots WHERE session_key = ?",
  );
  for (const row of sessionNodes.iterate()) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    if (typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
      throw new Error("Invalid session entry during protected storage migration.");
    }
    let entry: unknown;
    try {
      entry = JSON.parse(row.entry_json);
    } catch (error) {
      throw new Error(
        "Protected session entry migration cannot preserve malformed JSON; repair the entry before retrying.",
        { cause: error },
      );
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Protected session entry migration found a non-object session entry.");
    }
    for (const snapshot of sessionSnapshots.all(row.session_key)) {
      if (typeof snapshot.field !== "string" || typeof snapshot.value_json !== "string") {
        throw new Error("Invalid session entry snapshot during protected storage migration.");
      }
      (entry as Record<string, unknown>)[snapshot.field] = JSON.parse(snapshot.value_json);
    }
    const plaintext = JSON.stringify(entry);
    if (plaintext === undefined) {
      throw new Error("Protected session entry migration could not serialize a session entry.");
    }
    const context = protectedSessionEntryContext(row.session_key);
    const encrypted = sealSqliteStorageText(database, plaintext, context);
    if (openSqliteStorageText(database, encrypted, context) !== plaintext) {
      throw new Error("Protected session entry migration failed read-back verification.");
    }
    insertProtectedEntry.run(row.session_key, encrypted);
    const stored = database
      .prepare(
        `SELECT encrypted_entry_json FROM ${PROTECTED_SESSION_ENTRY_TABLE} WHERE session_key = ?`,
      )
      .get(row.session_key);
    if (
      typeof stored?.encrypted_entry_json !== "string" ||
      openSqliteStorageText(database, stored.encrypted_entry_json, context) !== plaintext
    ) {
      throw new Error("Protected session entry migration failed persisted read-back verification.");
    }
    const updated = updateSessionNode.run(
      protectSessionEntryProjection(plaintext),
      row.session_key,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error("Session entry changed during protected storage migration.");
    }
    clearWindowDisplayName.run(row.session_key);
    clearSnapshots.run(row.session_key);
  }
  database.exec(`
    DELETE FROM session_transcript_fts;
    DELETE FROM session_transcript_fts_rows;
  `);
  database.exec(`
    CREATE TABLE ${PROTECTED_ENCRYPTION_TABLE} (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      key_check TEXT NOT NULL,
      cleanup_pending INTEGER NOT NULL DEFAULT 1 CHECK (cleanup_pending IN (0, 1))
    ) STRICT;
  `);
  const keyCheck = sealSqliteStorageText(
    database,
    PROTECTED_ENCRYPTION_KEY_CHECK_VALUE,
    PROTECTED_ENCRYPTION_KEY_CHECK,
  );
  database
    .prepare(`INSERT INTO ${PROTECTED_ENCRYPTION_TABLE} (id, key_check) VALUES (1, ?)`)
    .run(keyCheck);
  if (
    openSqliteStorageText(database, keyCheck, PROTECTED_ENCRYPTION_KEY_CHECK) !==
    PROTECTED_ENCRYPTION_KEY_CHECK_VALUE
  ) {
    throw new Error("Protected storage migration failed key-check verification.");
  }
}
