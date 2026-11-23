import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStorageText,
} from "../storage/sqlite-encryption.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureProtectedFeedbackSchema,
  protectedFeedbackRetentionMs,
  toRun,
  type FeedbackDatabase,
  type ProtectedFeedbackCategory,
  type ProtectedFeedbackRating,
  type ProtectedFeedbackStatus,
  type ProtectedFeedbackValue,
  type ProtectedProducedFile,
  type ProtectedReportRecord,
  type ProtectedStoredDataEntry,
} from "./protected-feedback.js";

type StoredReport = FeedbackDatabase["protected_feedback_reports"];
type Db = ReturnType<typeof getNodeSqliteKysely<FeedbackDatabase>>;

export function protectedFeedbackRows(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    chatId: string;
  },
): ProtectedFeedbackValue[] {
  ensureProtectedFeedbackSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<FeedbackDatabase>(database.db)
      .selectFrom("protected_response_feedback")
      .select(["response_id", "rating", "report_id"])
      .where("profile_id", "=", input.profileId)
      .where("chat_id", "=", input.chatId)
      .orderBy("updated_at", "asc"),
  ).rows;
  return rows.map((row) => ({
    responseId: row.response_id,
    rating: row.rating,
    reportId: row.report_id,
  }));
}

export function setProtectedResponseRating(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    chatId: string;
    responseId: string;
    rating: ProtectedFeedbackRating | null;
    now: number;
    storageOverheadBytes: number;
  },
): { feedback: ProtectedFeedbackValue; created: boolean; entry?: ProtectedStoredDataEntry } {
  ensureProtectedFeedbackSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
      const prior = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_response_feedback")
          .select(["report_id"])
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId)
          .where("response_id", "=", input.responseId),
      ).rows[0];
      if (!input.rating && !prior?.report_id) {
        executeSqliteQuerySync(
          db,
          queries
            .deleteFrom("protected_response_feedback")
            .where("profile_id", "=", input.profileId)
            .where("chat_id", "=", input.chatId)
            .where("response_id", "=", input.responseId),
        );
        return {
          feedback: { responseId: input.responseId, rating: null, reportId: null },
          created: false,
        };
      }
      executeSqliteQuerySync(
        db,
        queries
          .insertInto("protected_response_feedback")
          .values({
            profile_id: input.profileId,
            chat_id: input.chatId,
            response_id: input.responseId,
            rating: input.rating,
            report_id: prior?.report_id ?? null,
            updated_at: input.now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["profile_id", "chat_id", "response_id"])
              .doUpdateSet({ rating: input.rating, updated_at: input.now }),
          ),
      );
      return {
        feedback: {
          responseId: input.responseId,
          rating: input.rating,
          reportId: prior?.report_id ?? null,
        },
        created: !prior,
        ...(!prior
          ? {
              entry: {
                id: `feedback:${input.chatId}:${input.responseId}`,
                profileId: input.profileId,
                bytes:
                  input.storageOverheadBytes +
                  Buffer.byteLength(input.profileId, "utf8") +
                  Buffer.byteLength(input.chatId, "utf8") +
                  Buffer.byteLength(input.responseId, "utf8") +
                  64,
              },
            }
          : {}),
      };
    },
    { path: database.path },
    { operationLabel: "protected.feedback.rating.set" },
  );
}

function reportDescriptionContext(id: string) {
  return protectedStorageValueContext("protected_feedback_reports", "description", [id]);
}

function openReportDescription(db: DatabaseSync, row: Pick<StoredReport, "id" | "description">) {
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected report descriptions require the protected storage key.");
  }
  return openSqliteStorageText(db, row.description, reportDescriptionContext(row.id));
}

function parseProducedFiles(value: string): ProtectedProducedFile[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        !Array.isArray(file) &&
        typeof file.id === "string" &&
        typeof file.name === "string" &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.origin === "produced",
    )
  ) {
    throw new Error("Protected turn file references are invalid.");
  }
  return parsed as ProtectedProducedFile[];
}

export function findProtectedFeedbackSubmission(
  database: OpenClawStateDatabase,
  input: { profileId: string; submissionId: string },
):
  | {
      id: string;
      chatId: string;
      responseId: string;
      status: ProtectedFeedbackStatus;
      createdAt: number;
    }
  | undefined {
  ensureProtectedFeedbackSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<FeedbackDatabase>(database.db)
      .selectFrom("protected_feedback_reports")
      .select(["id", "chat_id", "response_id", "status", "created_at"])
      .where("profile_id", "=", input.profileId)
      .where("submission_id", "=", input.submissionId),
  ).rows[0];
  return row
    ? {
        id: row.id,
        chatId: row.chat_id,
        responseId: row.response_id,
        status: row.status,
        createdAt: row.created_at,
      }
    : undefined;
}

export function findProtectedFeedbackForResponse(
  database: OpenClawStateDatabase,
  input: { profileId: string; chatId: string; responseId: string },
): string | undefined {
  ensureProtectedFeedbackSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<FeedbackDatabase>(database.db)
      .selectFrom("protected_feedback_reports")
      .select("id")
      .where("profile_id", "=", input.profileId)
      .where("chat_id", "=", input.chatId)
      .where("response_id", "=", input.responseId),
  ).rows[0];
  return row?.id;
}

export function submitProtectedFeedbackReport(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    memberLabel: string;
    chatId: string;
    responseId: string;
    submissionId: string;
    category: ProtectedFeedbackCategory;
    description: string;
    now: number;
    storageOverheadBytes: number;
  },
):
  | {
      kind: "created" | "replayed";
      report: { id: string; status: "open"; createdAt: number };
      feedback: ProtectedFeedbackValue;
      entries: ProtectedStoredDataEntry[];
    }
  | { kind: "already_reported" | "submission_conflict" } {
  ensureProtectedFeedbackSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
      const bySubmission = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_feedback_reports")
          .select(["id", "chat_id", "response_id", "created_at"])
          .where("profile_id", "=", input.profileId)
          .where("submission_id", "=", input.submissionId),
      ).rows[0];
      if (bySubmission) {
        if (
          bySubmission.chat_id !== input.chatId ||
          bySubmission.response_id !== input.responseId
        ) {
          return { kind: "submission_conflict" as const };
        }
        return {
          kind: "replayed" as const,
          report: {
            id: bySubmission.id,
            status: "open" as const,
            createdAt: bySubmission.created_at,
          },
          feedback: {
            responseId: input.responseId,
            rating: "down" as const,
            reportId: bySubmission.id,
          },
          entries: [],
        };
      }
      const byResponse = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_feedback_reports")
          .select("id")
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId)
          .where("response_id", "=", input.responseId),
      ).rows[0];
      if (byResponse) {
        return { kind: "already_reported" as const };
      }
      if (!hasSqliteStorageValueEncryption(db)) {
        throw new Error("Protected report descriptions require the protected storage key.");
      }
      const reportId = randomUUID();
      const context = reportDescriptionContext(reportId);
      const storedDescription = sealSqliteStorageText(db, input.description, context);
      const run = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_feedback_runs")
          .select(["id", "provider", "model", "agent_id"])
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId)
          .where("response_id", "=", input.responseId)
          .orderBy("created_at", "desc")
          .limit(1),
      ).rows[0];
      executeSqliteQuerySync(
        db,
        queries.insertInto("protected_feedback_reports").values({
          id: reportId,
          submission_id: input.submissionId,
          profile_id: input.profileId,
          chat_id: input.chatId,
          response_id: input.responseId,
          run_id: run?.id ?? null,
          provider: run?.provider ?? null,
          model: run?.model ?? null,
          agent_id: run?.agent_id ?? null,
          category: input.category,
          description: storedDescription,
          status: "open",
          evidence_state: "available",
          created_at: input.now,
          reviewed_at: null,
        }),
      );
      const priorFeedback = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_response_feedback")
          .select("response_id")
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId)
          .where("response_id", "=", input.responseId),
      ).rows[0];
      executeSqliteQuerySync(
        db,
        queries
          .insertInto("protected_response_feedback")
          .values({
            profile_id: input.profileId,
            chat_id: input.chatId,
            response_id: input.responseId,
            rating: "down",
            report_id: reportId,
            updated_at: input.now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["profile_id", "chat_id", "response_id"])
              .doUpdateSet({ rating: "down", report_id: reportId, updated_at: input.now }),
          ),
      );
      return {
        kind: "created" as const,
        report: { id: reportId, status: "open" as const, createdAt: input.now },
        feedback: { responseId: input.responseId, rating: "down" as const, reportId },
        entries: [
          {
            id: `report:${reportId}`,
            profileId: input.profileId,
            bytes:
              input.storageOverheadBytes +
              Buffer.byteLength(storedDescription, "utf8") +
              Buffer.byteLength(input.category, "utf8") +
              160,
          },
          ...(!priorFeedback
            ? [
                {
                  id: `feedback:${input.chatId}:${input.responseId}`,
                  profileId: input.profileId,
                  bytes:
                    input.storageOverheadBytes +
                    Buffer.byteLength(input.profileId, "utf8") +
                    Buffer.byteLength(input.chatId, "utf8") +
                    Buffer.byteLength(input.responseId, "utf8") +
                    64,
                },
              ]
            : []),
        ],
      };
    },
    { path: database.path },
    { operationLabel: "protected.feedback.report.submit" },
  );
}

function reportRecord(
  db: DatabaseSync,
  row: StoredReport & {
    display_name: string | null;
  },
): ProtectedReportRecord {
  const run = row.run_id
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<FeedbackDatabase>(db)
          .selectFrom("protected_feedback_runs")
          .selectAll()
          .where("id", "=", row.run_id),
      ).rows[0]
    : undefined;
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    excerpt: "",
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    member: {
      personId: row.profile_id,
      displayName:
        row.evidence_state === "member_removed"
          ? "Removed member"
          : (row.display_name ?? "Removed member"),
    },
    provider: row.provider,
    model: row.model,
    agentId: row.agent_id,
    evidence: row.evidence_state,
    description: openReportDescription(db, row),
    chatId: row.chat_id,
    responseId: row.response_id,
    runId: row.run_id,
    metrics: run ? toRun(run) : null,
    files: row.evidence_state === "available" && run ? parseProducedFiles(run.files_json) : [],
  };
}

const reportSelect = (queries: Db) =>
  queries
    .selectFrom("protected_feedback_reports as r")
    .leftJoin("user_profiles as p", "p.id", "r.profile_id")
    .select([
      "r.id",
      "r.submission_id",
      "r.profile_id",
      "r.chat_id",
      "r.response_id",
      "r.run_id",
      "r.provider",
      "r.model",
      "r.agent_id",
      "r.category",
      "r.description",
      "r.status",
      "r.evidence_state",
      "r.created_at",
      "r.reviewed_at",
      "p.display_name",
    ]);

export function listProtectedFeedbackReports(
  database: OpenClawStateDatabase,
  input: { status: "open" | "all" },
): { reports: ProtectedReportRecord[]; openCount: number } {
  ensureProtectedFeedbackSchema(database);
  const queries = getNodeSqliteKysely<FeedbackDatabase>(database.db);
  const openCount = executeSqliteQuerySync(
    database.db,
    queries
      .selectFrom("protected_feedback_reports")
      .select(sql<number>`count(*)`.as("count"))
      .where("status", "=", "open"),
  ).rows[0]?.count;
  let list = reportSelect(queries).orderBy("r.created_at", "desc").orderBy("r.id", "desc");
  if (input.status === "open") {
    list = list.where("r.status", "=", "open");
  }
  const rows = executeSqliteQuerySync(database.db, list).rows;
  return {
    reports: rows.map((row) =>
      reportRecord(database.db, { ...row, display_name: row.display_name }),
    ),
    openCount: openCount ?? 0,
  };
}

export function readProtectedFeedbackReport(
  database: OpenClawStateDatabase,
  id: string,
): ProtectedReportRecord | undefined {
  ensureProtectedFeedbackSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    reportSelect(getNodeSqliteKysely<FeedbackDatabase>(database.db)).where("r.id", "=", id),
  ).rows[0];
  return row ? reportRecord(database.db, { ...row, display_name: row.display_name }) : undefined;
}

export function setProtectedFeedbackReportStatus(
  database: OpenClawStateDatabase,
  input: { id: string; status: ProtectedFeedbackStatus; now: number },
): ProtectedReportRecord | undefined {
  ensureProtectedFeedbackSchema(database);
  const updated = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
      const row = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_feedback_reports")
          .select(["id", "status"])
          .where("id", "=", input.id),
      ).rows[0];
      if (!row) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_feedback_reports")
          .set({
            status: input.status,
            reviewed_at: input.status === "reviewed" ? input.now : null,
          })
          .where("id", "=", input.id),
      );
      return true;
    },
    { path: database.path },
    { operationLabel: "protected.feedback.report.status" },
  );
  return updated ? readProtectedFeedbackReport(database, input.id) : undefined;
}

export function removeProtectedChatFeedbackEvidence(
  database: OpenClawStateDatabase,
  input: { profileId: string; chatId: string },
): void {
  if (!tableExists(database.db, "protected_feedback_runs")) {
    return;
  }
  ensureProtectedFeedbackSchema(database);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
      executeSqliteQuerySync(
        db,
        queries
          .deleteFrom("protected_response_feedback")
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId),
      );
      executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_feedback_reports")
          .set({ evidence_state: "deleted" })
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId)
          .where("evidence_state", "=", "available"),
      );
      executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_feedback_runs")
          .set({ chat_id: null, response_id: null, files_json: "[]" })
          .where("profile_id", "=", input.profileId)
          .where("chat_id", "=", input.chatId),
      );
    },
    { path: database.path },
    { operationLabel: "protected.feedback.chat.deleted" },
  );
}

export function removeProtectedMemberFeedbackRows(db: DatabaseSync, profileId: string): void {
  if (!tableExists(db, "protected_feedback_runs")) {
    return;
  }
  const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
  executeSqliteQuerySync(
    db,
    queries.deleteFrom("protected_response_feedback").where("profile_id", "=", profileId),
  );
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("protected_feedback_reports")
      .set({ evidence_state: "member_removed" })
      .where("profile_id", "=", profileId),
  );
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("protected_feedback_runs")
      .set({
        chat_id: null,
        response_id: null,
        files_json: "[]",
        member_label: "Removed member",
      })
      .where("profile_id", "=", profileId),
  );
}

export function pruneProtectedFeedback(database: OpenClawStateDatabase, now: number): void {
  if (!tableExists(database.db, "protected_feedback_runs")) {
    return;
  }
  ensureProtectedFeedbackSchema(database);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
      const cutoff = now - protectedFeedbackRetentionMs;
      executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_response_feedback")
          .set({ report_id: null })
          .where(
            "report_id",
            "in",
            queries
              .selectFrom("protected_feedback_reports")
              .select("id")
              .where("created_at", "<", cutoff),
          ),
      );
      executeSqliteQuerySync(
        db,
        queries.deleteFrom("protected_feedback_reports").where("created_at", "<", cutoff),
      );
      executeSqliteQuerySync(
        db,
        queries.deleteFrom("protected_feedback_runs").where("created_at", "<", cutoff),
      );
    },
    { path: database.path },
    { operationLabel: "protected.feedback.prune" },
  );
}
