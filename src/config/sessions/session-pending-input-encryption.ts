import type { DatabaseSync } from "node:sqlite";
import {
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStorageText,
} from "../../storage/sqlite-encryption.js";

export function sessionPendingInputMessageContext(inputId: string): string {
  return protectedStorageValueContext("session_pending_inputs", "message_json", [inputId]);
}

export function openSessionPendingInputMessage(
  database: DatabaseSync,
  inputId: string,
  messageJson: string,
): string {
  return openSqliteStorageText(database, messageJson, sessionPendingInputMessageContext(inputId));
}

export function sealSessionPendingInputMessage(
  database: DatabaseSync,
  inputId: string,
  messageJson: string,
): string {
  return sealSqliteStorageText(database, messageJson, sessionPendingInputMessageContext(inputId));
}

export function sessionInputCompletionOutcomeContext(
  sessionId: string,
  idempotencyKey: string,
): string {
  return protectedStorageValueContext("session_input_completions", "outcome_json", [
    sessionId,
    idempotencyKey,
  ]);
}

export function openSessionInputCompletionOutcome(
  database: DatabaseSync,
  sessionId: string,
  idempotencyKey: string,
  outcomeJson: string,
): string {
  return openSqliteStorageText(
    database,
    outcomeJson,
    sessionInputCompletionOutcomeContext(sessionId, idempotencyKey),
  );
}

export function sealSessionInputCompletionOutcome(
  database: DatabaseSync,
  sessionId: string,
  idempotencyKey: string,
  outcomeJson: string,
): string {
  return sealSqliteStorageText(
    database,
    outcomeJson,
    sessionInputCompletionOutcomeContext(sessionId, idempotencyKey),
  );
}
