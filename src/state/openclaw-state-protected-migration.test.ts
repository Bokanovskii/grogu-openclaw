import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  registerSqliteStorageValueEncryption,
} from "../storage/sqlite-encryption.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { repairStateSchema } from "./openclaw-state-db-repair.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { cleanupProtectedSharedStateAfterMigration } from "./openclaw-state-protected-cleanup.js";
import { readProtectedSharedStateMarker } from "./openclaw-state-protected-marker.js";
import { migrateProtectedSharedStateInTransaction } from "./openclaw-state-protected-migration.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { ensureProtectedFeedbackSchema } from "./protected-feedback.js";

it("admits existing encrypted feedback storage and installs chat evidence on first use", async () => {
  await withTempDir("protected-feedback-upgrade-", async (directory) => {
    const stateDir = path.join(directory, "state");
    const pathname = path.join(stateDir, "state", "openclaw.sqlite");
    const keyPath = path.join(directory, "key");
    mkdirSync(path.dirname(pathname), { recursive: true });
    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    const previous = new DatabaseSync(pathname);
    registerSqliteStorageValueEncryption(
      previous,
      createStorageValueEncryption(Buffer.alloc(32, 7)),
    );
    try {
      previous.exec(OPENCLAW_STATE_SCHEMA_SQL);
      previous.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        PRAGMA user_version = 20;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 20, 1, 1);
        BEGIN IMMEDIATE;
      `);
      migrateProtectedSharedStateInTransaction(previous);
      previous.exec("COMMIT");
      cleanupProtectedSharedStateAfterMigration(previous, () => {});
      previous.exec("DROP TABLE protected_report_chat_evidence");
    } finally {
      disposeSqliteStorageValueEncryption(previous);
      previous.close();
    }

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_PROTECTED_STORAGE_KEY_FILE", keyPath);
    try {
      const opened = openOpenClawStateDatabase({ env: process.env, path: pathname });
      expect(isSqliteStorageValueEncryptionStrict(opened.db)).toBe(true);
      const evidenceTable = () =>
        opened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'protected_report_chat_evidence'")
          .get();
      expect(evidenceTable()).toBeUndefined();
      ensureProtectedFeedbackSchema(opened);
      expect(evidenceTable()).toEqual({ name: "protected_report_chat_evidence" });
      expect(opened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      vi.unstubAllEnvs();
    }
  });
});

it("keeps committed plaintext until readback succeeds and publishes the protected version atomically", async () => {
  await withTempDir("protected-shared-migration-", async (directory) => {
    const stateDir = path.join(directory, "state");
    const databaseDir = path.join(stateDir, "state");
    mkdirSync(databaseDir, { recursive: true });
    const pathname = path.join(databaseDir, "openclaw.sqlite");
    const db = new DatabaseSync(pathname);
    const encryption = createStorageValueEncryption(Buffer.alloc(32, 7));
    let failReadback = true;
    registerSqliteStorageValueEncryption(db, {
      ...encryption,
      decryptText(value, context) {
        if (failReadback) {
          throw new Error("injected readback failure");
        }
        return encryption.decryptText(value, context);
      },
    });

    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        PRAGMA user_version = 20;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 20, 1, 1);
        INSERT INTO secret_store_entries
          (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms)
          VALUES ('identity', 'member', 'model-account:example', 'private credential', 'secret', 1, 1);
      `);
      const readCommitted = () => {
        const reader = new DatabaseSync(pathname, { readOnly: true });
        try {
          return {
            version: reader.prepare("PRAGMA user_version").get()?.user_version,
            value: reader.prepare("SELECT value FROM secret_store_entries").get()?.value,
          };
        } finally {
          reader.close();
        }
      };
      db.prepare(`
        INSERT INTO update_runs (
          run_id, created_at_ms, updated_at_ms, trigger, phase, status,
          origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json
        ) VALUES ('older', ?, ?, 'cli', 'staging', 'running',
          '{}', '{}', '{"version":"2026.9.2"}', '{}', '[]', '{}', '{}')
      `).run(Date.now(), Date.now());
      db.exec("BEGIN IMMEDIATE");
      expect(() => migrateProtectedSharedStateInTransaction(db)).toThrow(/older updater/);
      db.exec("COMMIT");
      expect(readCommitted()).toEqual({ version: 20, value: "private credential" });
      db.prepare("DELETE FROM update_runs WHERE run_id = 'older'").run();

      db.exec(`
        CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL, entry_json TEXT NOT NULL
        );
        INSERT INTO cron_run_logs VALUES ('store', 'job', 1, 100, '{');
        BEGIN IMMEDIATE;
      `);
      expect(() => migrateProtectedSharedStateInTransaction(db)).toThrow(/malformed legacy Cron/);
      db.exec("COMMIT");
      expect(db.prepare("SELECT entry_json FROM cron_run_logs").get()).toEqual({ entry_json: "{" });
      expect(readCommitted()).toEqual({ version: 20, value: "private credential" });
      db.exec("DROP TABLE cron_run_logs");

      db.exec("BEGIN IMMEDIATE");
      expect(() => migrateProtectedSharedStateInTransaction(db)).toThrow(
        "injected readback failure",
      );
      db.exec("COMMIT");
      expect(readCommitted()).toEqual({ version: 20, value: "private credential" });

      failReadback = false;
      db.exec("BEGIN IMMEDIATE");
      migrateProtectedSharedStateInTransaction(db);
      expect(readCommitted()).toEqual({ version: 20, value: "private credential" });
      db.exec("ROLLBACK");
      expect(readCommitted()).toEqual({ version: 20, value: "private credential" });

      const blockingReader = new DatabaseSync(pathname, { readOnly: true });
      try {
        blockingReader.exec("BEGIN");
        blockingReader.prepare("SELECT value FROM secret_store_entries").get();
        db.exec("BEGIN IMMEDIATE");
        migrateProtectedSharedStateInTransaction(db);
        db.exec("COMMIT");
        expect(readCommitted()).toEqual({ version: 21, value: expect.stringMatching(/^OCSEAL1:/) });
        expect(readProtectedSharedStateMarker(db)).toEqual({ cleanupPending: true });
        expect(() => assertSupportedStateSchemaVersion(db, pathname)).toThrow(/cleanup is pending/);
        expect(() => cleanupProtectedSharedStateAfterMigration(db, () => {})).toThrow(/checkpoint/);
        expect(readProtectedSharedStateMarker(db)).toEqual({ cleanupPending: true });
      } finally {
        blockingReader.exec("ROLLBACK");
        blockingReader.close();
      }
      cleanupProtectedSharedStateAfterMigration(db, () => {});
      expect(readProtectedSharedStateMarker(db)).toEqual({ cleanupPending: false });
      expect(assertSupportedStateSchemaVersion(db, pathname)).toBe(21);
      expect(isSqliteStorageValueEncryptionStrict(db)).toBe(true);
      assertCurrentStateRuntimeSchema(db, pathname);
      expect(readFileSync(pathname).includes(Buffer.from("private credential"))).toBe(false);
    } finally {
      disposeSqliteStorageValueEncryption(db);
      db.close();
    }

    for (const key of [undefined, Buffer.alloc(32, 9)]) {
      const reader = new DatabaseSync(pathname, { readOnly: true });
      registerSqliteStorageValueEncryption(reader, key && createStorageValueEncryption(key));
      try {
        expect(() => assertSupportedStateSchemaVersion(reader, pathname)).toThrow();
        expect(isSqliteStorageValueEncryptionStrict(reader)).toBe(false);
      } finally {
        disposeSqliteStorageValueEncryption(reader);
        reader.close();
      }
    }
    const keyPath = path.join(directory, "storage-key");
    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const originalKeyPath = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
    try {
      expect(repairStateSchema(pathname, process.env, "doctor").warnings).toEqual([]);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "--input-type=module",
          "--eval",
          [
            'import { listProtectedUsage } from "./grogu/protected/usage-store.ts";',
            'console.log(JSON.stringify(await listProtectedUsage(process.env.OPENCLAW_STATE_DIR, "synthetic-member", 0)));',
          ].join("\n"),
        ],
        { cwd: process.cwd(), env: process.env, encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual([]);
      const reader = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
        expect(reader.prepare("SELECT value FROM secret_store_entries").get()?.value).toMatch(
          /^OCSEAL1:/,
        );
      } finally {
        reader.close();
      }
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      if (originalKeyPath === undefined) {
        delete process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
      } else {
        process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = originalKeyPath;
      }
    }
    const tampered = new DatabaseSync(pathname);
    registerSqliteStorageValueEncryption(
      tampered,
      createStorageValueEncryption(Buffer.alloc(32, 7)),
    );
    try {
      tampered
        .prepare("UPDATE grogu_protected_shared_state SET key_check = ? WHERE id = 1")
        .run("grogu-protected-shared-state-v21");
      expect(() => assertSupportedStateSchemaVersion(tampered, pathname)).toThrow(
        /marker is invalid/,
      );
    } finally {
      disposeSqliteStorageValueEncryption(tampered);
      tampered.close();
    }
  });
});

it("migrates and resumes cleanup on a pre-pacing v21 database through the protected startup worker", async () => {
  await withTempDir("protected-shared-startup-", async (directory) => {
    const stateDir = path.join(directory, "service");
    const databaseDir = path.join(stateDir, "state");
    mkdirSync(databaseDir, { recursive: true });
    const pathname = path.join(databaseDir, "openclaw.sqlite");
    const keyPath = path.join(directory, "key");
    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    const database = new DatabaseSync(pathname);
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 20;
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', 20, 1, 1);
      INSERT INTO secret_store_entries
        (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms)
        VALUES ('identity', 'member', 'model-account:example', 'synthetic secret', 'secret', 1, 1);
      CREATE TABLE user_profiles (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO user_profiles VALUES ('member');
      INSERT INTO protected_automations
        (id, creator_profile_id, central_owner_profile_id, provider, definition_json,
         definition_revision, visibility, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-000000000001', 'member', 'member', 'sparky',
          '{"name":"Fixture","instructions":"Check the fixture.","whenToNotify":"Only on change.",
            "agentId":"research","model":{"provider":"sparky","id":"00000000-0000-4000-8000-000000000002"},
            "schedule":{"kind":"every","everyMs":60000}}', 1, 'private', 123, 123);
      INSERT INTO protected_automation_run_chats
        (automation_id, profile_id, chat_id, last_scheduled_at_ms, charged_bytes)
        VALUES ('00000000-0000-4000-8000-000000000001', 'member', 'chat', 42, 512);
    `);
    database.close();
    const runStartup = (key = keyPath) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "--input-type=module",
          "--eval",
          [
            'import { prepareProtectedSharedState } from "./grogu/protected/state-worker-context.ts";',
            'import { listProtectedUsage } from "./grogu/protected/usage-store.ts";',
            "await prepareProtectedSharedState(process.env.OPENCLAW_STATE_DIR, () => {});",
            'console.log(JSON.stringify(await listProtectedUsage(process.env.OPENCLAW_STATE_DIR, "synthetic", 0)));',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_PROTECTED_STORAGE_KEY_FILE: key,
          },
          encoding: "utf8",
        },
      );
    const first = runStartup();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual([]);
    const migrated = new DatabaseSync(pathname);
    let oldDefinition;
    let oldChat;
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
      expect(migrated.prepare("SELECT value FROM secret_store_entries").get()?.value).toMatch(
        /^OCSEAL1:/,
      );
      migrated.exec(`
        ALTER TABLE protected_automations DROP COLUMN pacing_min_ms;
        ALTER TABLE protected_automations DROP COLUMN pacing_max_ms;
        ALTER TABLE protected_automation_run_chats DROP COLUMN pacing_revision;
        ALTER TABLE protected_automation_run_chats DROP COLUMN pacing_next_at_ms;
        ALTER TABLE protected_automation_run_chats DROP COLUMN pacing_reason;
        ALTER TABLE protected_automation_run_chats DROP COLUMN pacing_failures;
        UPDATE grogu_protected_shared_state SET cleanup_pending = 1;
      `);
      oldDefinition = migrated.prepare("SELECT * FROM protected_automations").get();
      oldChat = migrated.prepare("SELECT * FROM protected_automation_run_chats").get();
    } finally {
      migrated.close();
    }
    const wrongKey = path.join(directory, "wrong-key");
    writeFileSync(wrongKey, Buffer.alloc(32, 9), { mode: 0o600 });
    const refused = runStartup(wrongKey);
    expect(refused.status).not.toBe(0);
    const resumed = runStartup();
    expect(resumed.status, resumed.stderr).toBe(0);
    const reader = new DatabaseSync(pathname, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT cleanup_pending FROM grogu_protected_shared_state").get(),
      ).toEqual({ cleanup_pending: 0 });
      expect(reader.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
      expect(reader.prepare("SELECT * FROM protected_automations").get()).toEqual({
        ...oldDefinition,
        pacing_min_ms: null,
        pacing_max_ms: null,
      });
      expect(reader.prepare("SELECT * FROM protected_automation_run_chats").get()).toEqual({
        ...oldChat,
        pacing_revision: null,
        pacing_next_at_ms: null,
        pacing_reason: null,
        pacing_failures: null,
      });
    } finally {
      reader.close();
    }
    expect(readFileSync(pathname).includes(Buffer.from("synthetic secret"))).toBe(false);
  });
});
