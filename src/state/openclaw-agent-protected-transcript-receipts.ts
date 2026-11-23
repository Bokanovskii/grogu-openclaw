import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transcriptEventStorageContext } from "../config/sessions/transcript-payload.js";
import {
  hasSqliteStorageValueEncryption,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../storage/sqlite-encryption.js";

/** Imported by the protected custody schema owner; receipts never create their own table. */
export const PROTECTED_NATIVE_WRITE_RECEIPTS_SQL = `
CREATE TABLE IF NOT EXISTS protected_native_write_receipts (
  operation_id TEXT PRIMARY KEY,
  custody_id TEXT NOT NULL,
  sealed_facts TEXT NOT NULL CHECK (substr(sealed_facts, 1, 8) = 'OCSEAL1:')
) STRICT;
`;

const SEALED_TEXT_PREFIX = "OCSEAL1:";

export type ProtectedTranscriptWriteKey = {
  /** Minted by the host custody owner for exactly one physical write. */
  operationId: string;
  /** Retained setup/run custody; carried as a fact, never as authority. */
  custodyId: string;
};

export type ProtectedTranscriptWriteFacts = ProtectedTranscriptWriteKey & {
  profileId: string;
  databaseIdentity: string;
  /** Authenticated persistent store incarnation, not a process-local generation. */
  databaseIncarnation: string;
  sessionId: string;
  generation: string;
  seq: number;
  /** `length(CAST(event_json AS BLOB))` of the committed sealed event. */
  ciphertextBytes: number;
  /** SHA-256 of the committed sealed event text. */
  ciphertextDigest: string;
  /** False when this operation found an existing event: it adds no stored bytes. */
  created: boolean;
};

export type ProtectedTranscriptWriteReceipt = ProtectedTranscriptWriteFacts & {
  version: 1;
  kind: "transcript-event";
};

const FACT_KEYS = [
  "version",
  "kind",
  "operationId",
  "custodyId",
  "profileId",
  "databaseIdentity",
  "databaseIncarnation",
  "sessionId",
  "generation",
  "seq",
  "ciphertextBytes",
  "ciphertextDigest",
  "created",
] as const satisfies readonly (keyof ProtectedTranscriptWriteReceipt)[];

function receiptContext(key: ProtectedTranscriptWriteKey): string {
  return protectedStorageValueContext("protected_native_write_receipts", "sealed_facts", [
    key.operationId,
    key.custodyId,
  ]);
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Protected transcript receipt requires ${name}`);
  }
}

function assertFacts(facts: ProtectedTranscriptWriteFacts): void {
  for (const name of [
    "operationId",
    "custodyId",
    "profileId",
    "databaseIdentity",
    "databaseIncarnation",
    "sessionId",
    "generation",
  ] as const) {
    assertNonEmpty(facts[name], name);
  }
  if (!Number.isSafeInteger(facts.seq) || facts.seq < 0) {
    throw new Error("Protected transcript receipt requires an event sequence");
  }
  if (!Number.isSafeInteger(facts.ciphertextBytes) || facts.ciphertextBytes <= 0) {
    throw new Error("Protected transcript receipt requires committed ciphertext bytes");
  }
  if (!/^[0-9a-f]{64}$/u.test(facts.ciphertextDigest)) {
    throw new Error("Protected transcript receipt requires a SHA-256 ciphertext digest");
  }
  if (typeof facts.created !== "boolean") {
    throw new Error("Protected transcript receipt requires its creation outcome");
  }
}

function assertProtectedConnection(db: DatabaseSync): void {
  if (!hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected transcript receipts require registered storage encryption");
  }
}

/** Verify the stored event row is the exact sealed ciphertext the producer reported. */
function assertCommittedEvent(db: DatabaseSync, facts: ProtectedTranscriptWriteFacts): void {
  const row = db
    .prepare(
      `SELECT event_json, length(CAST(event_json AS BLOB)) AS bytes, event_zstd, navigation_json
       FROM transcript_events WHERE session_id = ? AND seq = ?`,
    )
    .get(facts.sessionId, facts.seq) as
    | { event_json: unknown; bytes: unknown; event_zstd: unknown; navigation_json: unknown }
    | undefined;
  if (
    !row ||
    typeof row.event_json !== "string" ||
    !row.event_json.startsWith(SEALED_TEXT_PREFIX) ||
    row.event_zstd !== null ||
    row.navigation_json !== null
  ) {
    throw new Error("Protected transcript receipt has no sealed physical event");
  }
  if (
    row.bytes !== facts.ciphertextBytes ||
    createHash("sha256").update(row.event_json, "utf8").digest("hex") !== facts.ciphertextDigest
  ) {
    throw new Error("Protected transcript receipt does not match the stored ciphertext");
  }
  // Authenticate the event under its own identity so a copied envelope cannot be accounted.
  openSqliteStorageText(
    db,
    row.event_json,
    transcriptEventStorageContext(facts.sessionId, facts.seq),
  );
}

function serialize(facts: ProtectedTranscriptWriteFacts): string {
  const receipt: ProtectedTranscriptWriteReceipt = {
    ...facts,
    version: 1,
    kind: "transcript-event",
  };
  return JSON.stringify(Object.fromEntries(FACT_KEYS.map((key) => [key, receipt[key]])));
}

function parse(
  key: ProtectedTranscriptWriteKey,
  plaintext: string,
): ProtectedTranscriptWriteReceipt {
  const value: unknown = JSON.parse(plaintext);
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== FACT_KEYS.length ||
    !FACT_KEYS.every((name) => Object.hasOwn(value, name))
  ) {
    throw new Error("Protected transcript receipt has an unknown shape");
  }
  const receipt = value as ProtectedTranscriptWriteReceipt;
  if (receipt.version !== 1 || receipt.kind !== "transcript-event") {
    throw new Error("Protected transcript receipt has an unsupported version");
  }
  assertFacts(receipt);
  if (receipt.operationId !== key.operationId || receipt.custodyId !== key.custodyId) {
    throw new Error("Protected transcript receipt is bound to another operation");
  }
  return receipt;
}

/**
 * Record one transcript write inside the producer's open transaction, after the event
 * insert or replay read and before its commit admission. The receipt commits or rolls
 * back with that transaction; an existing receipt for the operation is always refused.
 */
export function recordProtectedTranscriptWriteReceipt(
  db: DatabaseSync,
  facts: ProtectedTranscriptWriteFacts,
): ProtectedTranscriptWriteReceipt {
  if (!db.isTransaction) {
    throw new Error("Protected transcript receipts must commit with their physical write");
  }
  assertProtectedConnection(db);
  assertFacts(facts);
  assertCommittedEvent(db, facts);
  const existing = db
    .prepare("SELECT 1 FROM protected_native_write_receipts WHERE operation_id = ?")
    .get(facts.operationId);
  if (existing) {
    throw new Error("Protected transcript operation already has a committed receipt");
  }
  db.prepare(
    "INSERT INTO protected_native_write_receipts (operation_id, custody_id, sealed_facts) VALUES (?, ?, ?)",
  ).run(
    facts.operationId,
    facts.custodyId,
    sealSqliteStoragePlaintext(db, serialize(facts), receiptContext(facts)),
  );
  return { ...facts, version: 1, kind: "transcript-event" };
}

/**
 * Read an authenticated receipt. Absence is not proof of rollback on its own: recovery
 * must first stop the original writer and readmit the exact store incarnation.
 */
export function readProtectedTranscriptWriteReceipt(
  db: DatabaseSync,
  key: ProtectedTranscriptWriteKey,
): ProtectedTranscriptWriteReceipt | undefined {
  assertProtectedConnection(db);
  assertNonEmpty(key.operationId, "operationId");
  assertNonEmpty(key.custodyId, "custodyId");
  const row = db
    .prepare(
      "SELECT custody_id, sealed_facts FROM protected_native_write_receipts WHERE operation_id = ?",
    )
    .get(key.operationId) as { custody_id: unknown; sealed_facts: unknown } | undefined;
  if (!row) {
    return undefined;
  }
  if (row.custody_id !== key.custodyId || typeof row.sealed_facts !== "string") {
    throw new Error("Protected transcript receipt is bound to another custody");
  }
  return parse(key, openSqliteStorageText(db, row.sealed_facts, receiptContext(key)));
}
