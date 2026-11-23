import { isMainThread } from "node:worker_threads";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  ensureMemoryIndexSchema,
  MEMORY_INDEX_FTS_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type {
  EphemeralMemoryIdentity,
  EphemeralMemoryResult,
  EphemeralMemoryTask,
} from "./manager-ephemeral-task.js";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";
import { searchKeyword } from "./manager-search.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";
import { isCuratedMemoryRoot } from "./memory-path-classification.js";

let database: ReturnType<typeof openNodeSqliteDatabase> | undefined;
let owner: EphemeralMemoryIdentity | undefined;
let ready = false;

function assertIdentity(identity: EphemeralMemoryIdentity) {
  if (
    !owner ||
    owner.memberKey !== identity.memberKey ||
    owner.workspaceGeneration !== identity.workspaceGeneration ||
    owner.incarnation !== identity.incarnation ||
    !database?.isOpen
  ) {
    throw new Error("Member memory index is unavailable or belongs to another workspace.");
  }
}

serveWorkerTasks<EphemeralMemoryResult>(async (input, channel) => {
  // The paired manager owns this private task protocol.
  const task = input as EphemeralMemoryTask;
  if (task.kind === "open") {
    if (isMainThread || database || owner) {
      throw new Error("Member memory index already has an owner.");
    }
    const db = openNodeSqliteDatabase(":memory:");
    try {
      db.exec("PRAGMA temp_store = MEMORY; PRAGMA journal_mode = MEMORY; PRAGMA foreign_keys = ON");
      db.exec("PRAGMA max_page_count = 8192");
      if (db.location() !== null) {
        throw new Error("Member memory index requires memory-only SQLite storage.");
      }
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(`Member memory keyword search is unavailable: ${schema.ftsError}`);
      }
      database = db;
      owner = task.identity;
      return { kind: "open" };
    } catch (error) {
      db.close();
      throw error;
    }
  }
  assertIdentity(task.identity);
  const db = database!;
  if (task.kind === "rebuild") {
    ready = false;
    if (!channel) {
      throw new Error("Member memory index has no authority channel.");
    }
    const permission = await channel.request({ kind: "publish", identity: task.identity });
    const authorized = permission.input === true;
    permission.consumed();
    if (!authorized) {
      throw new Error("Member memory publication was not authorized.");
    }
    runSqliteImmediateTransactionSync(db, () => {
      db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
      const kernel = new MemorySourceIndexKernel(db, {
        vector: { enabled: false, available: false },
        fts: { enabled: true, available: true },
      });
      for (const file of task.files) {
        const prepared = prepareMemoryIndexChunks({
          entry: { path: file.path, mtimeMs: file.mtimeMs },
          source: "memory",
          content: file.content,
          pathClassification: {
            curatedRoot: isCuratedMemoryRoot(file.path),
            originClass: file.originClass,
          },
          chunking: task.chunking,
          hardMaxInputTokens: 0,
        });
        kernel.replaceRows(
          {
            entry: {
              path: file.path,
              hash: prepared.contentHash ?? hashText(file.content),
              mtimeMs: file.mtimeMs,
              size: Buffer.byteLength(file.content),
            },
            source: "memory",
            model: "fts-only",
            now: Date.now(),
            vectorReady: false,
          },
          prepared.chunks.map((chunk) => ({ chunk, embedding: [] })),
        );
      }
    });
    ready = true;
    return { kind: "rebuild" };
  }
  if (task.kind === "search") {
    if (!ready) {
      throw new Error("Member memory index requires a successful rebuild.");
    }
    const rows = await searchKeyword({
      db,
      ftsTable: MEMORY_INDEX_FTS_TABLE,
      query: task.query,
      limit: task.limit,
      snippetMaxChars: 700,
      sourceFilter: { sql: "", params: [] },
      boostFallbackRanking: true,
    });
    return { kind: "search", rows };
  }
  throw new Error("Invalid member memory index operation.");
});
