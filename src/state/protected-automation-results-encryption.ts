import type { DatabaseSync } from "node:sqlite";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../storage/sqlite-encryption.js";

type ResultStorageContext = {
  table: string;
  column: string;
  identity: readonly (string | number)[];
};

export function assertProtectedAutomationResultConnection(db: DatabaseSync): void {
  if (!isSqliteStorageValueEncryptionStrict(db) || !hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected automation results require an admitted encrypted state database.");
  }
}

export function prepareProtectedAutomationResultText(
  db: DatabaseSync,
  plaintext: string,
  context: ResultStorageContext,
): { value: string; storedBytes: number } {
  assertProtectedAutomationResultConnection(db);
  const aad = protectedStorageValueContext(context.table, context.column, context.identity);
  const value = JSON.stringify(sealSqliteStoragePlaintext(db, plaintext, aad));
  return { value, storedBytes: Buffer.byteLength(value, "utf8") };
}

export function openProtectedAutomationResultText(
  db: DatabaseSync,
  value: string,
  context: ResultStorageContext,
): string {
  assertProtectedAutomationResultConnection(db);
  const envelope: unknown = JSON.parse(value);
  if (typeof envelope !== "string") {
    throw new Error("Protected automation result envelope is invalid.");
  }
  const aad = protectedStorageValueContext(context.table, context.column, context.identity);
  return openSqliteStorageText(db, envelope, aad);
}
