import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  requestSqliteWorkerOperationAdmission,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  parseRequest,
  type LedgerDatabase,
  type LedgerOperations,
  type Request,
  type Source,
  type Topic,
} from "./schema.js";

const SCHEMA = `
CREATE TABLE topics (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL,
  priority TEXT NOT NULL, status TEXT NOT NULL, cadenceMinutes INTEGER,
  origin TEXT NOT NULL, notifyBar TEXT NOT NULL, notes TEXT NOT NULL,
  findingsRef TEXT NOT NULL, revision INTEGER NOT NULL,
  createdAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL,
  lastCheckedAtMs INTEGER, nextDueAtMs INTEGER, lastNotifiedAtMs INTEGER,
  leaseId TEXT, leaseUntilMs INTEGER, pendingDue INTEGER NOT NULL
) STRICT;
CREATE INDEX topics_due ON topics(status, nextDueAtMs);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, minimumIntervalMinutes INTEGER NOT NULL,
  lastAttemptedAtMs INTEGER, lastFetchedAtMs INTEGER, lastStatus TEXT,
  backoffUntilMs INTEGER, leaseId TEXT, leaseUntilMs INTEGER,
  revision INTEGER NOT NULL
) STRICT;
CREATE TABLE topic_sources (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  sourceId TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY(topicId, sourceId)
) STRICT;
CREATE INDEX topic_sources_source ON topic_sources(sourceId);
PRAGMA user_version=1;
`;
const BUSY_MS = 5_000;

class Ledger {
  private readonly db;
  private readonly query;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const db = openNodeSqliteDatabase(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA foreign_keys=ON;`);
      // FULL protects acknowledged owner edits; the private directory protects WAL sidecars.
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      runSqliteImmediateTransactionSync(db, () => {
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
        if (version === 0) {
          db.exec(SCHEMA);
        } else if (version !== 1) {
          throw new Error(
            "Research ledger schema is newer than this plugin. Use the matching plugin.",
          );
        }
        if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
          throw new Error(
            "Research ledger integrity failed. Restore a verified backup before retrying.",
          );
        }
      });
      enableNodeSqliteKyselyStatementCache(db);
      this.db = db;
      this.query = getNodeSqliteKysely<LedgerDatabase>(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private topic(id: string) {
    const row = executeSqliteQuerySync(
      this.db,
      this.query.selectFrom("topics").selectAll().where("id", "=", id),
    ).rows[0];
    if (!row) {
      throw new Error(`Unknown research topic: ${id}. Use list to find its id.`);
    }
    return row;
  }

  private sources(id: string) {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("sources")
        .innerJoin("topic_sources", "topic_sources.sourceId", "sources.id")
        .selectAll("sources")
        .where("topic_sources.topicId", "=", id)
        .orderBy("sources.id"),
    ).rows;
  }

  private get(id: string) {
    return { ...this.topic(id), sources: this.sources(id) };
  }

  private expectRevision(actual: number, expected: number | undefined) {
    if (actual !== expected) {
      throw new Error("Research ledger revision changed. Read the current record before editing.");
    }
  }

  private attachSources(id: string, ids: string[]) {
    for (const sourceId of ids) {
      const source = executeSqliteQuerySync(
        this.db,
        this.query.selectFrom("sources").select("id").where("id", "=", sourceId),
      ).rows[0];
      if (!source) {
        throw new Error(`Unknown research source: ${sourceId}. Define it with source_set first.`);
      }
    }
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("topic_sources").where("topicId", "=", id),
    );
    if (ids.length > 0) {
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("topic_sources")
          .values(ids.map((sourceId) => ({ topicId: id, sourceId }))),
      );
    }
  }

  private eligible(now: number) {
    return this.query
      .selectFrom("topics")
      .where("status", "=", "active")
      .where("nextDueAtMs", "<=", now)
      .where((eb) => eb.or([eb("leaseUntilMs", "is", null), eb("leaseUntilMs", "<=", now)]))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("topic_sources as ts")
              .innerJoin("sources as s", "s.id", "ts.sourceId")
              .select("s.id")
              .whereRef("ts.topicId", "=", "topics.id")
              .where((inner) =>
                inner.or([
                  inner("s.backoffUntilMs", ">", now),
                  inner("s.leaseUntilMs", ">", now),
                  inner(
                    inner(
                      "s.lastAttemptedAtMs",
                      "+",
                      inner("s.minimumIntervalMinutes", "*", 60_000),
                    ),
                    ">",
                    now,
                  ),
                  inner(
                    inner("s.lastFetchedAtMs", "+", inner("s.minimumIntervalMinutes", "*", 60_000)),
                    ">",
                    now,
                  ),
                ]),
              ),
          ),
        ),
      );
  }

  private bump(topic: Topic, now: number, changes: Partial<Topic>) {
    executeSqliteQuerySync(
      this.db,
      this.query
        .updateTable("topics")
        .set({ ...changes, revision: topic.revision + 1, updatedAtMs: now })
        .where("id", "=", topic.id),
    );
    return this.get(topic.id);
  }

  execute(input: LedgerOperations["request"]["input"]) {
    const request = parseRequest(input.request);
    const now = input.now;
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Research ledger requires a valid server time.");
    }
    const readOnly = ["list", "get", "due", "source_list"].includes(request.action);
    const dispatch = () => this.dispatch(request, now);
    if (readOnly) {
      return runSqliteDeferredTransactionSync(this.db, dispatch);
    }
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        return dispatch();
      },
      {
        withCommit(commit) {
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          commit();
        },
      },
    );
  }

  private dispatch(request: Request, now: number): unknown {
    switch (request.action) {
      case "get":
        return this.get(request.id);
      case "list": {
        let query = this.query
          .selectFrom("topics")
          .select([
            "id",
            "title",
            "priority",
            "status",
            "cadenceMinutes",
            "origin",
            "nextDueAtMs",
            "lastCheckedAtMs",
            "revision",
          ]);
        if (request.status) {
          query = query.where("status", "=", request.status);
        }
        if (request.after) {
          query = query.where("id", ">", request.after);
        }
        const limit = request.limit ?? 20;
        const rows = executeSqliteQuerySync(this.db, query.orderBy("id").limit(limit + 1)).rows;
        return {
          topics: rows.slice(0, limit),
          nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
        };
      }
      case "source_list": {
        let query = this.query.selectFrom("sources").selectAll();
        if (request.after) {
          query = query.where("id", ">", request.after);
        }
        const limit = request.limit ?? 20;
        const rows = executeSqliteQuerySync(this.db, query.orderBy("id").limit(limit + 1)).rows;
        return {
          sources: rows.slice(0, limit),
          nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
        };
      }
      case "source_set": {
        const source = executeSqliteQuerySync(
          this.db,
          this.query.selectFrom("sources").selectAll().where("id", "=", request.id),
        ).rows[0];
        if (source) {
          this.expectRevision(source.revision, request.expectedRevision);
          executeSqliteQuerySync(
            this.db,
            this.query
              .updateTable("sources")
              .set({
                minimumIntervalMinutes: request.minimumIntervalMinutes,
                revision: source.revision + 1,
              })
              .where("id", "=", source.id),
          );
        } else {
          if (request.expectedRevision !== undefined) {
            throw new Error("Research source no longer exists. Read source_list before editing.");
          }
          const row: Source = {
            id: request.id,
            minimumIntervalMinutes: request.minimumIntervalMinutes,
            lastAttemptedAtMs: null,
            lastFetchedAtMs: null,
            lastStatus: null,
            backoffUntilMs: null,
            leaseId: null,
            leaseUntilMs: null,
            revision: 1,
          };
          executeSqliteQuerySync(this.db, this.query.insertInto("sources").values(row));
        }
        return executeSqliteQuerySync(
          this.db,
          this.query.selectFrom("sources").selectAll().where("id", "=", request.id),
        ).rows[0];
      }
      case "add": {
        const existing = executeSqliteQuerySync(
          this.db,
          this.query.selectFrom("topics").select("id").where("id", "=", request.id),
        ).rows[0];
        if (existing) {
          throw new Error("Research topic already exists. Use get/update; add never overwrites.");
        }
        const cadenceMinutes = request.cadenceMinutes === undefined ? 360 : request.cadenceMinutes;
        const row: Topic = {
          id: request.id,
          title: request.title,
          why: request.why ?? "",
          priority: request.priority ?? "normal",
          status: request.status ?? "active",
          cadenceMinutes,
          origin: request.origin ?? "owner",
          notifyBar: request.notifyBar ?? "",
          notes: request.notes ?? "",
          findingsRef: request.findingsRef ?? "",
          revision: 1,
          createdAtMs: now,
          updatedAtMs: now,
          lastCheckedAtMs: null,
          nextDueAtMs:
            request.nextDueAtMs !== undefined
              ? request.nextDueAtMs
              : cadenceMinutes === null
                ? null
                : now,
          lastNotifiedAtMs: null,
          leaseId: null,
          leaseUntilMs: null,
          pendingDue: 0,
        };
        executeSqliteQuerySync(this.db, this.query.insertInto("topics").values(row));
        this.attachSources(row.id, request.sourceIds ?? []);
        return this.get(row.id);
      }
      case "update": {
        const topic = this.topic(request.id);
        this.expectRevision(topic.revision, request.expectedRevision);
        const { sourceIds, ...changes } = request.changes;
        if (sourceIds !== undefined) {
          if ((topic.leaseUntilMs ?? 0) > now) {
            throw new Error(
              "Research is in flight. Pause now; change sources after its lease settles.",
            );
          }
          this.attachSources(topic.id, sourceIds);
        }
        if (changes.cadenceMinutes !== undefined && changes.nextDueAtMs === undefined) {
          changes.nextDueAtMs = changes.cadenceMinutes === null ? null : now;
        }
        return this.bump(topic, now, {
          ...changes,
          pendingDue:
            (topic.leaseUntilMs ?? 0) > now && changes.nextDueAtMs !== undefined
              ? 1
              : topic.pendingDue,
        });
      }
      case "remove": {
        const topic = this.topic(request.id);
        this.expectRevision(topic.revision, request.expectedRevision);
        if (!request.hardDelete) {
          return this.bump(topic, now, { status: "archived" });
        }
        if ((topic.leaseUntilMs ?? 0) > now) {
          throw new Error("Research is in flight. Archive now; delete after its lease settles.");
        }
        executeSqliteQuerySync(this.db, this.query.deleteFrom("topics").where("id", "=", topic.id));
        return { id: topic.id, deleted: true };
      }
      case "signal": {
        const topic = this.topic(request.id);
        if (topic.status !== "active") {
          throw new Error("Research topic is not active. Resume it explicitly before signaling.");
        }
        return this.bump(topic, now, {
          nextDueAtMs: now,
          pendingDue: (topic.leaseUntilMs ?? 0) > now ? 1 : 0,
        });
      }
      case "record_notification": {
        const topic = this.topic(request.id);
        if (request.confirmedAtMs < topic.createdAtMs || request.confirmedAtMs > now) {
          throw new Error(
            "Notification confirmation time must follow topic creation and not be in the future.",
          );
        }
        if (topic.lastNotifiedAtMs !== null && request.confirmedAtMs <= topic.lastNotifiedAtMs) {
          return this.get(topic.id);
        }
        return this.bump(topic, now, { lastNotifiedAtMs: request.confirmedAtMs });
      }
      case "due":
        return {
          topics: executeSqliteQuerySync(
            this.db,
            this.eligible(now)
              .select([
                "id",
                "title",
                "why",
                "priority",
                "notifyBar",
                "cadenceMinutes",
                "nextDueAtMs",
                "lastCheckedAtMs",
                "revision",
              ])
              .orderBy((eb) =>
                eb
                  .case()
                  .when("priority", "=", "high")
                  .then(0)
                  .when("priority", "=", "normal")
                  .then(1)
                  .else(2)
                  .end(),
              )
              .orderBy("nextDueAtMs")
              .orderBy("id")
              .limit(request.limit ?? 10),
          ).rows,
        };
      case "acquire": {
        const topic = executeSqliteQuerySync(
          this.db,
          this.eligible(now).selectAll("topics").where("id", "=", request.id),
        ).rows[0];
        if (!topic) {
          return { acquired: false, reason: "not-due-or-source-unavailable" };
        }
        const leaseId = randomUUID();
        const leaseUntilMs = now + (request.leaseMinutes ?? 15) * 60_000;
        for (const source of this.sources(topic.id)) {
          executeSqliteQuerySync(
            this.db,
            this.query
              .updateTable("sources")
              .set({
                leaseId,
                leaseUntilMs,
                lastAttemptedAtMs: now,
                revision: source.revision + 1,
              })
              .where("id", "=", source.id),
          );
        }
        return {
          acquired: true,
          ...this.bump(topic, now, { leaseId, leaseUntilMs, pendingDue: 0 }),
        };
      }
      case "record_check": {
        const topic = this.topic(request.id);
        if (topic.leaseId !== request.leaseId || (topic.leaseUntilMs ?? 0) <= now) {
          throw new Error(
            "Research lease expired or changed. Do not fetch again without acquiring.",
          );
        }
        const sources = this.sources(topic.id);
        const outcomes = new Map(request.sources.map((source) => [source.id, source]));
        if (
          outcomes.size !== request.sources.length ||
          sources.length !== outcomes.size ||
          sources.some((source) => !outcomes.has(source.id))
        ) {
          throw new Error("Record exactly one outcome for every source from acquire.");
        }
        for (const source of sources) {
          if (source.leaseId !== request.leaseId) {
            throw new Error("Research source lease changed. Read the ledger before continuing.");
          }
          const outcome = outcomes.get(source.id)!;
          let backoffMinutes =
            outcome.retryAfterMinutes ??
            (outcome.outcome === "throttled"
              ? Math.max(30, source.minimumIntervalMinutes)
              : outcome.outcome === "error"
                ? Math.max(5, source.minimumIntervalMinutes)
                : 0);
          if (outcome.outcome === "throttled" || outcome.outcome === "error") {
            backoffMinutes = Math.max(backoffMinutes, source.minimumIntervalMinutes);
          }
          executeSqliteQuerySync(
            this.db,
            this.query
              .updateTable("sources")
              .set({
                lastStatus: outcome.outcome,
                lastFetchedAtMs: outcome.outcome === "ok" ? now : source.lastFetchedAtMs,
                backoffUntilMs: backoffMinutes > 0 ? now + backoffMinutes * 60_000 : null,
                leaseId: null,
                leaseUntilMs: null,
                revision: source.revision + 1,
              })
              .where("id", "=", source.id),
          );
        }
        return this.bump(topic, now, {
          lastCheckedAtMs: now,
          nextDueAtMs: topic.pendingDue
            ? topic.nextDueAtMs
            : request.nextDueAtMs !== undefined
              ? request.nextDueAtMs
              : topic.cadenceMinutes === null
                ? null
                : now + topic.cadenceMinutes * 60_000,
          leaseId: null,
          leaseUntilMs: null,
          pendingDue: 0,
        });
      }
    }
  }
}

export function createSqliteWorkerBackend(
  _input: unknown,
  context: { databasePath: string },
): SqliteWorkerBackend<LedgerOperations> {
  const ledger = new Ledger(context.databasePath);
  return {
    execute: (command) => ledger.execute(command.input),
    close: () => ledger.close(),
  };
}
