import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasProtectedSessionEntryStorage,
  openProtectedSessionEntryJson,
} from "./session-entry-encryption.js";

export function hasValidSessionEntryIdentity(entry: {
  sessionId?: unknown;
  updatedAt?: unknown;
}): entry is { sessionId: string; updatedAt: number } {
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

export function parseSqliteSessionEntryRecord(
  row: {
    current_session_id?: string;
    entry_json: string;
    protected_entry_json?: string | null;
    session_key?: string;
    updated_at?: number;
  },
  database?: DatabaseSync,
): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  let entryJson = row.entry_json;
  if (database && row.session_key && hasProtectedSessionEntryStorage(database)) {
    if (row.protected_entry_json === undefined) {
      throw new Error("Protected session entry reads must select their encrypted payload.");
    }
    entryJson = openProtectedSessionEntryJson(
      database,
      row.session_key,
      row.entry_json,
      row.protected_entry_json,
    );
  }
  try {
    const record: unknown = JSON.parse(entryJson);
    if (!isRecord(record)) {
      return null;
    }
    if (!hasValidSessionEntryIdentity(record)) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
      (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
