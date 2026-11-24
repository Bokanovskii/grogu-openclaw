import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Generated, type Selectable } from "kysely";
import type { ProtectedAutomationFinishedRun } from "../../packages/gateway-protocol/src/protected-automation-results.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import {
  protectedAutomationResultHistoryFull,
  protectedAutomationResultLifecycleCurrent,
} from "./protected-automation-lifecycle-retention.js";
import type { ProtectedAutomationResultWriteFacts } from "./protected-automation-results-admission.js";
import {
  assertProtectedAutomationResultConnection,
  openProtectedAutomationResultText,
  prepareProtectedAutomationResultText,
} from "./protected-automation-results-encryption.js";
import { captureProtectedAutomationFinishedResult } from "./protected-automation-results-input.js";
import type {
  PreparedProtectedAutomationFinishedResult,
  ProtectedAutomationResultCommitReceipt,
  ProtectedAutomationResultSealedWrite,
} from "./protected-automation-results.types.js";
import { readProtectedAutomation } from "./protected-automations.js";

export type ProtectedAutomationResultDatabase = {
  protected_automation_runs: {
    sequence: Generated<number>;
    id: string;
    automation_id: string;
    central_owner_profile_id: string;
    job_id: string;
    run_at_ms: number;
    native_run_id: string;
    version: string;
    definition_revision: number;
    completed_at_ms: number;
    payload_json: string;
    charged_bytes: number;
  };
};

type RunRow = Selectable<ProtectedAutomationResultDatabase["protected_automation_runs"]>;

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_automation_runs",
  indexes: ["idx_protected_automation_runs_owner", "idx_protected_automation_runs_history"],
  endMarker:
    "  ON protected_automation_runs(central_owner_profile_id, automation_id, completed_at_ms DESC, sequence DESC);\n",
  operationLabel: "protected.automationResults.schema",
});

export function typedDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<ProtectedAutomationResultDatabase>(db);
}

// The row id is immutable, so it alone binds the sealed payload; owner and automation may change.
function payloadContext(id: string) {
  return { table: "protected_automation_runs", column: "payload_json", identity: [id] } as const;
}

export function admitResults(database: OpenClawStateDatabase) {
  assertProtectedAutomationResultConnection(database.db);
  ensureSchema({ database, path: database.path });
}

function ownedAutomation(database: OpenClawStateDatabase, profileId: string, automationId: string) {
  const automation = readProtectedAutomation(database, { profileId, automationId });
  return automation?.relation === "owner" && automation.centralOwnerProfileId === profileId
    ? automation
    : undefined;
}

export function isOwner(database: OpenClawStateDatabase, profileId: string, automationId: string) {
  return Boolean(ownedAutomation(database, profileId, automationId));
}

function privatePayload(input: PreparedProtectedAutomationFinishedResult) {
  return {
    automationName: input.automationName,
    privateFinalText: input.privateFinalText,
    transcript: input.transcript,
  };
}

function isPrivatePayload(value: unknown): value is {
  automationName: string;
  privateFinalText: string;
  transcript: { sessionKey: string; sessionId: string };
} {
  return (
    isRecord(value) &&
    typeof value.automationName === "string" &&
    typeof value.privateFinalText === "string" &&
    isRecord(value.transcript) &&
    typeof value.transcript.sessionKey === "string" &&
    typeof value.transcript.sessionId === "string"
  );
}

function openPayload(db: DatabaseSync, row: Pick<RunRow, "id" | "payload_json">) {
  const value: unknown = JSON.parse(
    openProtectedAutomationResultText(db, row.payload_json, payloadContext(row.id)),
  );
  if (!isPrivatePayload(value)) {
    throw new Error("Retained protected automation run payload is invalid.");
  }
  return value;
}

export function privateRecord(db: DatabaseSync, row: RunRow): ProtectedAutomationFinishedRun {
  const payload = openPayload(db, row);
  return {
    id: row.id,
    automationId: row.automation_id,
    version: row.version,
    definitionRevision: row.definition_revision,
    runId: row.native_run_id,
    runAtMs: row.run_at_ms,
    completedAtMs: row.completed_at_ms,
    automationName: payload.automationName,
    text: payload.privateFinalText,
  };
}

function existingRun(
  db: DatabaseSync,
  input: { jobId: string; runAtMs: number; runId: string },
): RunRow | undefined {
  return executeSqliteQuerySync(
    db,
    typedDatabase(db)
      .selectFrom("protected_automation_runs")
      .selectAll()
      .where("job_id", "=", input.jobId)
      .where("run_at_ms", "=", input.runAtMs)
      .where("native_run_id", "=", input.runId),
  ).rows[0];
}

function matchesExisting(
  db: DatabaseSync,
  row: RunRow,
  input: PreparedProtectedAutomationFinishedResult,
) {
  return (
    row.automation_id === input.automationId &&
    row.central_owner_profile_id === input.centralOwnerProfileId &&
    row.definition_revision === input.definitionRevision &&
    row.completed_at_ms === input.completedAtMs &&
    isDeepStrictEqual(openPayload(db, row), privatePayload(input))
  );
}

export type PrepareProtectedAutomationResultOutcome =
  | { status: "duplicate"; id: string; version: string }
  | { status: "conflict" | "not-owner" | "retention-required" }
  | { status: "prepared"; input: ProtectedAutomationResultSealedWrite };

export function prepareProtectedAutomationResult(
  database: OpenClawStateDatabase,
  original: PreparedProtectedAutomationFinishedResult,
): PrepareProtectedAutomationResultOutcome {
  const input = captureProtectedAutomationFinishedResult(original);
  admitResults(database);
  // Refuse before the host reserves anything for an automation this member does not own.
  const automation = ownedAutomation(database, input.centralOwnerProfileId, input.automationId);
  if (!automation) {
    return { status: "not-owner" };
  }
  const existing = existingRun(database.db, input);
  if (existing) {
    return matchesExisting(database.db, existing, input)
      ? { status: "duplicate", id: existing.id, version: existing.version }
      : { status: "conflict" };
  }
  // Lifecycle admission retires the oldest run and its result before publication.
  // Legacy result-only callers must not grow storage while that owner is absent.
  if (protectedAutomationResultHistoryFull(database, input)) {
    return { status: "retention-required" };
  }
  if (
    !protectedAutomationResultLifecycleCurrent(database, {
      ...input,
      transcriptSessionId: input.transcript.sessionId,
      isolated: automation.definition.contextAccess === "isolated",
    })
  ) {
    return { status: "conflict" };
  }
  const id = randomUUID();
  return {
    status: "prepared",
    input: {
      id,
      version: randomUUID(),
      automationId: input.automationId,
      definitionRevision: input.definitionRevision,
      centralOwnerProfileId: input.centralOwnerProfileId,
      jobId: input.jobId,
      runAtMs: input.runAtMs,
      runId: input.runId,
      completedAtMs: input.completedAtMs,
      payload: prepareProtectedAutomationResultText(
        database.db,
        JSON.stringify(privatePayload(input)),
        payloadContext(id),
      ),
    },
  };
}

function assertWriteFacts(facts: ProtectedAutomationResultWriteFacts) {
  const { input, entries, reservedBytes } = facts;
  const entry = entries[0];
  if (
    facts.kind !== "protected-automation-result" ||
    entries.length !== 1 ||
    !entry ||
    entry.id !== `protected-automation-run:${input.id}` ||
    entry.profileId !== input.centralOwnerProfileId ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < input.payload.storedBytes ||
    entry.bytes !== reservedBytes ||
    Buffer.byteLength(input.payload.value, "utf8") !== input.payload.storedBytes
  ) {
    throw new Error("Protected automation result has invalid storage admission facts.");
  }
  return entry;
}

export function commitProtectedAutomationResult(
  database: OpenClawStateDatabase,
  facts: ProtectedAutomationResultWriteFacts,
): { status: "created"; id: string; version: string } {
  const { input, entries } = facts;
  const entry = assertWriteFacts(facts);
  admitResults(database);

  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
      // A rollback here releases the reservation; the owner may have lost access since prepare.
      const automation = ownedAutomation(database, input.centralOwnerProfileId, input.automationId);
      if (!automation) {
        throw new Error("Protected automation result owner no longer owns the automation.");
      }
      if (existingRun(db, input)) {
        throw new Error(
          "Protected automation result already exists; reconcile its native identity.",
        );
      }
      if (protectedAutomationResultHistoryFull(database, input)) {
        throw new Error("Protected automation result retention must settle before publication.");
      }
      const payload = openPayload(db, { id: input.id, payload_json: input.payload.value });
      if (
        !protectedAutomationResultLifecycleCurrent(database, {
          ...input,
          transcriptSessionId: payload.transcript.sessionId,
          isolated: automation.definition.contextAccess === "isolated",
        })
      ) {
        throw new Error("Protected automation result run is no longer current.");
      }
      const kysely = typedDatabase(db);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("protected_automation_runs").values({
          id: input.id,
          automation_id: input.automationId,
          central_owner_profile_id: input.centralOwnerProfileId,
          job_id: input.jobId,
          run_at_ms: input.runAtMs,
          native_run_id: input.runId,
          version: input.version,
          definition_revision: input.definitionRevision,
          completed_at_ms: input.completedAtMs,
          payload_json: input.payload.value,
          charged_bytes: entry.bytes,
        }),
      );
      const stored = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_automation_runs")
          .select([
            "payload_json",
            /* kysely-allow-raw: SQLite BLOB length counts the stored UTF-8 bytes of sealed text. */
            sql<number>`length(CAST(payload_json AS BLOB))`.as("storedBytes"),
          ])
          .where("id", "=", input.id),
      ).rows[0];
      if (
        stored?.payload_json !== input.payload.value ||
        stored.storedBytes !== input.payload.storedBytes
      ) {
        throw new Error("Protected automation run did not retain its prepared encrypted payload.");
      }

      requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
      const receipt: ProtectedAutomationResultCommitReceipt = {
        kind: "protected-automation-result-committed",
        automationId: input.automationId,
        definitionRevision: input.definitionRevision,
        centralOwnerProfileId: input.centralOwnerProfileId,
        jobId: input.jobId,
        runAtMs: input.runAtMs,
        runId: input.runId,
        id: input.id,
        version: input.version,
        entries,
      };
      deferSqliteWorkerCommitReceipt(db, receipt);
      return { status: "created" as const, id: input.id, version: input.version };
    },
    { path: database.path },
    { operationLabel: "protected.automationResults.commit" },
  );
}
