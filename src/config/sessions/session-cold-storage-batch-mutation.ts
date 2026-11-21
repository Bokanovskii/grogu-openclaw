import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import {
  openSessionColdArchiveBytes,
  verifyPublishedSessionColdArchive,
} from "./session-cold-storage-codec.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import { readSessionAdmissionProtectionKeys } from "./session-cold-storage-selection.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { SessionColdMutationPlan } from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";
import { publishUnchangedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import { deleteSessionTranscriptFtsRowsInTransaction } from "./session-transcript-fts.js";

type SessionColdBatchPlan = Extract<SessionColdMutationPlan, { kind: "cold-batch" }>;

export function mutateSessionColdBatch(
  database: OpenClawAgentDatabase,
  plan: SessionColdBatchPlan,
  result: SessionColdMutationResult,
): void {
  const db = getNodeSqliteKysely<DB>(database.db);
  const protectionKeys = readSessionAdmissionProtectionKeys(database, [
    ...plan.prepared.map((item) => item.plan.sessionId),
    ...plan.externalizations.map((item) => item.archive.session_id),
  ]);
  if ([...protectionKeys].some((key) => !plan.protectionKeys.includes(key))) {
    throw new Error("Transcript ownership changed; cold archival was canceled");
  }
  const protectedIds = readSessionColdStorageProtection(
    database,
    plan.beforeMs,
    new Set(plan.liveSessionKeys),
  );
  const archivedIds: string[] = [];
  for (const prepared of plan.prepared) {
    const { sessionId, snapshot } = prepared.plan;
    const fresh = readSessionStateDeleteSnapshot(database.db, sessionId);
    if (
      readSessionColdTranscript(database.db, sessionId) ||
      protectedIds.has(sessionId) ||
      !sqliteSessionStateDeleteSnapshotsEqual(fresh, snapshot) ||
      fresh.transcriptUpdatedAt === null ||
      fresh.transcriptUpdatedAt >= plan.beforeMs
    ) {
      continue;
    }
    if (prepared.archive.storage === "file") {
      verifyPublishedSessionColdArchive(plan.databaseOptions.path, prepared.archive);
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_transcript_cold_archives").values(prepared.archive),
    );
    if (prepared.archive.storage === "sqlite") {
      const persisted = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_cold_archives")
          .select(["archive_blob", "archive_sha256", "archive_bytes"])
          .where("session_id", "=", sessionId),
      );
      const preparedBlob = prepared.archive.archive_blob;
      if (
        !persisted?.archive_blob ||
        !preparedBlob ||
        persisted.archive_bytes !== prepared.archive.archive_bytes ||
        persisted.archive_sha256 !== prepared.archive.archive_sha256 ||
        !Buffer.from(persisted.archive_blob).equals(Buffer.from(preparedBlob)) ||
        !openSessionColdArchiveBytes(
          database.db,
          persisted.archive_blob,
          sessionId,
          prepared.archive.generation,
        ).equals(
          openSessionColdArchiveBytes(
            database.db,
            preparedBlob,
            sessionId,
            prepared.archive.generation,
          ),
        )
      ) {
        throw new Error("Encrypted cold transcript archive failed persisted read-back.");
      }
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
    );
    archivedIds.push(sessionId);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_transcript_index_state").where("session_id", "=", sessionId),
    );
    if (fresh.sessionKey) {
      publishUnchangedSessionTranscriptAuthority(database, fresh.sessionKey);
    }
    result.archivedTranscripts++;
  }
  if (archivedIds.length > 0) {
    deleteSessionTranscriptFtsRowsInTransaction(database.db, archivedIds);
  }
  for (const { archive } of plan.externalizations) {
    const current = readSessionColdTranscript(database.db, archive.session_id);
    if (
      !current ||
      current.storage !== "sqlite" ||
      current.generation !== archive.generation ||
      current.archive_sha256 !== archive.archive_sha256 ||
      current.archive_name !== archive.archive_name
    ) {
      continue;
    }
    verifyPublishedSessionColdArchive(plan.databaseOptions.path, archive);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_transcript_cold_archives")
        .set({ storage: "file", archive_blob: null })
        .where("session_id", "=", archive.session_id),
    );
    result.externalizedTranscripts++;
  }
}
