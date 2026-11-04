import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import {
  modelRequestMetadataSnapshot,
  type ModelRequestRecord,
} from "./model-request-telemetry-metadata.js";

type TelemetryDatabase = {
  requests: {
    id: string;
    kind: string;
    started_at: number;
    updated_at: number;
    terminal: number;
    data: string;
  };
};

/** Database handles are owned only by the telemetry worker, never by the Gateway isolate. */
export function createRequestTelemetryStore(
  directory: string,
  options: { maxRows?: number; retentionMs?: number } = {},
) {
  if (isMainThread) {
    throw new Error("Model request telemetry SQLite must run in a worker");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (process.getuid && dir.uid !== process.getuid())
  ) {
    throw new Error("Unsafe telemetry directory");
  }
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "requests.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = fs.lstatSync(file + suffix);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error("Unsafe telemetry file");
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA busy_timeout=50;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA wal_autocheckpoint=128;
    PRAGMA journal_size_limit=1048576;
    PRAGMA max_page_count=32768;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, terminal INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(length(data)<=16384)
    );
    CREATE INDEX IF NOT EXISTS requests_started ON requests(started_at);
  `);
  const db = getNodeSqliteKysely<TelemetryDatabase>(database);
  const { maxRows = 6_000, retentionMs = 7 * 86_400_000 } = options;
  return {
    writeBatch(records: ModelRequestRecord[]) {
      const snapshots = records.map(modelRequestMetadataSnapshot);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const record of snapshots) {
          const data = JSON.stringify(record);
          if (Buffer.byteLength(data) > 16_384) {
            throw new Error("Telemetry record exceeds metadata bound");
          }
          executeSqliteQuerySync(
            database,
            db
              .insertInto("requests")
              .values({
                id: record.id,
                kind: record.kind,
                started_at: record.startedAtMs,
                updated_at: record.updatedAtMs,
                terminal: Number(record.terminal),
                data,
              })
              .onConflict((conflict) =>
                conflict.column("id").doUpdateSet({
                  updated_at: record.updatedAtMs,
                  terminal: Number(record.terminal),
                  data,
                }),
              ),
          );
        }
        if (snapshots.length) {
          executeSqliteQuerySync(
            database,
            db.deleteFrom("requests").where("updated_at", "<", Date.now() - retentionMs),
          );
          executeSqliteQuerySync(
            database,
            db
              .deleteFrom("requests")
              .where(
                "id",
                "in",
                db
                  .selectFrom("requests")
                  .select("id")
                  .orderBy("updated_at", "desc")
                  .limit(2_147_483_647)
                  .offset(maxRows),
              ),
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    read(since = 0, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6_000) {
        throw new Error("Invalid telemetry read limit");
      }
      return executeSqliteQuerySync(
        database,
        db
          .selectFrom("requests")
          .select("data")
          .where("started_at", ">=", since)
          .orderBy("started_at", "desc")
          .limit(limit),
      ).rows.map((row) => modelRequestMetadataSnapshot(JSON.parse(row.data)));
    },
    close() {
      database.close();
    },
  };
}

const stores = new Map<string, ReturnType<typeof createRequestTelemetryStore>>();
if (!isMainThread) {
  serveOwnedWorkerTasks(
    (input) => {
      if (
        !isRecord(input) ||
        typeof input.directory !== "string" ||
        !path.isAbsolute(input.directory)
      ) {
        throw new Error("Invalid telemetry worker request");
      }
      const directory = input.directory;
      if (input.action === "close") {
        stores.get(directory)?.close();
        stores.delete(directory);
        return [];
      }
      let store = stores.get(directory);
      if (!store) {
        store = createRequestTelemetryStore(directory);
        stores.set(directory, store);
      }
      if (input.action === "write" && Array.isArray(input.records) && input.records.length <= 64) {
        // SAFETY: The owned worker transport accepts this message only from the typed parent writer.
        store.writeBatch(input.records as ModelRequestRecord[]);
        return [];
      }
      if (
        input.action === "read" &&
        typeof input.since === "number" &&
        typeof input.limit === "number"
      ) {
        return store.read(input.since, input.limit);
      }
      throw new Error("Invalid telemetry worker operation");
    },
    {
      closeResource: () => {
        for (const store of stores.values()) {
          store.close();
        }
        stores.clear();
      },
    },
  );
}
