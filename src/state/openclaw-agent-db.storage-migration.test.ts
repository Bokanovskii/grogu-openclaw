import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
import { acpParentStreamEventStorageContext } from "../agents/subagents/spawn/acp-parent-stream-storage.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import {
  PROTECTED_SESSION_ENTRY_TABLE,
  protectedSessionEntryContext,
} from "../config/sessions/session-entry-encryption.js";
import {
  openSessionInputCompletionOutcome,
  openSessionPendingInputMessage,
} from "../config/sessions/session-pending-input-encryption.js";
import { openSessionTranscriptArchiveBytes } from "../config/sessions/session-transcript-archive-encryption.js";
import { readTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { decodeUsageCostRollup } from "../infra/session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "../infra/session-cost-usage-rollup.js";
import { resolveZstdCodec } from "../infra/zstd-codec.js";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  openSqliteStorageText,
  registerSqliteStorageValueEncryption,
} from "../storage/sqlite-encryption.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { trajectoryRuntimeEventStorageContext } from "../trajectory/storage-context.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { assertSupportedAgentSchemaVersion } from "./openclaw-agent-db-schema-read.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  seedOpenClawAgentSchemaV22,
  OPENCLAW_AGENT_SCHEMA_V22_SQL,
} from "./openclaw-agent-schema-v22.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";

afterEach(() => vi.restoreAllMocks());

it("atomically migrates protected transcript data and refuses unsupported or wrong keys", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("protected-encryption.sqlite");
    const plaintext = JSON.stringify({
      type: "message",
      id: "protected-encryption-event",
      message: { role: "user", content: "protected-plaintext-sentinel" },
    });
    const trajectoryPlaintext = JSON.stringify({
      type: "message",
      content: "protected-trajectory-sentinel",
    });
    const acpPlaintext = JSON.stringify({
      type: "text",
      content: "protected-acp-sentinel",
    });
    const pendingInputPlaintext = JSON.stringify({
      role: "user",
      content: "protected-pending-input-sentinel",
    });
    const completionPlaintext = JSON.stringify({
      reason: "completed",
      resultText: "protected-completion-sentinel",
    });
    const sessionKey = "agent:main:protected";
    const sessionEntry = JSON.stringify({
      sessionId: "protected-session",
      updatedAt: 2,
      title: "protected-title-sentinel",
      summary: "protected-summary-sentinel",
    });
    const snapshot = JSON.stringify({
      prompt: "protected-snapshot-sentinel",
      skills: [],
    });
    const archiveBytes = Buffer.from(
      '{"type":"message","message":{"role":"user","content":"protected-archive-sentinel"}}\n',
    );
    const archiveName = "protected.jsonl.deleted.20261120T000000000Z.generation.jsonl";
    const archivePath = path.join(resolveSessionArtifactDirectory(pathname), archiveName);
    fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    const key = Buffer.alloc(32, 0x37);
    const database = new DatabaseSync(pathname);
    registerSqliteStorageValueEncryption(database, createStorageValueEncryption(key));
    try {
      database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      persistAgentSchemaMetadata(database, "main", OPENCLAW_AGENT_SCHEMA_VERSION);
      database.exec(`
        INSERT INTO session_transcript_archives(
          session_id, generation, session_key, reason, encoding, archive_blob,
          archive_sha256, archive_name, created_at, published_at
        ) VALUES(
          'protected-session', 'protected-generation', 'agent:main:protected',
          'deleted', 'identity', X'${archiveBytes.toString("hex")}',
          '${sha256Hex(archiveBytes)}', '${archiveName}', 4, 5
        );
        INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
          VALUES('agent:main:protected', 'protected-session', '${sessionEntry.replaceAll("'", "''")}', 2);
        INSERT INTO session_windows(session_id, session_key, created_at, updated_at, display_name)
          VALUES('protected-session', 'agent:main:protected', 1, 2, 'protected-window-sentinel');
        INSERT INTO session_entry_snapshots(session_key, field, value_json)
          VALUES('agent:main:protected', 'skillsSnapshot', '${snapshot.replaceAll("'", "''")}');
        INSERT INTO session_suggestions(id, session_key, author_id, author_label, text, created_at, state)
          VALUES('idea', 'agent:main:protected', 'suggestion-author', NULL, 'suggestion-text', 1, 'pending');
        UPDATE session_nodes
          SET label = 'protected-label-sentinel', display_name = 'protected-display-sentinel'
          WHERE session_key = 'agent:main:protected';
        INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
          VALUES(7, 'protected-plaintext-sentinel', 'protected-session',
            'protected-encryption-event', 'user', 3);
      `);
      database
        .prepare(
          "INSERT INTO transcript_events(session_id, seq, event_json, created_at) VALUES(?, 7, ?, 3)",
        )
        .run("protected-session", plaintext);
      database
        .prepare(
          "INSERT INTO trajectory_runtime_events(session_id, seq, event_json, created_at) VALUES(?, 8, ?, 3)",
        )
        .run("protected-session", trajectoryPlaintext);
      database
        .prepare(
          "INSERT INTO acp_parent_stream_events(session_id, run_id, seq, event_json, created_at) VALUES(?, ?, 9, ?, 3)",
        )
        .run("protected-session", "protected-parent-run", acpPlaintext);
      database
        .prepare(
          `INSERT INTO session_pending_inputs(
            input_id, session_key, session_id, idempotency_key, run_id, request_hash,
            message_json, lifecycle_generation, state, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 4)`,
        )
        .run(
          "protected-pending-id",
          sessionKey,
          "protected-session",
          "protected-pending-key",
          "protected-pending-run",
          "protected-pending-hash",
          pendingInputPlaintext,
          "protected-lifecycle",
        );
      database
        .prepare(
          `INSERT INTO session_input_completions(
            session_key, session_id, idempotency_key, run_id, request_hash,
            outcome_json, succeeded, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 5)`,
        )
        .run(
          sessionKey,
          "protected-session",
          "protected-completion-key",
          "protected-completion-run",
          "protected-completion-hash",
          completionPlaintext,
        );
      database.exec(`
        CREATE TRIGGER interrupt_protected_storage_migration
        BEFORE UPDATE ON transcript_events
        BEGIN
          SELECT RAISE(ABORT, 'simulated migration interruption');
        END;
      `);
      await expect(
        withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            path: pathname,
            env: state.env,
          });
        }),
      ).rejects.toThrow("simulated migration interruption");
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        database.prepare("SELECT event_json FROM transcript_events WHERE seq = 7").get()
          ?.event_json,
      ).toBe(plaintext);
      expect(
        database.prepare("SELECT event_json FROM trajectory_runtime_events WHERE seq = 8").get()
          ?.event_json,
      ).toBe(trajectoryPlaintext);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'grogu_protected_storage'")
          .get(),
      ).toBeUndefined();
      database.exec("DROP TRIGGER interrupt_protected_storage_migration;");

      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          path: pathname,
          env: state.env,
        });
      });
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(28);
      const suggestion = database
        .prepare("SELECT author_id, author_label, text FROM session_suggestions WHERE id = 'idea'")
        .get();
      expect(suggestion?.author_id).not.toBe("suggestion-author");
      expect(suggestion?.author_label).toBeNull();
      expect(suggestion?.text).not.toBe("suggestion-text");
      expect(
        database
          .prepare("PRAGMA table_info(session_transcript_archives)")
          .all()
          .some((column) => column.name === "protected_attribution"),
      ).toBe(true);
      const event = database
        .prepare(
          "SELECT event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE seq = 7",
        )
        .get();
      expect(typeof event?.event_json).toBe("string");
      expect(event?.event_json).not.toContain("protected-plaintext-sentinel");
      expect(event?.event_zstd).toBeNull();
      const trajectoryEvent = database
        .prepare("SELECT event_json FROM trajectory_runtime_events WHERE seq = 8")
        .get()?.event_json;
      expect(typeof trajectoryEvent).toBe("string");
      expect(trajectoryEvent).not.toContain("protected-trajectory-sentinel");
      const encryptedEntry = database
        .prepare(
          `SELECT encrypted_entry_json FROM ${PROTECTED_SESSION_ENTRY_TABLE} WHERE session_key = ?`,
        )
        .get(sessionKey)?.encrypted_entry_json;
      expect(typeof encryptedEntry).toBe("string");
      expect(
        openSqliteStorageText(
          database,
          encryptedEntry as string,
          protectedSessionEntryContext(sessionKey),
        ),
      ).toBe(
        JSON.stringify({
          sessionId: "protected-session",
          updatedAt: 2,
          title: "protected-title-sentinel",
          summary: "protected-summary-sentinel",
          skillsSnapshot: { prompt: "protected-snapshot-sentinel", skills: [] },
        }),
      );
      expect(
        database
          .prepare(
            "SELECT entry_json, label, display_name FROM session_nodes WHERE session_key = ?",
          )
          .get(sessionKey),
      ).toEqual({
        entry_json: JSON.stringify({ sessionId: "protected-session", updatedAt: 2 }),
        label: null,
        display_name: null,
      });
      expect(
        database.prepare("SELECT count(*) AS count FROM session_entry_snapshots").get()?.count,
      ).toBe(0);
      expect(
        database
          .prepare("SELECT display_name FROM session_windows WHERE session_key = ?")
          .get(sessionKey)?.display_name,
      ).toBeNull();
      expect(
        openSqliteStorageText(
          database,
          trajectoryEvent as string,
          trajectoryRuntimeEventStorageContext("protected-session", 8),
        ),
      ).toBe(trajectoryPlaintext);
      const acpEvent = database
        .prepare(
          "SELECT event_json FROM acp_parent_stream_events WHERE session_id = ? AND run_id = ? AND seq = 9",
        )
        .get("protected-session", "protected-parent-run")?.event_json;
      expect(typeof acpEvent).toBe("string");
      expect(acpEvent).not.toContain("protected-acp-sentinel");
      expect(
        openSqliteStorageText(
          database,
          acpEvent as string,
          acpParentStreamEventStorageContext("protected-session", "protected-parent-run", 9),
        ),
      ).toBe(acpPlaintext);
      const pendingInput = database
        .prepare("SELECT message_json FROM session_pending_inputs WHERE input_id = ?")
        .get("protected-pending-id")?.message_json;
      expect(typeof pendingInput).toBe("string");
      expect(pendingInput).not.toContain("protected-pending-input-sentinel");
      expect(
        openSessionPendingInputMessage(database, "protected-pending-id", pendingInput as string),
      ).toBe(pendingInputPlaintext);
      const completion = database
        .prepare(
          "SELECT outcome_json FROM session_input_completions WHERE session_id = ? AND idempotency_key = ?",
        )
        .get("protected-session", "protected-completion-key")?.outcome_json;
      expect(typeof completion).toBe("string");
      expect(completion).not.toContain("protected-completion-sentinel");
      expect(
        openSessionInputCompletionOutcome(
          database,
          "protected-session",
          "protected-completion-key",
          completion as string,
        ),
      ).toBe(completionPlaintext);
      const encryptedArchive = database
        .prepare(
          "SELECT archive_blob, archive_sha256, published_at FROM session_transcript_archives WHERE session_id = ? AND generation = ?",
        )
        .get("protected-session", "protected-generation");
      expect(encryptedArchive?.archive_blob).toBeInstanceOf(Uint8Array);
      expect(encryptedArchive?.archive_blob).not.toEqual(archiveBytes);
      expect(encryptedArchive?.archive_sha256).not.toBe(sha256Hex(archiveBytes));
      expect(encryptedArchive?.published_at).toBeNull();
      if (!(encryptedArchive?.archive_blob instanceof Uint8Array)) {
        throw new Error("Expected an encrypted transcript archive.");
      }
      expect(
        openSessionTranscriptArchiveBytes(
          database,
          encryptedArchive.archive_blob,
          "protected-session",
          "protected-generation",
        ),
      ).toEqual(archiveBytes);
      expect(fs.existsSync(archivePath)).toBe(false);
      expect(
        database.prepare("SELECT count(*) AS count FROM session_transcript_fts").get()?.count,
      ).toBe(0);
      expect(
        database.prepare("SELECT cleanup_pending FROM grogu_protected_storage WHERE id = 1").get()
          ?.cleanup_pending,
      ).toBe(0);
      expect(
        readTranscriptPayload(
          {
            event_json: event?.event_json as string,
            event_zstd: null,
            event_utf8_bytes: event?.event_utf8_bytes as number | null,
          },
          {
            database,
            sessionId: "protected-session",
            seq: 7,
          },
        ),
      ).toBe(plaintext);
      const persistedFiles = [pathname, `${pathname}-wal`].filter(fs.existsSync);
      expect(
        persistedFiles.some(
          (file) =>
            fs.readFileSync(file).includes(Buffer.from("protected-plaintext-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-trajectory-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-title-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-summary-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-snapshot-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-label-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-display-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-window-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-archive-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-acp-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-pending-input-sentinel")) ||
            fs.readFileSync(file).includes(Buffer.from("protected-completion-sentinel")),
        ),
      ).toBe(false);
    } finally {
      disposeSqliteStorageValueEncryption(database);
      database.close();
    }

    const missingKeyDatabase = new DatabaseSync(pathname);
    try {
      expect(() => assertSupportedAgentSchemaVersion(missingKeyDatabase, pathname)).toThrow(
        "key is unavailable",
      );
    } finally {
      missingKeyDatabase.close();
    }

    const wrongKeyDatabase = new DatabaseSync(pathname);
    registerSqliteStorageValueEncryption(
      wrongKeyDatabase,
      createStorageValueEncryption(Buffer.alloc(32, 0x38)),
    );
    try {
      expect(() => assertSupportedAgentSchemaVersion(wrongKeyDatabase, pathname)).toThrow(
        "could not be opened with the configured storage key",
      );
    } finally {
      disposeSqliteStorageValueEncryption(wrongKeyDatabase);
      wrongKeyDatabase.close();
    }
  });
});

function seedHistoricalData(db: DatabaseSync) {
  const event = ` {"type":"message","id":"first","id":"second","parentId":null,"message":{"role":"assistant","content":${JSON.stringify("saffronquasar 雪🦞 ".repeat(1024))}}}\n`;
  db.exec(`
    INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
      VALUES('agent:main:history', 'hot', '{"sessionId":"hot","updatedAt":2}', 2);
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      VALUES('hot', 'agent:main:history', 1, 2), ('cold', 'agent:main:history', 1, 2);
    INSERT INTO transcript_rewrite_watermarks(session_id, generation, updated_at)
      VALUES('hot', 'original-generation', 2);
    UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:history';
  `);
  const insert = db.prepare(
    "INSERT INTO transcript_events(rowid, session_id, seq, event_json, created_at) VALUES(?, 'hot', ?, ?, ?)",
  );
  insert.run(41, 7, event, 11);
  insert.run(52, 90, '{ "type": "custom", "data": "small 雪" }', 12);
  insert.run(63, 99, "{broken\0snow雪", 13);
  db.exec(`
    INSERT INTO transcript_event_identities(session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES('hot', 'first', 7, 'message', NULL, 'original-idempotency', 11);
    INSERT INTO session_transcript_active_events(session_id, active_position, event_seq, message_position, context_eligible)
      VALUES('hot', 0, 7, 0, 1);
    INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
      VALUES
        (-17, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-18'),
        (42, 'saffronquasar', 'cold', 'cold-message', 'user', '2026-09-17'),
        (83, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-19'),
        (9007199254740993, 'saffronquasar', 'hot', NULL, 'tool', '2026-09-20');
    INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES('memory/note.md', 'memory', 'source-hash', 1.5, 42);
    INSERT INTO memory_index_chunks(rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES(17, 'chunk', 'memory/note.md', 'memory', 1, 3, 'chunk-hash', 'synthetic', 'saffronquasar memory', '[1.0000000000000002,0.1]', 19);
    INSERT INTO memory_index_chunk_provenance(chunk_id, origin_class, session_kind, observed_at, supersedes_key)
      VALUES('chunk', 'owner', 'interactive', 18, 'older-chunk');
    INSERT INTO memory_index_chunk_recall_metadata(chunk_id, importance, triggers, project_key)
      VALUES('chunk', 7, '["saffronquasar"]', 'project');
    INSERT INTO memory_embedding_cache(rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES(23, 'synthetic', 'model', 'provider-key', 'chunk-hash', '[1.0000000000000002,0.1]', 2, 20);
  `);
  const archive = Buffer.from('{"type":"message","id":"cold-message"}\n');
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("Cold transcript fixture requires Zstd support");
  }
  const compressedArchive = codec.compress(archive);
  db.prepare(`INSERT INTO session_transcript_cold_archives
    (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage, archive_blob)
    VALUES('cold', 'cold-generation', 'cold.jsonl.zst', ?, 1, ?, ?, 10, 21, 'sqlite', ?)`).run(
    sha256Hex(compressedArchive),
    archive.length,
    compressedArchive.length,
    compressedArchive,
  );
  const rollup = createSessionUsageRollupData();
  rollup.untimestamped.totals.totalTokens = 17;
  const usage = {
    version: 7,
    pricingFingerprint: "synthetic",
    checkpoint: {
      kind: "jsonl",
      parsedOffset: 7,
      observedSize: 7,
      observedMtimeMs: 1,
      device: 1,
      inode: 2,
      anchorHash: "anchor",
    },
    scannedAt: 10,
    parsedRecords: 1,
    countedRecords: 0,
    rollup,
  };
  db.prepare(
    "INSERT INTO cache_entries(scope, key, value_json, blob, expires_at, updated_at) VALUES('session-cost-usage-rollup-v2', 'usage', ?, NULL, NULL, 31)",
  ).run(JSON.stringify(usage));
  db.exec(`INSERT INTO session_transcript_index_state
    (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, updated_at)
    VALUES ('hot', 99, 1, 1, 1, 101);`);
  seedDeployedFtsOwnership(db);
  return { event, usage };
}

const dirtyV22Sessions = new Set([
  "hot",
  "missing-map",
  "partial",
  "dangling",
  "claimed",
  "misowned",
  "misowner",
]);

function seedDeployedFtsOwnership(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      SELECT value, 'agent:main:history', 1, 2 FROM json_each('["missing-map","partial","dangling","claimed","missing-state","clean-empty","misowned","misowner"]');
    INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
      VALUES (201, 'saffronquasar', 'missing-map', 'missing', 'user', 1),
             (202, 'saffronquasar', 'partial', 'partial-a', 'user', 2),
             (203, 'saffronquasar', 'partial', 'partial-b', 'assistant', '2'),
             (204, 'saffronquasar', 'dangling', 'dangling', 'tool', NULL),
             (205, 'saffronquasar', 'claimed', 'claim', 'assistant', 3),
             (206, 'saffronquasar', 'missing-state', 'unindexed', 'user', 4),
             (207, 'saffronquasar', 'misowned', 'misowned', 'user', 5);
    INSERT INTO session_transcript_index_state
      (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, fts_row_count, updated_at)
      VALUES ('cold', 10, 0, 1, 1, 1, 102),
             ('missing-map', 1, 0, 1, 1, 1, 103),
             ('partial', 2, 0, 2, 2, 2, 104),
             ('dangling', 1, 0, 1, 1, 1, 105),
             ('claimed', -1, 1, 0, 0, NULL, 8675309),
             ('clean-empty', -1, 0, 0, 0, 0, 106),
             ('misowned', 1, 0, 1, 1, 0, 107),
             ('misowner', -1, 0, 0, 0, 1, 108);
    UPDATE session_transcript_index_state SET needs_rebuild = 0, fts_row_count = NULL WHERE session_id = 'hot';
    INSERT INTO session_transcript_fts_rows(session_id, fts_rowid)
      VALUES ('hot', -17), ('cold', 42), ('partial', 202), ('dangling', 999), ('misowner', 207);
  `);
}

const preservedTables = [
  "session_nodes",
  "session_canonical_validation_pending",
  "session_windows",
  "transcript_event_identities",
  "session_transcript_active_events",
  "transcript_rewrite_watermarks",
  "session_transcript_cold_archives",
  "session_transcript_fts",
  "memory_index_sources",
  "memory_index_chunk_provenance",
  "memory_index_chunk_recall_metadata",
  "memory_index_state",
] as const;

function preservedRows(db: DatabaseSync) {
  return Object.fromEntries(
    preservedTables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

function ftsStorage(db: DatabaseSync) {
  return Object.fromEntries(
    [
      ["data", "rowid"],
      ["idx", "segid, term"],
      ["content", "rowid"],
      ["docsize", "rowid"],
      ["config", "k"],
    ].map(([suffix, order]) => {
      const statement = db.prepare(
        `SELECT * FROM session_transcript_fts_${suffix} ORDER BY ${order}`,
      );
      statement.setReadBigInts(true);
      return [suffix, statement.all()];
    }),
  );
}

function legacySnapshot(db: DatabaseSync) {
  const fts = db.prepare("SELECT rowid, * FROM session_transcript_fts ORDER BY rowid");
  fts.setReadBigInts(true);
  const matches = db.prepare(
    "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar' ORDER BY rank",
  );
  matches.setReadBigInts(true);
  return {
    schema: db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
    version: db.prepare("PRAGMA user_version").get(),
    owner: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    events: db
      .prepare(
        "SELECT rowid, session_id, seq, hex(CAST(event_json AS BLOB)) AS bytes, created_at FROM transcript_events ORDER BY rowid",
      )
      .all(),
    chunks: db.prepare("SELECT rowid, * FROM memory_index_chunks ORDER BY rowid").all(),
    vectors: db.prepare("SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid").all(),
    cache: db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all(),
    indexState: db
      .prepare("SELECT * FROM session_transcript_index_state ORDER BY session_id")
      .all(),
    ftsMapping: (() => {
      if (
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_transcript_fts_rows'").get()
      ) {
        return undefined;
      }
      const statement = db.prepare("SELECT * FROM session_transcript_fts_rows ORDER BY rowid");
      statement.setReadBigInts(true);
      return statement.all();
    })(),
    ftsStorage: ftsStorage(db),
    fts: fts.all(),
    matches: matches.all(),
    preserved: preservedRows(db),
  };
}

it("refuses a schema22 dependent view without changing storage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("unsupported22.sqlite");
    const db = new DatabaseSync(pathname);
    try {
      seedOpenClawAgentSchemaV22(db);
      seedHistoricalData(db);
      db.exec(
        "CREATE VIEW retained_fts_map AS SELECT fts_rowid, session_id FROM session_transcript_fts_rows",
      );
      const before = legacySnapshot(db);
      await expect(
        withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(db, {
            agentId: "main",
            path: pathname,
            env: state.env,
          });
        }),
      ).rejects.toThrow();
      expect(legacySnapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe("agent schema 22 storage cutover", () => {
  it("rolls back converted storage when the maintenance scope rejects publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("revoked-coverage21.sqlite");
      const db = new DatabaseSync(pathname);
      const scope = createOpenClawDatabaseMaintenanceScope();
      const refusal = new Error("Recovery backup coverage is no longer current");
      let reachedPublication = false;
      try {
        seedOpenClawAgentSchemaV22(db);
        seedHistoricalData(db);
        const before = legacySnapshot(db);
        scope.addAgentSchemaMigrationCheck((migration) => {
          if (
            migration.path === pathname &&
            db.prepare("PRAGMA user_version").get()?.user_version === OPENCLAW_AGENT_SCHEMA_VERSION
          ) {
            reachedPublication = true;
            throw refusal;
          }
        });
        await expect(
          scope.run(() =>
            withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
              ensureOpenClawAgentDatabaseSchema(db, {
                agentId: "main",
                path: pathname,
                env: state.env,
              });
            }),
          ),
        ).rejects.toBe(refusal);
        expect(reachedPublication).toBe(true);
        expect(legacySnapshot(db)).toEqual(before);
      } finally {
        try {
          await scope.close();
        } finally {
          db.close();
        }
      }
    });
  });

  it.each(["UTF-8", "UTF-16le"] as const)(
    "atomically publishes all new formats from a genuine %s historical database",
    async (encoding) => {
      expect(sha256Hex(OPENCLAW_AGENT_SCHEMA_V22_SQL)).toBe(
        "23f2a1e85494a512bce3f32623aed2beaf4e82bbeeb4362f6cc33d5dd3b8a6ea",
      );
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("legacy21.sqlite");
        let db = new DatabaseSync(pathname);
        let observer: DatabaseSync | undefined;
        try {
          db.exec(`PRAGMA encoding = '${encoding}'; PRAGMA journal_mode = WAL`);
          seedOpenClawAgentSchemaV22(db);
          const { event, usage } = seedHistoricalData(db);
          db.close();
          db = new DatabaseSync(pathname);
          const before = legacySnapshot(db);
          // These entries have no cold fields: migration only adds their initial revision.
          const expectedPreserved = {
            ...before.preserved,
            session_nodes: db
              .prepare("SELECT *, 0 AS snapshot_revision FROM session_nodes ORDER BY rowid")
              .all(),
          };
          expect(
            db
              .prepare(
                `SELECT type, "notnull" AS not_null FROM pragma_table_info('transcript_events') WHERE name = 'event_json'`,
              )
              .get(),
          ).toEqual({ type: "TEXT", not_null: 1 });
          expect(
            db
              .prepare(
                "SELECT name FROM pragma_table_info('transcript_events') WHERE name = 'event_zstd'",
              )
              .get(),
          ).toBeUndefined();
          observer = new DatabaseSync(pathname, { readOnly: true });
          const reader = observer;
          let observedPublication = false;
          const exec = db.exec.bind(db);
          const write = vi.spyOn(db, "exec").mockImplementation((sql) => {
            exec(sql);
            if (sql === `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`) {
              observedPublication = true;
              expect(legacySnapshot(reader)).toEqual(before);
            }
          });
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
            ensureOpenClawAgentDatabaseSchema(db, {
              agentId: "main",
              path: pathname,
              env: state.env,
            });
          });
          write.mockRestore();
          expect(observedPublication).toBe(true);
          expect(reader.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(preservedRows(reader)).toEqual(expectedPreserved);
          expect(reader.prepare("SELECT * FROM session_entry_snapshots").all()).toEqual([]);
          const fts = reader.prepare("SELECT rowid, * FROM session_transcript_fts ORDER BY rowid");
          fts.setReadBigInts(true);
          expect(fts.all()).toEqual(before.fts);
          expect(ftsStorage(reader)).toEqual(before.ftsStorage);
          const matches = reader.prepare(
            "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar' ORDER BY rank",
          );
          matches.setReadBigInts(true);
          expect(matches.all()).toEqual(before.matches);
          const identities = reader.prepare(
            "SELECT id, session_id, message_id FROM session_transcript_fts_rows ORDER BY id",
          );
          identities.setReadBigInts(true);
          expect(identities.all()).toEqual(
            before.fts.map((row) => ({
              id: row.rowid,
              session_id: row.session_id,
              message_id: row.message_id,
            })),
          );
          expect(
            reader
              .prepare("SELECT * FROM session_transcript_index_state ORDER BY session_id")
              .all(),
          ).toEqual(
            before.indexState.map((row) => {
              const { fts_row_count: _count, ...preserved } = row;
              return {
                ...preserved,
                needs_rebuild: dirtyV22Sessions.has(String(row.session_id)) ? 1 : row.needs_rebuild,
              };
            }),
          );
          const rows = reader
            .prepare(
              "SELECT rowid, seq, event_json, event_zstd, event_utf8_bytes, hex(CAST(event_json AS BLOB)) AS bytes FROM transcript_events ORDER BY rowid",
            )
            .all();
          expect(rows.map((row) => [row.rowid, row.seq])).toEqual([
            [41, 7],
            [52, 90],
            [63, 99],
          ]);
          for (const [index, row] of rows.entries()) {
            if (row.event_zstd instanceof Uint8Array) {
              const codec = resolveZstdCodec();
              expect(codec).not.toBeNull();
              expect(
                codec!.decompress(row.event_zstd, Number(row.event_utf8_bytes)).toString("utf8"),
              ).toBe(event);
              expect(row.event_json).toBeNull();
            } else {
              expect(row.bytes).toBe(before.events[index]?.bytes);
            }
          }
          expect(rows[0]?.event_zstd instanceof Uint8Array).toBe(
            encoding === "UTF-8" && resolveZstdCodec() !== null,
          );
          const chunk = reader
            .prepare("SELECT chunk_rowid, embedding FROM memory_index_chunks WHERE id = 'chunk'")
            .get()!;
          expect(chunk.chunk_rowid).toBe(17);
          if (!(chunk.embedding instanceof Uint8Array)) {
            throw new Error("Expected binary chunk vector");
          }
          expect(decodeMemoryEmbedding(chunk.embedding)).toEqual([1 + Number.EPSILON, 0.1]);
          const vector = reader
            .prepare("SELECT rowid, embedding, dims, updated_at FROM memory_embedding_cache")
            .get()!;
          expect(vector).toMatchObject({ rowid: 23, dims: 2, updated_at: 20 });
          if (!(vector.embedding instanceof Uint8Array)) {
            throw new Error("Expected binary cached vector");
          }
          expect(decodeMemoryEmbedding(vector.embedding)).toEqual([1 + Number.EPSILON, 0.1]);
          const cached = reader
            .prepare(
              "SELECT scope, value_json, blob, updated_at FROM cache_entries WHERE key = 'usage'",
            )
            .get()!;
          expect(cached).toMatchObject({ scope: "session-cost-usage-rollup-v3", updated_at: 31 });
          if (typeof cached.value_json !== "string" || !(cached.blob instanceof Uint8Array)) {
            throw new Error("Expected migrated usage envelope/body");
          }
          expect(decodeUsageCostRollup(cached.value_json, "synthetic", cached.blob)).toEqual(usage);
          expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
          const migrated = legacySnapshot(db);
          ensureOpenClawAgentDatabaseSchema(db, {
            agentId: "main",
            path: pathname,
            env: state.env,
          });
          expect(legacySnapshot(db)).toEqual(migrated);
        } finally {
          observer?.close();
          db.close();
        }
      });
    },
  );

  it("rolls every conversion back when maintenance authority is lost", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("interrupted21.sqlite");
      let db = new DatabaseSync(pathname);
      try {
        seedOpenClawAgentSchemaV22(db);
        seedHistoricalData(db);
        db.close();
        db = new DatabaseSync(pathname);
        const before = legacySnapshot(db);
        let reachedPublication = false;
        const migrating = withAgentDatabaseMaintenanceLease(
          { env: state.env },
          async (maintenance) => {
            const exec = db.exec.bind(db);
            vi.spyOn(db, "exec").mockImplementation((sql) => {
              exec(sql);
              if (sql === `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`) {
                reachedPublication = true;
                runOpenClawStateWriteTransaction(
                  ({ db: shared }) => {
                    shared
                      .prepare(
                        "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?",
                      )
                      .run(
                        AGENT_DATABASE_MAINTENANCE_LEASE.scope,
                        AGENT_DATABASE_MAINTENANCE_LEASE.key,
                      );
                  },
                  { env: state.env },
                );
              }
            });
            try {
              ensureOpenClawAgentDatabaseSchema(db, {
                agentId: "main",
                path: pathname,
                env: state.env,
              });
            } finally {
              vi.restoreAllMocks();
              if (reachedPublication) {
                expect(() => maintenance.assertOwned()).toThrowError(
                  expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
                );
              }
            }
          },
        );
        const rejection: unknown = await migrating.catch((error: unknown) => error);
        const pending = [rejection];
        const causes = new Set<unknown>();
        for (const error of pending) {
          if (causes.has(error)) {
            continue;
          }
          causes.add(error);
          if (error instanceof Error && error.cause) {
            pending.push(error.cause);
          }
          if (error instanceof AggregateError) {
            pending.push(...error.errors);
          }
        }
        expect(
          [...causes].some(
            (error) =>
              error instanceof OpenClawStateLeaseError &&
              error.code === "OPENCLAW_STATE_LEASE_LOST",
          ),
        ).toBe(true);
        expect(reachedPublication).toBe(true);
        expect(legacySnapshot(db)).toEqual(before);
        expect(
          Boolean(
            db
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_fts_rows'")
              .get(),
          ),
        ).toBe(true);
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(db, {
            agentId: "main",
            path: pathname,
            env: state.env,
          });
        });
        expect(db.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });
  });
});
