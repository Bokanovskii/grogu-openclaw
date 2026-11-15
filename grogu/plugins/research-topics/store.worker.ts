import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  openNodeSqliteDatabase,
  requestSqliteWorkerOperationAdmission,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { handleCompletion } from "./completion.js";
import { Records, summaryColumns, unionLinks } from "./records.js";
import {
  parseRequest,
  type LedgerOperations,
  type Request,
  type SessionRef,
  type Source,
  type Topic,
} from "./schema.js";
import { initializeLedgerDatabase } from "./storage.js";

type Schedule = Pick<Topic, "workState" | "monitoringReason" | "nextDueAtMs">;

function schedule(topic: Schedule, changes: Partial<Schedule>): Schedule {
  const state = changes.workState ?? topic.workState;
  if (state !== "monitoring") {
    if (changes.nextDueAtMs != null || (changes.monitoringReason ?? "").trim()) {
      throw new Error(
        'A due time or monitoringReason needs workState "monitoring" in the same call. ' +
          "Add workState monitoring to schedule a recheck, or remove nextDueAtMs and monitoringReason.",
      );
    }
    return { workState: state, monitoringReason: "", nextDueAtMs: null };
  }
  const reason = changes.monitoringReason ?? topic.monitoringReason;
  const due = changes.nextDueAtMs === undefined ? topic.nextDueAtMs : changes.nextDueAtMs;
  if (!reason.trim() || due === null) {
    throw new Error("Monitoring/retry requires an actual monitoringReason and nextDueAtMs.");
  }
  return { workState: state, monitoringReason: reason, nextDueAtMs: due };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function authorizedSessions(
  existing: SessionRef[],
  requested: SessionRef[] | undefined,
  caller: LedgerOperations["request"]["input"]["caller"],
) {
  for (const ref of requested ?? []) {
    const retained = existing.some(
      (old) =>
        old.sessionKey === ref.sessionKey &&
        old.sessionId === ref.sessionId &&
        old.messageId === ref.messageId,
    );
    if (
      !retained &&
      (!caller || ref.sessionKey !== caller.sessionKey || ref.sessionId !== caller.sessionId)
    ) {
      throw new Error(
        "New session references must match the current caller's sessionKey and sessionId.",
      );
    }
  }
  return unionLinks({ sessionRefs: existing }, { sessionRefs: requested }).sessionRefs;
}

class Ledger {
  private readonly records;

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const db = openNodeSqliteDatabase(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      runSqliteImmediateTransactionSync(db, () => initializeLedgerDatabase(db, Date.now()));
      enableNodeSqliteKyselyStatementCache(db);
      this.records = new Records(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.records.db.close();
  }

  publication(input: LedgerOperations["publication"]["input"]) {
    return runSqliteDeferredTransactionSync(this.records.db, () => {
      const topic = this.records.get(input.id);
      this.records.expectRevision(topic, input.expectedRevision);
      return topic;
    });
  }

  execute(input: LedgerOperations["request"]["input"]) {
    const request = parseRequest(input.request);
    const now = input.now;
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Research ledger requires a valid server time.");
    }
    const dispatch = () => this.dispatch(request, now, input);
    if (["list", "get", "lookup", "due", "source_list"].includes(request.action)) {
      return runSqliteDeferredTransactionSync(this.records.db, dispatch);
    }
    return runSqliteImmediateTransactionSync(
      this.records.db,
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

  matchMessage(input: LedgerOperations["matchMessage"]["input"]) {
    const r = this.records;
    return runSqliteDeferredTransactionSync(r.db, () => {
      const topics = executeSqliteQuerySync(
        r.db,
        r.query
          .selectFrom("topics")
          .innerJoin("completion_destinations as d", "d.topicId", "topics.id")
          .select(["topics.id", "topics.revision", "topics.completionId"])
          .where("topics.status", "=", "completion_pending")
          .where("topics.ownerText", "=", input.ownerText)
          .where("d.kind", "=", "main")
          .where("d.sessionKey", "=", input.caller.sessionKey)
          .where("d.sessionId", "=", input.caller.sessionId)
          .limit(2),
      ).rows;
      const topic = topics[0];
      if (!topic?.completionId || topics.length !== 1) {
        return undefined;
      }
      return { id: topic.id, expectedRevision: topic.revision, completionId: topic.completionId };
    });
  }

  private dispatch(
    request: Request,
    now: number,
    evidence: LedgerOperations["request"]["input"],
  ): unknown {
    const { caller } = evidence;
    const r = this.records;
    const { db, query } = r;
    switch (request.action) {
      case "get":
        return r.get(request.id);
      case "lookup": {
        const terms = [...new Set(request.query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])]
          .slice(0, 16)
          .map((word) => `"${word}"`)
          .join(" OR ");
        let candidates = query.selectFrom("topics").select(summaryColumns);
        if (request.sessionKey) {
          candidates = candidates.where((eb) =>
            eb.exists(
              eb
                .selectFrom("topic_sessions")
                .select("topicId")
                .whereRef("topicId", "=", "topics.id")
                .where("sessionKey", "=", request.sessionKey!),
            ),
          );
        }
        if (request.category) {
          candidates = candidates.where((eb) =>
            eb.exists(
              eb
                .selectFrom("topic_tags")
                .select("topicId")
                .whereRef("topicId", "=", "topics.id")
                .where("tag", "=", request.category!),
            ),
          );
        }
        const exact = executeSqliteQuerySync(
          db,
          candidates.where("topics.id", "=", request.query),
        ).rows;
        if (exact.length) {
          return { topics: exact, match: "id" };
        }
        if (!terms) {
          return { topics: [], match: "terms" };
        }
        const rows = executeSqliteQuerySync(
          db,
          candidates
            .innerJoin("topic_search", "topic_search.topicId", "topics.id")
            .where("topic_search.topic_search", "match", terms)
            .orderBy("topic_search.rank")
            .orderBy("topics.id")
            .limit(request.limit ?? 8),
        ).rows;
        return { topics: rows, match: "terms" };
      }
      case "list": {
        let listing = query.selectFrom("topics").select(summaryColumns);
        if (request.status) {
          listing = listing.where("status", "=", request.status);
        }
        if (request.after) {
          listing = listing.where("id", ">", request.after);
        }
        const limit = request.limit ?? 20;
        const rows = executeSqliteQuerySync(db, listing.orderBy("id").limit(limit + 1)).rows;
        return {
          topics: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]?.id : null,
        };
      }
      case "due": {
        let due = r.eligible(now);
        if (request.category) {
          due = due.where((eb) =>
            eb.exists(
              eb
                .selectFrom("topic_tags")
                .select("topicId")
                .whereRef("topicId", "=", "topics.id")
                .where("tag", "=", request.category!),
            ),
          );
        }
        const topics = executeSqliteQuerySync(
          db,
          due
            .select(summaryColumns)
            .orderBy("serviceCount")
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
            .orderBy("waitingSinceMs")
            .orderBy("id")
            .limit(request.limit ?? 10),
        ).rows;
        return {
          topics: topics.map((topic) =>
            Object.assign(topic, {
              score: {
                round: topic.serviceCount,
                priority: topic.priority,
                waitingSinceMs: topic.waitingSinceMs,
                tieBreak: topic.id,
              },
            }),
          ),
        };
      }
      case "add": {
        if (r.findTopic(request.id)) {
          throw new Error("Research topic already exists. Use get/update; add never overwrites.");
        }
        const row: Topic = {
          id: request.id,
          title: request.title,
          brief: request.brief ?? "",
          why: request.why ?? "",
          notes: request.notes ?? "",
          findingsRef: request.findingsRef ?? "",
          priority: request.priority ?? "normal",
          purpose: request.purpose ?? "decision",
          ...schedule({ workState: "ready", monitoringReason: "", nextDueAtMs: null }, request),
          status: "active",
          completionRule: request.completionRule ?? null,
          origin: request.origin ?? "owner",
          notifyBar: request.notifyBar ?? "",
          revision: 1,
          createdAtMs: now,
          updatedAtMs: now,
          lastCheckedAtMs: null,
          lastNotifiedAtMs: null,
          serviceCount: r.newTopicRound(now),
          waitingSinceMs: now,
          lastCheckOperationId: null,
          lastCheckFingerprint: null,
          completionId: null,
          completionReason: null,
          ownerText: null,
          completedAtMs: null,
        };
        executeSqliteQuerySync(db, query.insertInto("topics").values(row));
        r.setLinks(row.id, {
          ...request,
          sessionRefs: authorizedSessions(
            [],
            request.sessionRefs ?? (request.origin !== "automation" && caller ? [caller] : []),
            caller,
          ),
        });
        r.index(row.id);
        return r.get(row.id);
      }
      case "update":
      case "merge": {
        const topic = r.topic(request.id);
        r.expectRevision(topic, request.expectedRevision);
        r.active(topic);
        const { aliases, tags, sourceIds, sessionRefs, ...changes } = request.changes;
        const existing = r.links(topic.id);
        let links = { aliases, tags, sourceIds, sessionRefs };
        let merged: Topic | undefined;
        if (request.action === "merge") {
          if (request.id === request.sourceId) {
            throw new Error("Merge requires two different topic ids.");
          }
          merged = r.topic(request.sourceId);
          r.expectRevision(merged, request.sourceRevision);
          r.active(merged);
          const retained = unionLinks(existing, r.links(merged.id));
          links = unionLinks(retained, {
            ...links,
            sessionRefs: authorizedSessions(retained.sessionRefs, sessionRefs, caller),
          });
        } else {
          links.sessionRefs = authorizedSessions(existing.sessionRefs, sessionRefs, caller);
        }
        parseRequest({
          action: "update",
          id: topic.id,
          expectedRevision: topic.revision,
          changes: { ...changes, ...unionLinks(links) },
        });
        const scheduling = schedule(topic, changes);
        r.setLinks(topic.id, links);
        const result = r.bump(topic, now, {
          ...changes,
          ...scheduling,
          waitingSinceMs: scheduling.workState !== topic.workState ? now : topic.waitingSinceMs,
          ...(merged ? { serviceCount: Math.max(topic.serviceCount, merged.serviceCount) } : {}),
        });
        if (merged) {
          r.delete(merged.id);
          return { ...result, mergedId: merged.id, affectedSessionRefs: result.sessionRefs };
        }
        return result;
      }
      case "reopen": {
        const topic = r.topic(request.id);
        r.expectRevision(topic, request.expectedRevision);
        if (topic.status !== "completion_pending") {
          throw new Error("Research topic is not pending completion. Use update for active work.");
        }
        executeSqliteQuerySync(
          db,
          query.deleteFrom("completion_destinations").where("topicId", "=", topic.id),
        );
        return r.bump(topic, now, {
          status: "active",
          workState: "ready",
          monitoringReason: "",
          nextDueAtMs: null,
          waitingSinceMs: now,
          completionId: null,
          completionReason: null,
          ownerText: null,
          completedAtMs: null,
        });
      }
      case "forget": {
        const topic = r.topic(request.id);
        r.expectRevision(topic, request.expectedRevision);
        return r.delete(topic.id);
      }
      case "record_check": {
        const topic = r.topic(request.id);
        r.active(topic);
        const signature = fingerprint([
          request.expectedRevision,
          request.workState ?? null,
          request.monitoringReason ?? null,
          request.nextDueAtMs === undefined ? "unset" : request.nextDueAtMs,
        ]);
        if (topic.lastCheckOperationId === request.operationId) {
          if (topic.lastCheckFingerprint !== signature) {
            throw new Error("Research operationId was already used with different check facts.");
          }
          return { ...r.get(topic.id), replayed: true };
        }
        r.expectRevision(topic, request.expectedRevision);
        const next = schedule(
          { workState: "ready", monitoringReason: "", nextDueAtMs: null },
          request,
        );
        executeSqliteQuerySync(
          db,
          query
            .updateTable("topics")
            .set({
              ...next,
              lastCheckedAtMs: now,
              serviceCount: topic.serviceCount + 1,
              waitingSinceMs: now,
              lastCheckOperationId: request.operationId,
              lastCheckFingerprint: signature,
            })
            .where("id", "=", topic.id),
        );
        return r.get(topic.id);
      }
      case "source_list": {
        let sources = query.selectFrom("sources").selectAll();
        if (request.after) {
          sources = sources.where("id", ">", request.after);
        }
        const limit = request.limit ?? 20;
        const rows = executeSqliteQuerySync(db, sources.orderBy("id").limit(limit + 1)).rows;
        return {
          sources: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]?.id : null,
        };
      }
      case "source_set": {
        const source = executeSqliteQuerySync(
          db,
          query.selectFrom("sources").selectAll().where("id", "=", request.id),
        ).rows[0];
        if (source) {
          r.expectRevision(source, request.expectedRevision);
          executeSqliteQuerySync(
            db,
            query
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
            attemptId: null,
            lastResultFingerprint: null,
            revision: 1,
          };
          executeSqliteQuerySync(db, query.insertInto("sources").values(row));
        }
        return r.source(request.id);
      }
      case "source_attempt": {
        const source = r.source(request.id);
        const nextAllowedAtMs = Math.max(
          source.backoffUntilMs ?? 0,
          source.lastAttemptedAtMs === null
            ? 0
            : source.lastAttemptedAtMs + source.minimumIntervalMinutes * 60_000,
          source.lastFetchedAtMs === null
            ? 0
            : source.lastFetchedAtMs + source.minimumIntervalMinutes * 60_000,
        );
        if (nextAllowedAtMs > now) {
          return { allowed: false, id: source.id, nextAllowedAtMs, reason: "source-cooldown" };
        }
        executeSqliteQuerySync(
          db,
          query
            .updateTable("sources")
            .set({
              attemptId: randomUUID(),
              lastAttemptedAtMs: now,
              lastResultFingerprint: null,
              revision: source.revision + 1,
            })
            .where("id", "=", source.id),
        );
        return { allowed: true, ...r.source(source.id) };
      }
      case "source_result": {
        const source = r.source(request.id);
        if (source.attemptId !== request.attemptId) {
          throw new Error("Research source attempt changed. Do not overwrite its newer result.");
        }
        const signature = fingerprint([request.outcome, request.retryAfterMinutes ?? null]);
        if (source.lastResultFingerprint !== null) {
          if (source.lastResultFingerprint !== signature) {
            throw new Error("Research source attempt already has a different result.");
          }
          return { ...source, replayed: true };
        }
        const failure = request.outcome === "throttled" || request.outcome === "error";
        const backoffMinutes = Math.max(
          request.retryAfterMinutes ??
            (request.outcome === "throttled" ? 30 : request.outcome === "error" ? 5 : 0),
          failure ? source.minimumIntervalMinutes : 0,
        );
        executeSqliteQuerySync(
          db,
          query
            .updateTable("sources")
            .set({
              lastStatus: request.outcome,
              lastFetchedAtMs: request.outcome === "ok" ? now : source.lastFetchedAtMs,
              backoffUntilMs:
                backoffMinutes > 0
                  ? Math.max(source.backoffUntilMs ?? 0, now + backoffMinutes * 60_000)
                  : source.backoffUntilMs,
              lastResultFingerprint: signature,
              revision: source.revision + 1,
            })
            .where("id", "=", source.id),
        );
        return r.source(source.id);
      }
      case "complete":
      case "prepare_text":
      case "post_update":
      case "confirm_completion":
      case "finalize":
        return handleCompletion(r, request, now, evidence);
      case "notify_main":
        throw new Error("Main handoffs require the registered Research Topics tool.");
      default:
        throw new Error("Unsupported research request.");
    }
  }
}

export function createSqliteWorkerBackend(
  _input: unknown,
  context: { databasePath: string },
): SqliteWorkerBackend<LedgerOperations> {
  const ledger = new Ledger(context.databasePath);
  return {
    execute: (command) => {
      if (command.type === "publication") {
        return ledger.publication(command.input);
      }
      return command.type === "matchMessage"
        ? ledger.matchMessage(command.input)
        : ledger.execute(command.input);
    },
    close: () => ledger.close(),
  };
}
