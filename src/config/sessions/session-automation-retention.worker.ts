import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readActiveCronRunReceiptOwnersInDatabase } from "../../cron/store/run-receipt-read.js";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { AutomationRetentionDeferredError } from "./session-automation-retention.errors.js";
import type { SessionColdRecord } from "./session-cold-storage-codec.js";
import { readSessionAdmissionProtectionKeys } from "./session-cold-storage-selection.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

const MAX_BATCH_ROWS = 128;
const MAX_BATCH_BYTES = 1024 * 1024;
const EXPIRY_TYPE = "automation-detail-expired";

type AutomationRun = { runId: string; jobId: string };
/** `undefined` before any user turn; `null` after a personal user turn. */
export type AutomationTurn = AutomationRun | null | undefined;
type AutomationScope = Pick<ResolvedTranscriptScope, "sessionKey" | "sessionId">;
type AutomationScan = { turn: AutomationTurn; runs: Map<string, string>; personalTurn: boolean };

export type AutomationRetentionInput = {
  scope: ResolvedTranscriptScope;
  cutoff: number;
  afterSeq?: number;
  runs?: [string, string][];
  /** Turn state after `afterSeq`, carried with `runs` so batches classify replies alike. */
  turn?: AutomationTurn;
  personalTurn?: boolean;
};

type RetentionRow = { event: Record<string, unknown>; expectedEventJson: string; seq: number };
export type AutomationRetentionPlan = AutomationRetentionInput & {
  protectionKeys: string[];
  snapshot: SessionStateDeleteSnapshot;
  rows: RetentionRow[];
  runtimeSeqs: number[];
  nextSeq?: number;
  nextTurn?: AutomationTurn;
  coldArchiveSha256?: string;
};

function readProtection(database: OpenClawAgentDatabase, scope: ResolvedTranscriptScope) {
  return {
    protectionKeys: [
      scope.sessionId,
      ...readSessionAdmissionProtectionKeys(database, [scope.sessionId]),
    ].toSorted(),
    snapshot: readSessionStateDeleteSnapshot(database.db, scope.sessionId),
  };
}

export function assertAutomationRetentionReceiptCoverage(options: OpenClawAgentDatabaseOptions) {
  const owners = withExistingOpenClawStateDatabaseCurrentReadOnly(
    (state) => readActiveCronRunReceiptOwnersInDatabase(state.db, options.agentId),
    { env: options.env, path: options.database?.path, allowNativeRead: true },
  );
  // Receipt observations have no physical transcript binding. Even a local receipt
  // must defer this agent until its exact coverage can be established.
  if (!owners || owners.length > 0) {
    throw new AutomationRetentionDeferredError(
      "Automation retention deferred because active receipt coverage is unresolved",
    );
  }
}

function admitProtection(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  context: AgentWorkerOperationContext,
) {
  assertAutomationRetentionReceiptCoverage(context.options);
  const protection = readProtection(database, scope);
  context.admit("transaction", {
    kind: "session-automation-retention-protection",
    sessionId: scope.sessionId,
    protectionKeys: protection.protectionKeys,
  });
  return protection;
}

export type AutomationRetentionCommitted = {
  kind: "session-automation-retention";
  rewritten: number;
  runtimeDeleted: number;
  nextSeq?: number;
  coldArchiveSha256?: string;
};

function automationRun(event: unknown): AutomationRun | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const expired =
    event.type === "custom" && event.customType === EXPIRY_TYPE ? event.data : undefined;
  if (isRecord(expired)) {
    return typeof expired.runId === "string" && typeof expired.jobId === "string"
      ? { runId: expired.runId, jobId: expired.jobId }
      : undefined;
  }
  if (event.type !== "message" || !isRecord(event.message) || event.message.role !== "user") {
    return undefined;
  }
  const provenance = normalizeInputProvenance(event.message.provenance);
  return provenance?.kind === "internal_system" &&
    provenance.sourceTool === "cron" &&
    provenance.jobId &&
    provenance.runId
    ? { runId: provenance.runId, jobId: provenance.jobId }
    : undefined;
}

function nextAutomationTurn(
  event: unknown,
  turn: AutomationTurn,
  scope: AutomationScope,
): AutomationTurn {
  const run = automationRun(event);
  if (run) {
    return run;
  }
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return turn;
  }
  if (event.message.role !== "user") {
    return turn;
  }
  // Legacy cron prompts carry no provenance but always open their cron session.
  // Any later untagged user message is a personal follow-up.
  return turn === undefined && isCronSessionKey(scope.sessionKey)
    ? { runId: scope.sessionId, jobId: scope.sessionKey }
    : null;
}

function automationDetail(
  event: unknown,
  scope: AutomationScope,
  runs: ReadonlyMap<string, string>,
  turn: AutomationTurn,
): AutomationRun | undefined {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return undefined;
  }
  const role = event.message.role;
  if (role === "user") {
    return automationRun(event);
  }
  if ((role !== "assistant" && role !== "toolResult") || turn === null) {
    return undefined;
  }
  const replyRunId = readSessionTranscriptRunId(event.message);
  const jobId = replyRunId ? runs.get(replyRunId) : undefined;
  if (replyRunId && jobId) {
    return { runId: replyRunId, jobId };
  }
  if (!isCronSessionKey(scope.sessionKey)) {
    return undefined;
  }
  return turn
    ? { runId: replyRunId ?? turn.runId, jobId: turn.jobId }
    : { runId: replyRunId ?? scope.sessionId, jobId: scope.sessionKey };
}

function scanAutomationEvent(event: unknown, scope: AutomationScope, scan: AutomationScan) {
  scan.turn = nextAutomationTurn(event, scan.turn, scope);
  if (scan.turn === null) {
    scan.personalTurn = true;
  }
  const run = automationRun(event) ?? automationDetail(event, scope, scan.runs, scan.turn);
  if (run && !scan.runs.has(run.runId)) {
    scan.runs.set(run.runId, run.jobId);
  }
}

/** Earliest transcript time retention would expire, independent of any sweep cutoff. */
export function readAutomationRetentionDetailAt(
  records: readonly SessionColdRecord[],
  sessionKey: string | undefined,
  sessionId: string,
) {
  if (!sessionKey) {
    return undefined;
  }
  const scope = { sessionKey, sessionId };
  const scan: AutomationScan = { turn: undefined, runs: new Map(), personalTurn: false };
  for (const record of records) {
    if (record.kind === "event") {
      scanAutomationEvent(JSON.parse(record.row.event_json), scope, scan);
    }
  }
  let turn: AutomationTurn;
  let detailAt: number | undefined;
  for (const record of records) {
    if (record.kind !== "event") {
      continue;
    }
    const event: unknown = JSON.parse(record.row.event_json);
    turn = nextAutomationTurn(event, turn, scope);
    if (
      automationDetail(event, scope, scan.runs, turn) &&
      (detailAt === undefined || record.row.created_at < detailAt)
    ) {
      detailAt = record.row.created_at;
    }
  }
  return detailAt;
}

export function listAutomationRetentionSessions(database: OpenClawAgentDatabase) {
  return executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select(["session_id as sessionId", "session_key as sessionKey"]),
  ).rows;
}

function assertSessionCurrent(database: OpenClawAgentDatabase, scope: ResolvedTranscriptScope) {
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_id", "=", scope.sessionId)
      .where("session_key", "=", scope.sessionKey),
  ).rows;
  if (!rows.length) {
    throw new Error("Automation retention lost its session");
  }
}

/** Select outside the writer transaction. Only bounded exact-row rewrites hold the writer. */
export function prepareSessionAutomationRetention(
  database: OpenClawAgentDatabase,
  input: AutomationRetentionInput,
  context: AgentWorkerOperationContext,
): AutomationRetentionPlan {
  return runSqliteDeferredTransactionSync(database.db, () =>
    selectSessionAutomationRetention(database, input, context),
  );
}

function selectSessionAutomationRetention(
  database: OpenClawAgentDatabase,
  input: AutomationRetentionInput,
  context: AgentWorkerOperationContext,
): AutomationRetentionPlan {
  const { scope, cutoff } = input;
  const protection = admitProtection(database, scope, context);
  const empty = { ...input, ...protection, rows: [], runtimeSeqs: [] };
  const cold = readSessionColdTranscript(database.db, scope.sessionId);
  if (cold) {
    return { ...empty, coldArchiveSha256: cold.archive_sha256 };
  }
  assertSessionCurrent(database, scope);
  const db = getSessionKysely(database.db);
  const select = db
    .selectFrom("transcript_events")
    .select(["seq", transcriptEventJsonSql(database.db).as("eventJson")])
    .where("session_id", "=", scope.sessionId)
    .where("created_at", "<", cutoff)
    .orderBy("seq");
  const runs = new Map<string, string>(input.runs);
  let personalTurn = input.personalTurn ?? false;
  if (!input.runs) {
    const scan: AutomationScan = { turn: undefined, runs, personalTurn: false };
    for (const row of iterateSqliteQuerySync(database.db, select)) {
      scanAutomationEvent(JSON.parse(row.eventJson), scope, scan);
    }
    personalTurn = scan.personalTurn;
  }
  const rows: RetentionRow[] = [];
  const cronSession = isCronSessionKey(scope.sessionKey);
  let bytes = 0;
  let nextSeq: number | undefined;
  let turn = input.turn;
  let turnAtLastRow = input.turn;
  for (const row of iterateSqliteQuerySync(
    database.db,
    select.where("seq", ">", input.afterSeq ?? -1),
  )) {
    const event: unknown = JSON.parse(row.eventJson);
    if (!isRecord(event)) {
      continue;
    }
    const rowTurn = nextAutomationTurn(event, turn, scope);
    const detail = automationDetail(event, scope, runs, rowTurn);
    if (!detail) {
      turn = rowTurn;
      continue;
    }
    const { runId, jobId } = detail;
    if (rows.length >= MAX_BATCH_ROWS || (rows.length > 0 && bytes >= MAX_BATCH_BYTES)) {
      nextSeq = rows.at(-1)!.seq;
      break;
    }
    turn = rowTurn;
    turnAtLastRow = rowTurn;
    rows.push({
      seq: row.seq,
      expectedEventJson: row.eventJson,
      event: {
        type: "custom",
        id: event.id,
        parentId: event.parentId,
        timestamp: event.timestamp,
        customType: EXPIRY_TYPE,
        data: { runId, jobId },
      },
    });
    bytes += Buffer.byteLength(row.eventJson);
  }
  const runtimeRows = db
    .selectFrom("trajectory_runtime_events")
    .select(["seq", "run_id"])
    .where("session_id", "=", scope.sessionId)
    .where("created_at", "<", cutoff)
    .orderBy("seq");
  // The next batch resumes after the last rewritten row, or reruns this window.
  const carried = {
    runs: [...runs],
    personalTurn,
    nextTurn: nextSeq === undefined ? input.turn : turnAtLastRow,
  };
  if (!cronSession && runs.size === 0) {
    return { ...input, ...protection, ...carried, rows, runtimeSeqs: [], nextSeq };
  }
  const runtimeSeqs: number[] = [];
  // Unattributed runtime rows belong to the automation only when nobody followed up.
  const deleteUnattributed = cronSession && !personalTurn;
  for (const row of iterateSqliteQuerySync(database.db, runtimeRows)) {
    if ((row.run_id && runs.has(row.run_id)) || deleteUnattributed) {
      runtimeSeqs.push(row.seq);
      if (runtimeSeqs.length === MAX_BATCH_ROWS) {
        break;
      }
    }
  }
  return {
    ...input,
    ...protection,
    ...carried,
    rows,
    runtimeSeqs,
    nextSeq:
      nextSeq ?? (runtimeSeqs.length === MAX_BATCH_ROWS ? (input.afterSeq ?? -1) : undefined),
  };
}

export function commitSessionAutomationRetention(
  input: AutomationRetentionPlan,
  context: AgentWorkerOperationContext,
) {
  return context.writeTransaction(
    "session.automation.retention",
    "Automation retention",
    (database) => {
      assertSessionCurrent(database, input.scope);
      const current = admitProtection(database, input.scope, context);
      if (
        !isDeepStrictEqual(current.protectionKeys, input.protectionKeys) ||
        !sqliteSessionStateDeleteSnapshotsEqual(current.snapshot, input.snapshot)
      ) {
        throw new Error("Automation retention target changed; replan before expiring detail");
      }
      if (input.rows.length > 0) {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .updateTable("transcript_event_identities")
            .set({ event_type: "custom" })
            .where("session_id", "=", input.scope.sessionId)
            .where(
              "seq",
              "in",
              input.rows.map((row) => row.seq),
            ),
        );
        rewriteSqliteTranscriptEventRowsInTransaction(database, input.scope, input.rows);
      }
      const deleted = input.runtimeSeqs.length
        ? executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .deleteFrom("trajectory_runtime_events")
              .where("session_id", "=", input.scope.sessionId)
              .where("created_at", "<", input.cutoff)
              .where("seq", "in", input.runtimeSeqs),
          ).numAffectedRows
        : 0n;
      const final = admitProtection(database, input.scope, context);
      if (!isDeepStrictEqual(final.protectionKeys, input.protectionKeys)) {
        throw new Error("Automation retention ownership changed before commit");
      }
      const candidate: AutomationRetentionCommitted = {
        kind: "session-automation-retention",
        rewritten: input.rows.length,
        runtimeDeleted: Number(deleted ?? 0n),
        nextSeq: input.nextSeq,
      };
      return transferSessionEntryWorkerCandidate(
        database,
        (stage, publication) => {
          if (stage === "commit") {
            assertAutomationRetentionReceiptCoverage(context.options);
            const commit = readProtection(database, input.scope);
            if (
              !isDeepStrictEqual(commit.protectionKeys, final.protectionKeys) ||
              !sqliteSessionStateDeleteSnapshotsEqual(commit.snapshot, final.snapshot)
            ) {
              throw new Error("Automation retention target changed before commit");
            }
          }
          context.admit(stage, publication);
        },
        candidate,
      );
    },
  );
}
