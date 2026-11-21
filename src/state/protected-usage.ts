import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProtectedAdmissionSchema } from "./protected-admission.js";

type UsageDatabase = {
  protected_usage_daily: {
    profile_id: string;
    day: string;
    messages: number;
    tokens: number;
    models_json: string;
    errors: number;
    missing_usage: number;
    missing_messages: number;
  };
  protected_usage_runs: { run_id: string; day: string };
};

export type ProtectedDailyUsage = {
  day: string;
  messages: number;
  tokens: number;
  models: string[];
  errors: number;
  missingUsage: number;
  missingMessages: number;
};

const dayAt = (time: number) => new Date(time).toISOString().slice(0, 10);
const firstRetainedDay = (now: number) => dayAt(now - 89 * 24 * 60 * 60_000);

function parseModels(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((model) => typeof model === "string")) {
    throw new Error("Protected daily usage has invalid model data.");
  }
  return parsed;
}

export function recordProtectedUsage(
  database: OpenClawStateDatabase,
  input: {
    runId: string;
    profileId: string;
    model: string;
    messages: number | null;
    tokens: number | null;
    failed: boolean;
    now: number;
  },
): void {
  if (
    !input.runId ||
    !input.profileId ||
    !input.model ||
    (input.messages !== null && (!Number.isSafeInteger(input.messages) || input.messages < 0)) ||
    (input.tokens !== null && (!Number.isSafeInteger(input.tokens) || input.tokens < 0)) ||
    !Number.isSafeInteger(input.now)
  ) {
    throw new Error("Protected usage is invalid.");
  }
  ensureProtectedAdmissionSchema(database);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<UsageDatabase>(db);
      const day = dayAt(input.now);
      const inserted = executeSqliteQuerySync(
        db,
        queries
          .insertInto("protected_usage_runs")
          .values({ run_id: input.runId, day })
          .onConflict((conflict) => conflict.column("run_id").doNothing()),
      );
      if (Number(inserted.numAffectedRows ?? 0) === 0) {
        return;
      }
      const prior = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_usage_daily")
          .selectAll()
          .where("profile_id", "=", input.profileId)
          .where("day", "=", day),
      ).rows[0];
      const models = [
        ...new Set([...(prior ? parseModels(prior.models_json) : []), input.model]),
      ].toSorted();
      const row = {
        profile_id: input.profileId,
        day,
        messages: (prior?.messages ?? 0) + (input.messages ?? 0),
        tokens: (prior?.tokens ?? 0) + (input.tokens ?? 0),
        models_json: JSON.stringify(models),
        errors: (prior?.errors ?? 0) + (input.failed ? 1 : 0),
        missing_usage: (prior?.missing_usage ?? 0) + (input.tokens === null ? 1 : 0),
        missing_messages: (prior?.missing_messages ?? 0) + (input.messages === null ? 1 : 0),
      };
      executeSqliteQuerySync(
        db,
        queries
          .insertInto("protected_usage_daily")
          .values(row)
          .onConflict((conflict) => conflict.columns(["profile_id", "day"]).doUpdateSet(row)),
      );
    },
    { path: database.path },
    { operationLabel: "protected.usage.record" },
  );
}

export function listProtectedUsage(
  database: OpenClawStateDatabase,
  input: { profileId: string; now: number },
): ProtectedDailyUsage[] {
  ensureProtectedAdmissionSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<UsageDatabase>(database.db)
      .selectFrom("protected_usage_daily")
      .selectAll()
      .where("profile_id", "=", input.profileId)
      .where("day", ">=", firstRetainedDay(input.now))
      .orderBy("day", "desc"),
  ).rows;
  return rows.map((row) => ({
    day: row.day,
    messages: row.messages,
    tokens: row.tokens,
    models: parseModels(row.models_json),
    errors: row.errors,
    missingUsage: row.missing_usage,
    missingMessages: row.missing_messages,
  }));
}

export function pruneProtectedUsage(database: OpenClawStateDatabase, now: number): void {
  ensureProtectedAdmissionSchema(database);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<UsageDatabase>(db);
      const firstDay = firstRetainedDay(now);
      executeSqliteQuerySync(
        db,
        queries.deleteFrom("protected_usage_daily").where("day", "<", firstDay),
      );
      executeSqliteQuerySync(
        db,
        queries.deleteFrom("protected_usage_runs").where("day", "<", firstDay),
      );
    },
    { path: database.path },
    { operationLabel: "protected.usage.prune" },
  );
}
