import type { DatabaseSync } from "node:sqlite";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../../storage/sqlite-encryption.js";

type SuggestionFields = {
  id: string;
  session_key: string;
  author_id: string;
  author_label: string | null;
  text: string;
};

function context(column: "author_id" | "author_label" | "text", row: SuggestionFields): string {
  return protectedStorageValueContext("session_suggestions", column, [row.session_key, row.id]);
}

export function openSessionSuggestionFields<T extends SuggestionFields>(
  database: DatabaseSync,
  row: T,
): T {
  if (!hasSqliteStorageValueEncryption(database)) {
    return row;
  }
  return {
    ...row,
    author_id: openSqliteStorageText(database, row.author_id, context("author_id", row)),
    author_label:
      row.author_label === null
        ? null
        : openSqliteStorageText(database, row.author_label, context("author_label", row)),
    text: openSqliteStorageText(database, row.text, context("text", row)),
  };
}

export function sealSessionSuggestionFields<T extends SuggestionFields>(
  database: DatabaseSync,
  row: T,
): T {
  if (!hasSqliteStorageValueEncryption(database)) {
    return row;
  }
  return {
    ...row,
    author_id: sealSqliteStoragePlaintext(database, row.author_id, context("author_id", row)),
    author_label:
      row.author_label === null
        ? null
        : sealSqliteStoragePlaintext(database, row.author_label, context("author_label", row)),
    text: sealSqliteStoragePlaintext(database, row.text, context("text", row)),
  };
}
