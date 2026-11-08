import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

const schemaVersion = 1;

export function openSpacesDatabase(databasePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = openNodeSqliteDatabase(databasePath);
  try {
    // Version admission precedes WAL configuration and any schema writes.
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 0 && version !== schemaVersion) {
      throw new Error(
        `Spaces schema ${version} is unsupported. Restore a compatible backup or update the Spaces plugin.`,
      );
    }
    if (
      version === 0 &&
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .get()
    ) {
      throw new Error("Spaces cannot adopt an unversioned database with existing tables.");
    }
    configureSqliteConnectionPragmas(db, { busyTimeoutMs: 5000 });
    if (version === 0) {
      runSqliteImmediateTransactionSync(db, () => {
        db.exec(`
          CREATE TABLE spaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
            rules TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('todo','shopping','read-later','vacation')),
            revision INTEGER NOT NULL CHECK(revision > 0),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
          ) STRICT;
          CREATE TABLE items (
            id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL,
            quantity REAL, unit TEXT NOT NULL, category TEXT NOT NULL, due_date TEXT,
            url TEXT, source_date TEXT, estimate REAL, currency TEXT,
            parent_id TEXT REFERENCES items(id), revision INTEGER NOT NULL CHECK(revision > 0),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
          ) STRICT;
          CREATE INDEX items_space ON items(space_id, deleted_at, created_at, id);
          CREATE INDEX items_parent ON items(parent_id);
          CREATE TABLE history (
            id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, space_id TEXT NOT NULL,
            item_id TEXT, action TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL,
            before_json TEXT, after_json TEXT
          ) STRICT;
          CREATE INDEX history_space ON history(space_id, at DESC, id);
          CREATE TABLE operations (
            id TEXT PRIMARY KEY, digest TEXT NOT NULL, actor TEXT NOT NULL,
            at INTEGER NOT NULL, result_json TEXT
          ) STRICT;
          CREATE INDEX operations_age ON operations(at);
          CREATE TABLE retired_records (id TEXT PRIMARY KEY) STRICT;
          PRAGMA user_version = ${schemaVersion};
        `);
      });
    }
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new Error(
        "Spaces failed its SQLite integrity check. Keep the database and restore a verified backup.",
      );
    }
    if (db.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("Spaces contains invalid item relationships. Restore a verified backup.");
    }
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const indexes = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all()
        .map((row) => row.name),
    );
    if (
      !["spaces", "items", "history", "operations", "retired_records"].every((name) =>
        tables.has(name),
      ) ||
      !["items_space", "items_parent", "history_space", "operations_age"].every((name) =>
        indexes.has(name),
      )
    ) {
      throw new Error("Spaces schema is incomplete. Restore a verified backup.");
    }
    fs.chmodSync(databasePath, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
