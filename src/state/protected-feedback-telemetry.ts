import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  ensureProtectedFeedbackSchema,
  protectedFeedbackDayMs,
  protectedFeedbackRetentionDays,
  toRun,
  uuidPattern,
  type FeedbackDatabase,
  type ProtectedModelRequestMetadata,
  type ProtectedStoredDataEntry,
  type ProtectedTelemetryRun,
} from "./protected-feedback.js";

export function readProtectedFeedbackStoredData(
  database: OpenClawStateDatabase,
  overheadBytes: number,
): ProtectedStoredDataEntry[] {
  if (!Number.isSafeInteger(overheadBytes) || overheadBytes < 0) {
    throw new Error("Protected feedback storage overhead is invalid.");
  }
  const db = database.db;
  if (!tableExists(db, "protected_feedback_runs")) {
    return [];
  }
  const records = [
    ...executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<FeedbackDatabase>(db)
        .selectFrom("protected_feedback_runs")
        .select([
          "id",
          "profile_id",
          sql<number>`length(CAST(files_json AS BLOB)) + length(CAST(member_label AS BLOB)) + 36`.as(
            "bytes",
          ),
        ]),
    ).rows.map((row) => ({
      id: `run:${row.id}`,
      profileId: row.profile_id,
      bytes: overheadBytes + row.bytes,
    })),
    ...executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<FeedbackDatabase>(db)
        .selectFrom("protected_feedback_requests as q")
        .innerJoin("protected_feedback_runs as r", "r.id", "q.run_id")
        .select([
          "q.id",
          "r.profile_id",
          "q.provider",
          "q.model",
          "q.outcome",
          "q.usage_source",
          "q.wall_duration_ms",
          "q.input_tokens",
          "q.output_tokens",
          "q.cache_read_tokens",
          "q.cache_write_tokens",
          "q.reasoning_tokens",
        ]),
    ).rows.map((row) => {
      const request: ProtectedModelRequestMetadata = {
        requestId: row.id,
        provider: row.provider,
        model: row.model,
        outcome: row.outcome,
        usageSource: row.usage_source,
        wallDurationMs: row.wall_duration_ms,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
      };
      return {
        id: `request:${row.id}`,
        profileId: row.profile_id,
        bytes: overheadBytes + Buffer.byteLength(JSON.stringify(request), "utf8") + row.id.length,
      };
    }),
    ...executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<FeedbackDatabase>(db)
        .selectFrom("protected_feedback_reports")
        .select([
          "id",
          "profile_id",
          sql<number>`length(CAST(description AS BLOB)) + length(CAST(category AS BLOB)) + 160`.as(
            "bytes",
          ),
        ]),
    ).rows.map((row) => ({
      id: `report:${row.id}`,
      profileId: row.profile_id,
      bytes: overheadBytes + row.bytes,
    })),
    ...executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<FeedbackDatabase>(db)
        .selectFrom("protected_response_feedback")
        .select([
          "profile_id",
          sql<string>`'feedback:' || chat_id || ':' || response_id`.as("id"),
          sql<number>`length(CAST(profile_id AS BLOB)) + length(CAST(chat_id AS BLOB)) + length(CAST(response_id AS BLOB)) + 64`.as(
            "bytes",
          ),
        ]),
    ).rows.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      bytes: overheadBytes + row.bytes,
    })),
  ];
  return records;
}

export type AdminTelemetryQuery = {
  now: number;
  days: 1 | 7 | 30 | 90;
  member?: string;
  feature?: string;
  provider?: string;
  model?: string;
  cursor?: string;
};

type MetricRun = ProtectedTelemetryRun & {
  runCount: number;
  ratingUp: number;
  ratingDown: number;
  reportCount: number;
};
type Sum = { total: number | null; measured: number };
type Dist = { p50: number | null; p95: number | null; measured: number };
type Metrics = {
  runs: number;
  errors: number;
  stopped: number;
  members: number;
  ratingsUp: number;
  ratingsDown: number;
  reports: number;
  inputTokens: Sum;
  outputTokens: Sum;
  cacheReadTokens: Sum;
  cacheWriteTokens: Sum;
  reasoningSummaryChars: Sum;
  firstOutputMs: Dist;
  firstVisibleMs: Dist;
  completionMs: Dist;
};

function sumMetric(rows: readonly MetricRun[], key: keyof ProtectedTelemetryRun): Sum {
  const values = rows
    .map((row) => row[key])
    .filter((value): value is number => typeof value === "number");
  return {
    total: values.length === 0 ? null : values.reduce((total, value) => total + value, 0),
    measured: values.length,
  };
}

function distMetric(rows: readonly MetricRun[], key: keyof ProtectedTelemetryRun): Dist {
  const values = rows
    .map((row) => row[key])
    .filter((value): value is number => typeof value === "number")
    .toSorted((left, right) => left - right);
  const percentile = (fraction: number) =>
    values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)]! : null;
  return { p50: percentile(0.5), p95: percentile(0.95), measured: values.length };
}

function metrics(rows: readonly MetricRun[]): Metrics {
  return {
    runs: rows.length,
    errors: rows.filter((row) => row.status === "failed").length,
    stopped: rows.filter((row) => row.status === "stopped").length,
    members: new Set(rows.map((row) => row.personId)).size,
    ratingsUp: rows.reduce((total, row) => total + row.ratingUp, 0),
    ratingsDown: rows.reduce((total, row) => total + row.ratingDown, 0),
    reports: rows.reduce((total, row) => total + row.reportCount, 0),
    inputTokens: sumMetric(rows, "inputTokens"),
    outputTokens: sumMetric(rows, "outputTokens"),
    cacheReadTokens: sumMetric(rows, "cacheReadTokens"),
    cacheWriteTokens: sumMetric(rows, "cacheWriteTokens"),
    reasoningSummaryChars: sumMetric(rows, "reasoningSummaryChars"),
    firstOutputMs: distMetric(rows, "firstOutputMs"),
    firstVisibleMs: distMetric(rows, "firstVisibleMs"),
    completionMs: distMetric(rows, "completionMs"),
  };
}

function cursorValue(cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const split = decoded.indexOf(":");
    const at = Number(decoded.slice(0, split));
    const id = decoded.slice(split + 1);
    if (
      split < 1 ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !uuidPattern.test(id) ||
      Buffer.from(decoded, "utf8").toString("base64url") !== cursor
    ) {
      throw new Error();
    }
    return { at, id };
  } catch {
    throw new Error("Protected telemetry cursor is invalid.");
  }
}

export function listProtectedAdminTelemetry(
  database: OpenClawStateDatabase,
  input: AdminTelemetryQuery,
) {
  ensureProtectedFeedbackSchema(database);
  const startDay = new Date(input.now - (input.days - 1) * protectedFeedbackDayMs)
    .toISOString()
    .slice(0, 10);
  const cutoff = Date.parse(`${startDay}T00:00:00.000Z`);
  const queries = getNodeSqliteKysely<FeedbackDatabase>(database.db);
  let query = queries
    .selectFrom("protected_feedback_runs")
    .selectAll()
    .where("created_at", ">=", cutoff);
  if (input.member) {
    query = query.where("profile_id", "=", input.member);
  }
  if (input.feature) {
    query = query.where("feature", "=", input.feature);
  }
  if (input.provider === "unattributed") {
    query = query.where("provider", "is", null);
  } else if (input.provider) {
    query = query.where("provider", "=", input.provider);
  }
  if (input.model === "unattributed") {
    query = query.where((builder) =>
      builder.or([builder("provider", "is", null), builder("model", "is", null)]),
    );
  } else if (input.model) {
    query = query.where((builder) =>
      builder.or([
        builder("model", "=", input.model!),
        sql<boolean>`provider || '/' || model = ${input.model}`,
      ]),
    );
  }
  const runRows = executeSqliteQuerySync(database.db, query).rows;
  const baseRuns = runRows.map(toRun);
  const ratings = new Map<string, { up: number; down: number }>();
  const reportsByResponse = new Map<string, number>();
  const reportsByRun = new Map<string, number>();
  if (baseRuns.length) {
    const feedbackRows = executeSqliteQuerySync(
      database.db,
      queries
        .selectFrom("protected_response_feedback")
        .select(["profile_id", "chat_id", "response_id", "rating"])
        .where("updated_at", ">=", cutoff),
    ).rows;
    for (const row of feedbackRows) {
      ratings.set(JSON.stringify([row.profile_id, row.chat_id, row.response_id]), {
        up: row.rating === "up" ? 1 : 0,
        down: row.rating === "down" ? 1 : 0,
      });
    }
    const reportRows = executeSqliteQuerySync(
      database.db,
      queries
        .selectFrom("protected_feedback_reports")
        .select(["id", "run_id", "profile_id", "chat_id", "response_id"])
        .where("created_at", ">=", cutoff),
    ).rows;
    for (const row of reportRows) {
      const key = JSON.stringify([row.profile_id, row.chat_id, row.response_id]);
      reportsByResponse.set(key, (reportsByResponse.get(key) ?? 0) + 1);
      if (row.run_id) {
        reportsByRun.set(row.run_id, (reportsByRun.get(row.run_id) ?? 0) + 1);
      }
    }
  }
  const allRuns: MetricRun[] = baseRuns.map((run) => {
    const key = JSON.stringify([run.personId, run.chatId, run.responseId]);
    const responseRating = ratings.get(key);
    return Object.assign(run, {
      runCount: 1,
      ratingUp: responseRating?.up ?? 0,
      ratingDown: responseRating?.down ?? 0,
      reportCount: reportsByRun.get(run.id) ?? reportsByResponse.get(key) ?? 0,
    });
  });
  const totals = metrics(allRuns);
  const daily: Array<{
    day: string;
    runs: number;
    errors: number;
    inputTokens: number | null;
    outputTokens: number | null;
  }> = [];
  for (let day = 0; day < input.days; day++) {
    const date = new Date(`${startDay}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + day);
    const key = date.toISOString().slice(0, 10);
    const rows = allRuns.filter((run) => new Date(run.at).toISOString().slice(0, 10) === key);
    const exactSum = (field: "inputTokens" | "outputTokens") =>
      rows.length > 0 && rows.every((run) => run[field] !== null)
        ? rows.reduce((total, run) => total + run[field]!, 0)
        : null;
    daily.push({
      day: key,
      runs: rows.length,
      errors: rows.filter((run) => run.status === "failed").length,
      inputTokens: exactSum("inputTokens"),
      outputTokens: exactSum("outputTokens"),
    });
  }
  const groupRuns = (keyFor: (run: MetricRun) => { key: string; label: string }) => {
    const groups = new Map<string, { label: string; values: MetricRun[] }>();
    for (const run of allRuns) {
      const key = keyFor(run);
      const group = groups.get(key.key) ?? { label: key.label, values: [] };
      group.values.push(run);
      groups.set(key.key, group);
    }
    return [...groups]
      .map(([key, group]) => ({ key, label: group.label, metrics: metrics(group.values) }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  };
  const allChatRuns = [...allRuns];
  const byTime = allChatRuns.toSorted(
    (left, right) => right.at - left.at || right.id.localeCompare(left.id),
  );
  const cursor = cursorValue(input.cursor);
  const afterCursor = cursor
    ? byTime.filter((run) => run.at < cursor.at || (run.at === cursor.at && run.id < cursor.id))
    : byTime;
  const page = afterCursor.slice(0, 50);
  const hasMore = afterCursor.length > page.length;
  const last = page.at(-1);
  return {
    generatedAt: input.now,
    retentionDays: protectedFeedbackRetentionDays,
    days: input.days,
    totals,
    daily,
    groups: {
      feature: groupRuns((run) => ({ key: run.feature, label: "Chat" })),
      member: groupRuns((run) => ({ key: run.personId, label: run.memberLabel || "Member" })),
      provider: groupRuns((run) =>
        run.provider
          ? { key: run.provider, label: run.provider }
          : { key: "unattributed", label: "Not attributed" },
      ),
      model: groupRuns((run) =>
        run.provider && run.model
          ? { key: `${run.provider}/${run.model}`, label: `${run.provider}/${run.model}` }
          : { key: "unattributed", label: "Not attributed" },
      ),
    },
    runs: page,
    nextCursor:
      hasMore && last ? Buffer.from(`${last.at}:${last.id}`, "utf8").toString("base64url") : null,
    features: [{ id: "chat", label: "Chat" }],
  };
}
