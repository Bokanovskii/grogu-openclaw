import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { sha256Hex } from "../infra/crypto-digest.js";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  registerSqliteStorageValueEncryption,
} from "../storage/sqlite-encryption.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "./openclaw-agent-db-schema-helpers.js";
import { assertRequiredProtectedAgentStorage } from "./openclaw-agent-db-schema-read.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { migrateProtectedAgentStorageInTransaction } from "./openclaw-agent-protected-storage-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

afterEach(() => vi.restoreAllMocks());

it.each([26, 27])(
  "upgrades protected version %i suggestions without resealing archives",
  async (version) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("protected-v26.sqlite");
      const database = new DatabaseSync(pathname);
      registerSqliteStorageValueEncryption(
        database,
        createStorageValueEncryption(Buffer.alloc(32, 7)),
      );
      try {
        database.exec("PRAGMA journal_mode = WAL;");
        database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
        persistAgentSchemaMetadata(database, "main", OPENCLAW_AGENT_SCHEMA_VERSION);
        database
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
          )
          .run("agent:main:test", "session", '{"sessionId":"session","updatedAt":1}');
        database
          .prepare(
            "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, ?, ?, 1, 'pending')",
          )
          .run("idea", "agent:main:test", "author", "OCSEAL1:literal plaintext");
        const archive = Buffer.from("retained archive");
        database
          .prepare(
            `INSERT INTO session_transcript_archives(
            session_id, generation, session_key, reason, encoding, archive_blob,
            archive_sha256, archive_name, created_at
          ) VALUES (?, ?, ?, 'deleted', 'identity', ?, ?, ?, 1)`,
          )
          .run("session", "generation", "agent:main:test", archive, sha256Hex(archive), "archive");
        database.exec("BEGIN IMMEDIATE");
        migrateProtectedAgentStorageInTransaction(database);
        let existingAttribution: string | null = null;
        if (version === 27) {
          existingAttribution = "opaque-protected-attribution";
          database.exec(
            "ALTER TABLE session_transcript_archives ADD COLUMN protected_attribution TEXT",
          );
          database
            .prepare("UPDATE session_transcript_archives SET protected_attribution = ?")
            .run(existingAttribution);
        }
        database.exec(`PRAGMA user_version = ${version}`);
        persistAgentSchemaMetadata(database, "main", version);
        // A predecessor whose earlier conversion cleanup already finished.
        database.exec("UPDATE grogu_protected_storage SET cleanup_pending = 0 WHERE id = 1");
        database.exec("COMMIT");
        const before = database
          .prepare("SELECT archive_blob FROM session_transcript_archives")
          .get()?.archive_blob;

        assertRequiredProtectedAgentStorage(database, pathname);
        const exec = database.exec.bind(database);
        vi.spyOn(database, "exec").mockImplementation((sql) => {
          if (sql === "PRAGMA user_version = 28;") {
            throw new Error("synthetic interrupted publication");
          }
          exec(sql);
        });
        try {
          expect(() =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              path: pathname,
              env: state.env,
            }),
          ).toThrow("synthetic interrupted publication");
        } finally {
          vi.restoreAllMocks();
        }
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(version);
        expect(
          database
            .prepare("PRAGMA table_info(session_transcript_archives)")
            .all()
            .some((column) => column.name === "protected_attribution"),
        ).toBe(version === 27);
        expect(
          database.prepare("SELECT archive_blob FROM session_transcript_archives").get()
            ?.archive_blob,
        ).toEqual(before);
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          path: pathname,
          env: state.env,
        });

        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(28);
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(28);
        const retained = database
          .prepare("SELECT archive_blob, protected_attribution FROM session_transcript_archives")
          .get();
        expect(retained?.archive_blob).toEqual(before);
        expect(retained?.protected_attribution).toBe(existingAttribution);
        const suggestion = database
          .prepare("SELECT author_id, text FROM session_suggestions WHERE id = 'idea'")
          .get();
        expect(suggestion?.author_id).not.toBe("author");
        expect(
          openSqliteStorageText(
            database,
            String(suggestion?.text),
            protectedStorageValueContext("session_suggestions", "text", [
              "agent:main:test",
              "idea",
            ]),
          ),
        ).toBe("OCSEAL1:literal plaintext");
        expect(
          database.prepare("SELECT cleanup_pending FROM grogu_protected_storage").get()
            ?.cleanup_pending,
        ).toBe(0);
        for (const file of [pathname, `${pathname}-wal`]) {
          if (fs.existsSync(file)) {
            expect(fs.readFileSync(file).includes("literal plaintext")).toBe(false);
          }
        }
        assertRequiredProtectedAgentStorage(database, pathname);
        database.exec("ALTER TABLE session_transcript_archives DROP COLUMN protected_attribution");
        expect(() =>
          assertOpenClawAgentCurrentRuntimeSchema(database, { agentId: "main", pathname }),
        ).toThrow(/session_transcript_archives/);
        database.exec("DROP TABLE session_transcript_archives");
        expect(() =>
          assertOpenClawAgentCurrentRuntimeSchema(database, { agentId: "main", pathname }),
        ).toThrow(/session_transcript_archives/);
      } finally {
        disposeSqliteStorageValueEncryption(database);
        database.close();
      }
    });
  },
);
