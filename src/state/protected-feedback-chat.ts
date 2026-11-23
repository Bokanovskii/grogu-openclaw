import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  openSqliteStorageText,
  protectedStorageValueContext,
} from "../storage/sqlite-encryption.js";
import type {
  FeedbackDatabase,
  ProtectedProducedFile,
  ProtectedReportChatReference,
} from "./protected-feedback.js";

export function reportChatReferenceContext(id: string) {
  return protectedStorageValueContext("protected_report_chat_evidence", "reference", [id]);
}

export function openReportChatReference(
  db: DatabaseSync,
  id: string,
  stored: string,
): ProtectedReportChatReference {
  const value: unknown = JSON.parse(
    openSqliteStorageText(db, stored, reportChatReferenceContext(id)),
  );
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.eventCount !== "number" ||
    !Number.isSafeInteger(value.eventCount) ||
    value.eventCount < 0 ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    typeof value.capturedAt !== "number" ||
    !Number.isSafeInteger(value.capturedAt) ||
    value.capturedAt < 0 ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Protected report chat reference is invalid.");
  }
  const files: ProtectedProducedFile[] = [];
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.id !== "string" ||
      typeof file.name !== "string" ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.origin !== "produced"
    ) {
      throw new Error("Protected report artifact reference is invalid.");
    }
    files.push({ id: file.id, name: file.name, size: file.size, origin: file.origin });
  }
  return {
    title: value.title,
    eventCount: value.eventCount,
    digest: value.digest,
    capturedAt: value.capturedAt,
    files,
  };
}

export function clearReportChatReferences(
  db: DatabaseSync,
  input: { profileId: string; chatId?: string },
) {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Protected report cleanup requires an admitted database.");
  }
  if (!schema.tables.has("protected_report_chat_evidence")) {
    return;
  }
  const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
  let reports = queries
    .selectFrom("protected_feedback_reports")
    .select("id")
    .where("profile_id", "=", input.profileId);
  if (input.chatId !== undefined) {
    reports = reports.where("chat_id", "=", input.chatId);
  }
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("protected_report_chat_evidence")
      .set({ reference: null })
      .where("report_id", "in", reports),
  );
}
