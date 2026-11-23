import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";

export type ProtectedFeedbackRating = "up" | "down";
export type ProtectedFeedbackCategory =
  | "wrong"
  | "ignored"
  | "broken"
  | "slow"
  | "unsafe"
  | "other";
export type ProtectedFeedbackStatus = "open" | "reviewed";
export type ProtectedFeedbackEvidenceState = "available" | "deleted" | "member_removed";

export type FeedbackDatabase = {
  user_profiles: { id: string; display_name: string | null };
  protected_feedback_runs: {
    id: string;
    profile_id: string;
    member_label: string;
    created_at: number;
    feature: string;
    agent_id: string | null;
    provider: string | null;
    model: string | null;
    status: "complete" | "failed" | "stopped";
    chat_id: string | null;
    response_id: string | null;
    error_code: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    total_tokens: number | null;
    reasoning_summary_chars: number | null;
    admission_ms: number | null;
    provider_start_ms: number | null;
    first_output_ms: number | null;
    first_visible_ms: number | null;
    completion_ms: number;
    files_json: string;
  };
  protected_feedback_requests: {
    id: string;
    run_id: string;
    provider: string | null;
    model: string | null;
    outcome: string | null;
    usage_source: string | null;
    wall_duration_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    reasoning_tokens: number | null;
  };
  protected_feedback_reports: {
    id: string;
    submission_id: string;
    profile_id: string;
    chat_id: string;
    response_id: string;
    run_id: string | null;
    provider: string | null;
    model: string | null;
    agent_id: string | null;
    category: ProtectedFeedbackCategory;
    description: string;
    status: ProtectedFeedbackStatus;
    evidence_state: ProtectedFeedbackEvidenceState;
    created_at: number;
    reviewed_at: number | null;
  };
  protected_response_feedback: {
    profile_id: string;
    chat_id: string;
    response_id: string;
    rating: ProtectedFeedbackRating | null;
    report_id: string | null;
    updated_at: number;
  };
  protected_report_chat_evidence: {
    report_id: string;
    reference: string | null;
  };
};

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_feedback_runs",
  additionalTables: [
    "protected_feedback_requests",
    "protected_feedback_reports",
    "protected_response_feedback",
    "protected_report_chat_evidence",
  ],
  indexes: [
    "idx_protected_feedback_runs_created",
    "idx_protected_feedback_runs_profile",
    "idx_protected_feedback_runs_response",
    "idx_protected_feedback_requests_run",
    "idx_protected_feedback_reports_status",
    "idx_protected_feedback_reports_member",
    "idx_protected_response_feedback_chat",
  ],
  endMarker:
    "CREATE INDEX IF NOT EXISTS idx_protected_response_feedback_chat\n  ON protected_response_feedback(profile_id, chat_id, response_id);\n",
  operationLabel: "protected.feedback.schema",
});

export function ensureProtectedFeedbackSchema(database: OpenClawStateDatabase) {
  ensureSchema({ database, path: database.path });
}

export type ProtectedModelRequestMetadata = {
  requestId: string;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  usageSource: string | null;
  wallDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

export type ProtectedProducedFile = {
  id: string;
  name: string;
  size: number;
  origin: "produced";
};

export type ProtectedReportChatReference = {
  title: string;
  eventCount: number;
  digest: string;
  capturedAt: number;
  files: ProtectedProducedFile[];
};

export type ProtectedTurnTelemetryInput = {
  id: string;
  profileId: string;
  memberLabel: string;
  createdAt: number;
  agentId: string | null;
  status: "complete" | "failed" | "stopped";
  chatId: string | null;
  responseId: string | null;
  errorCode: string | null;
  reasoningSummaryChars: number | null;
  admissionMs: number | null;
  providerStartMs: number | null;
  firstOutputMs: number | null;
  firstVisibleMs: number | null;
  completionMs: number;
  files: readonly ProtectedProducedFile[];
  requests: readonly ProtectedModelRequestMetadata[];
  storageOverheadBytes: number;
};

export type ProtectedStoredDataEntry = { id: string; profileId: string; bytes: number };

export type ProtectedFeedbackValue = {
  responseId: string;
  rating: ProtectedFeedbackRating | null;
  reportId: string | null;
};

export type ProtectedReportSummary = {
  id: string;
  status: ProtectedFeedbackStatus;
  category: ProtectedFeedbackCategory;
  excerpt: string;
  createdAt: number;
  reviewedAt: number | null;
  member: { personId: string; displayName: string };
  provider: string | null;
  model: string | null;
  agentId: string | null;
  evidence: ProtectedFeedbackEvidenceState;
};

export type ProtectedReportRecord = ProtectedReportSummary & {
  description: string;
  chatId: string;
  responseId: string;
  runId: string | null;
  metrics: ProtectedTelemetryRun | null;
  files: ProtectedProducedFile[];
  chatIncluded?: boolean;
  chatReference?: ProtectedReportChatReference | null;
};

export type ProtectedTelemetryRun = {
  id: string;
  at: number;
  personId: string;
  memberLabel: string;
  feature: string;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  status: "complete" | "failed" | "stopped";
  chatId: string | null;
  responseId: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  reasoningSummaryChars: number | null;
  admissionMs: number | null;
  providerStartMs: number | null;
  firstOutputMs: number | null;
  firstVisibleMs: number | null;
  completionMs: number | null;
};

type StoredRun = FeedbackDatabase["protected_feedback_runs"];

export const protectedFeedbackDayMs = 24 * 60 * 60_000;
export const protectedFeedbackRetentionDays = 90;
export const protectedFeedbackRetentionMs = protectedFeedbackRetentionDays * protectedFeedbackDayMs;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const nonNegativeInteger = (value: number | null) =>
  value === null || (Number.isSafeInteger(value) && value >= 0);

function assertTelemetry(input: ProtectedTurnTelemetryInput) {
  if (
    !uuidPattern.test(input.id) ||
    !input.profileId ||
    input.memberLabel.length > 200 ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.completionMs) ||
    input.completionMs < 0 ||
    !nonNegativeInteger(input.reasoningSummaryChars) ||
    !nonNegativeInteger(input.admissionMs) ||
    !nonNegativeInteger(input.providerStartMs) ||
    !nonNegativeInteger(input.firstOutputMs) ||
    !nonNegativeInteger(input.firstVisibleMs) ||
    !Number.isSafeInteger(input.storageOverheadBytes) ||
    input.storageOverheadBytes < 0 ||
    input.requests.some(
      (request) =>
        !uuidPattern.test(request.requestId) ||
        !nonNegativeInteger(request.wallDurationMs) ||
        !nonNegativeInteger(request.inputTokens) ||
        !nonNegativeInteger(request.outputTokens) ||
        !nonNegativeInteger(request.cacheReadTokens) ||
        !nonNegativeInteger(request.cacheWriteTokens) ||
        !nonNegativeInteger(request.reasoningTokens),
    ) ||
    input.files.some(
      (file) =>
        !file.id ||
        file.id.length > 200 ||
        !file.name ||
        file.name.length > 200 ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.origin !== "produced",
    )
  ) {
    throw new Error("Protected turn telemetry is invalid.");
  }
}

function sumComplete(
  requests: readonly ProtectedModelRequestMetadata[],
  key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens",
) {
  if (requests.length === 0 || requests.some((request) => request[key] === null)) {
    return null;
  }
  const total = requests.reduce((sum, request) => sum + request[key]!, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function uniqueAttribution(requests: readonly ProtectedModelRequestMetadata[]) {
  if (requests.length === 0 || requests.some((request) => !request.provider || !request.model)) {
    return { provider: null, model: null };
  }
  const first = requests[0]!;
  if (
    requests.some((request) => request.provider !== first.provider || request.model !== first.model)
  ) {
    return { provider: null, model: null };
  }
  return { provider: first.provider, model: first.model };
}

export function insertProtectedTurnTelemetry(
  db: DatabaseSync,
  input: ProtectedTurnTelemetryInput,
): ProtectedStoredDataEntry[] {
  assertTelemetry(input);
  const queries = getNodeSqliteKysely<FeedbackDatabase>(db);
  const inputTokens = sumComplete(input.requests, "inputTokens");
  const outputTokens = sumComplete(input.requests, "outputTokens");
  const cacheReadTokens = sumComplete(input.requests, "cacheReadTokens");
  const cacheWriteTokens = sumComplete(input.requests, "cacheWriteTokens");
  const totalTokens =
    inputTokens !== null && outputTokens !== null
      ? Number.isSafeInteger(inputTokens + outputTokens)
        ? inputTokens + outputTokens
        : null
      : null;
  const attribution = uniqueAttribution(input.requests);
  const filesJson = JSON.stringify(input.files);
  executeSqliteQuerySync(
    db,
    queries.insertInto("protected_feedback_runs").values({
      id: input.id,
      profile_id: input.profileId,
      member_label: input.memberLabel,
      created_at: input.createdAt,
      feature: "chat",
      agent_id: input.agentId,
      provider: attribution.provider,
      model: attribution.model,
      status: input.status,
      chat_id: input.chatId,
      response_id: input.responseId,
      error_code: input.errorCode,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      total_tokens: totalTokens,
      reasoning_summary_chars: input.reasoningSummaryChars,
      admission_ms: input.admissionMs,
      provider_start_ms: input.providerStartMs,
      first_output_ms: input.firstOutputMs,
      first_visible_ms: input.firstVisibleMs,
      completion_ms: input.completionMs,
      files_json: filesJson,
    }),
  );
  const requestEntries: ProtectedStoredDataEntry[] = [];
  for (const request of input.requests) {
    executeSqliteQuerySync(
      db,
      queries.insertInto("protected_feedback_requests").values({
        id: request.requestId,
        run_id: input.id,
        provider: request.provider,
        model: request.model,
        outcome: request.outcome,
        usage_source: request.usageSource,
        wall_duration_ms: request.wallDurationMs,
        input_tokens: request.inputTokens,
        output_tokens: request.outputTokens,
        cache_read_tokens: request.cacheReadTokens,
        cache_write_tokens: request.cacheWriteTokens,
        reasoning_tokens: request.reasoningTokens,
      }),
    );
    requestEntries.push({
      id: `request:${request.requestId}`,
      profileId: input.profileId,
      bytes:
        input.storageOverheadBytes +
        Buffer.byteLength(JSON.stringify(request), "utf8") +
        request.requestId.length,
    });
  }
  executeSqliteQuerySync(
    db,
    queries
      .updateTable("protected_feedback_reports")
      .set({
        run_id: input.id,
        provider: attribution.provider,
        model: attribution.model,
        agent_id: input.agentId,
      })
      .where("profile_id", "=", input.profileId)
      .where("chat_id", "=", input.chatId ?? "")
      .where("response_id", "=", input.responseId ?? "")
      .where("run_id", "is", null),
  );
  return [
    {
      id: `run:${input.id}`,
      profileId: input.profileId,
      bytes:
        input.storageOverheadBytes +
        Buffer.byteLength(filesJson, "utf8") +
        Buffer.byteLength(input.memberLabel, "utf8") +
        input.id.length,
    },
    ...requestEntries,
  ];
}

export function recordProtectedTurnTelemetry(
  database: OpenClawStateDatabase,
  input: ProtectedTurnTelemetryInput,
): ProtectedStoredDataEntry[] {
  ensureProtectedFeedbackSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => insertProtectedTurnTelemetry(db, input),
    { path: database.path },
    { operationLabel: "protected.feedback.telemetry.record" },
  );
}

export const toRun = (row: StoredRun): ProtectedTelemetryRun => ({
  id: row.id,
  at: row.created_at,
  personId: row.profile_id,
  memberLabel: row.member_label,
  feature: row.feature,
  agentId: row.agent_id,
  provider: row.provider,
  model: row.model,
  status: row.status,
  chatId: row.chat_id,
  responseId: row.response_id,
  errorCode: row.error_code,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  totalTokens: row.total_tokens,
  reasoningSummaryChars: row.reasoning_summary_chars,
  admissionMs: row.admission_ms,
  providerStartMs: row.provider_start_ms,
  firstOutputMs: row.first_output_ms,
  firstVisibleMs: row.first_visible_ms,
  completionMs: row.completion_ms,
});
