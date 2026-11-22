import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  hashSessionArchiveBytes,
  MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES,
  resolveSqliteTranscriptArchivePath,
} from "./session-accessor.sqlite-archive-artifact.js";
import type { TranscriptArchiveWorkerResult } from "./session-accessor.sqlite-archive-types.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type TranscriptArchiveDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_archives" | "transcript_events"
>;

export function createArchiveByteLimitTransform(): Transform {
  let encodedBytes = 0;
  return new Transform({
    transform(chunk: unknown, encoding, callback) {
      let chunkBytes: number;
      if (typeof chunk === "string") {
        chunkBytes = Buffer.byteLength(chunk, encoding);
      } else if (chunk instanceof Uint8Array) {
        chunkBytes = chunk.byteLength;
      } else {
        callback(new TypeError("Archive encoder emitted an unsupported chunk type"));
        return;
      }
      encodedBytes += chunkBytes;
      if (encodedBytes > MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES) {
        callback(
          new Error(
            `Archive exceeds ${MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES} bytes during encoding`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function createProtectedTranscriptArchiveStream(database: DatabaseSync, sessionId: string) {
  let rowCount = 0;
  const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database);
  const source = Readable.from(
    (function* () {
      for (const row of iterateSqliteQuerySync(
        database,
        db
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(database).as("event_json"))
          .where("session_id", "=", sessionId)
          .orderBy("seq", "asc"),
      )) {
        if (typeof row.event_json !== "string") {
          throw new Error(`Invalid transcript event row for ${sessionId}`);
        }
        rowCount += 1;
        yield `${row.event_json}\n`;
      }
    })(),
  );
  return { rowCount: () => rowCount, source };
}

export async function encodeProtectedTranscriptArchive(params: {
  archiveDirectory: string;
  database: DatabaseSync;
  generation?: string;
  reason: "deleted" | "reset";
  sessionId: string;
}): Promise<{
  archive: NonNullable<TranscriptArchiveWorkerResult["archive"]> | null;
  rowCount: number;
}> {
  const createdAt = Date.now();
  const optionalZlib: Partial<typeof zlib> = zlib;
  const createZstdCompress = optionalZlib.createZstdCompress;
  const compressed = typeof createZstdCompress === "function";
  const archivePath = resolveSqliteTranscriptArchivePath({
    archiveDirectory: params.archiveDirectory,
    generation: params.generation,
    identityOwner: "registry",
    reason: params.reason,
    sessionId: params.sessionId,
    nowMs: createdAt,
  });
  const { rowCount, source } = createProtectedTranscriptArchiveStream(
    params.database,
    params.sessionId,
  );
  const chunks: Buffer[] = [];
  let encodedBytes = 0;
  const collector = new Writable({
    write(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      chunks.push(bytes);
      encodedBytes += bytes.byteLength;
      callback();
    },
  });
  // Protected plaintext stays in bounded worker memory; a temporary file could survive a crash.
  await pipeline([
    source,
    ...(compressed ? [createZstdCompress.call(zlib)] : []),
    createArchiveByteLimitTransform(),
    collector,
  ]);
  if (rowCount() === 0) {
    return { archive: null, rowCount: 0 };
  }
  const bytes = Buffer.concat(chunks, encodedBytes);
  chunks.length = 0;
  return {
    archive: {
      archiveName: path.basename(`${archivePath}${compressed ? ".zst" : ""}`),
      bytes,
      createdAt,
      encoding: compressed ? "zstd" : "identity",
      sha256: hashSessionArchiveBytes(bytes),
    },
    rowCount: rowCount(),
  };
}
