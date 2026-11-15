import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  type openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { LedgerDatabase, SessionRef, Topic } from "./schema.js";

type TopicLinks = {
  aliases: string[];
  tags: string[];
  sessionRefs: SessionRef[];
  sourceIds: string[];
};

export function unionLinks(...links: Partial<TopicLinks>[]): TopicLinks {
  const strings = (key: "aliases" | "tags" | "sourceIds") =>
    [...new Set(links.flatMap((item) => item[key] ?? []))].toSorted();
  const sessions = new Map<string, SessionRef>();
  for (const ref of links.flatMap((item) => item.sessionRefs ?? [])) {
    const key = JSON.stringify([ref.sessionKey, ref.sessionId, ref.messageId ?? ""]);
    sessions.set(key, ref);
  }
  return {
    aliases: strings("aliases"),
    tags: strings("tags"),
    sourceIds: strings("sourceIds"),
    sessionRefs: [...sessions.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([, ref]) => ref),
  };
}

export const summaryColumns = [
  "topics.id",
  "topics.title",
  "topics.why",
  "topics.notes",
  "topics.priority",
  "topics.purpose",
  "topics.workState",
  "topics.status",
  "topics.origin",
  "topics.notifyBar",
  "topics.nextDueAtMs",
  "topics.lastCheckedAtMs",
  "topics.revision",
  "topics.serviceCount",
  "topics.waitingSinceMs",
] as const;

export class Records {
  readonly query;

  constructor(readonly db: ReturnType<typeof openNodeSqliteDatabase>) {
    this.query = getNodeSqliteKysely<LedgerDatabase>(db);
  }

  findTopic(id: string) {
    return executeSqliteQuerySync(
      this.db,
      this.query.selectFrom("topics").selectAll().where("id", "=", id),
    ).rows[0];
  }

  topic(id: string) {
    const row = this.findTopic(id);
    if (!row) {
      throw new Error(`Unknown research topic: ${id}. Use lookup to find its id.`);
    }
    return row;
  }

  source(id: string) {
    const row = executeSqliteQuerySync(
      this.db,
      this.query.selectFrom("sources").selectAll().where("id", "=", id),
    ).rows[0];
    if (!row) {
      throw new Error(`Unknown research source: ${id}. Define it with source_set first.`);
    }
    return row;
  }

  sources(id: string) {
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

  links(id: string): TopicLinks {
    return {
      aliases: executeSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("topic_aliases")
          .select("alias")
          .where("topicId", "=", id)
          .orderBy("alias"),
      ).rows.map((row) => row.alias),
      tags: executeSqliteQuerySync(
        this.db,
        this.query.selectFrom("topic_tags").select("tag").where("topicId", "=", id).orderBy("tag"),
      ).rows.map((row) => row.tag),
      sourceIds: executeSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("topic_sources")
          .select("sourceId")
          .where("topicId", "=", id)
          .orderBy("sourceId"),
      ).rows.map((row) => row.sourceId),
      sessionRefs: executeSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("topic_sessions")
          .select(["sessionKey", "sessionId", "messageId"])
          .where("topicId", "=", id)
          .orderBy("sessionKey")
          .orderBy("sessionId")
          .orderBy("messageId"),
      ).rows.map((row) => {
        const ref: SessionRef = { sessionKey: row.sessionKey, sessionId: row.sessionId };
        if (row.messageId) {
          ref.messageId = row.messageId;
        }
        return ref;
      }),
    };
  }

  destinations(id: string) {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("completion_destinations")
        .selectAll()
        .where("topicId", "=", id)
        .orderBy("destinationId"),
    ).rows;
  }

  get(id: string) {
    const topic = this.topic(id);
    return {
      ...topic,
      ...this.links(id),
      sources: this.sources(id),
      destinations: this.destinations(id).map(({ receiptJson, ...destination }) => {
        const receipt: unknown = receiptJson === null ? null : JSON.parse(receiptJson);
        return Object.assign(destination, { receipt });
      }),
    };
  }

  expectRevision(topic: { revision: number }, expected: number | undefined) {
    if (topic.revision !== expected) {
      throw new Error("Research ledger revision changed. Reread and reconcile before editing.");
    }
  }

  active(topic: Topic) {
    if (topic.status !== "active") {
      throw new Error(
        "Research completion is pending. Content is frozen; explicitly reopen for an owner correction, confirm/finalize, or explicitly forget.",
      );
    }
  }

  setLinks(id: string, input: Partial<TopicLinks>) {
    const links = unionLinks(input);
    if (input.sourceIds !== undefined) {
      for (const sourceId of links.sourceIds) {
        this.source(sourceId);
      }
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("topic_sources").where("topicId", "=", id),
      );
      if (links.sourceIds.length) {
        executeSqliteQuerySync(
          this.db,
          this.query
            .insertInto("topic_sources")
            .values(links.sourceIds.map((sourceId) => ({ topicId: id, sourceId }))),
        );
      }
    }
    if (input.aliases !== undefined) {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("topic_aliases").where("topicId", "=", id),
      );
      if (links.aliases.length) {
        executeSqliteQuerySync(
          this.db,
          this.query
            .insertInto("topic_aliases")
            .values(links.aliases.map((alias) => ({ topicId: id, alias }))),
        );
      }
    }
    if (input.tags !== undefined) {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("topic_tags").where("topicId", "=", id),
      );
      if (links.tags.length) {
        executeSqliteQuerySync(
          this.db,
          this.query
            .insertInto("topic_tags")
            .values(links.tags.map((tag) => ({ topicId: id, tag }))),
        );
      }
    }
    if (input.sessionRefs !== undefined) {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("topic_sessions").where("topicId", "=", id),
      );
      if (links.sessionRefs.length) {
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("topic_sessions").values(
            links.sessionRefs.map(({ sessionKey, sessionId, messageId }) => ({
              topicId: id,
              sessionKey,
              sessionId,
              messageId: messageId ?? "",
            })),
          ),
        );
      }
    }
  }

  index(id: string) {
    const topic = this.topic(id);
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("topic_search").where("topicId", "=", id),
    );
    executeSqliteQuerySync(
      this.db,
      this.query.insertInto("topic_search").values({
        topicId: id,
        title: topic.title,
        aliases: this.links(id).aliases.join("\n"),
        summary: `${topic.why}\n${topic.notes}`,
      }),
    );
  }

  bump(topic: Topic, now: number, changes: Partial<Topic>) {
    executeSqliteQuerySync(
      this.db,
      this.query
        .updateTable("topics")
        .set({ ...changes, revision: topic.revision + 1, updatedAtMs: now })
        .where("id", "=", topic.id),
    );
    this.index(topic.id);
    return this.get(topic.id);
  }

  delete(id: string) {
    executeSqliteQuerySync(this.db, this.query.deleteFrom("topics").where("id", "=", id));
    return { id, deleted: true };
  }

  eligible(now: number) {
    return this.query
      .selectFrom("topics")
      .where("status", "=", "active")
      .where((eb) =>
        eb.or([
          eb("workState", "=", "ready"),
          eb.and([eb("workState", "=", "monitoring"), eb("nextDueAtMs", "<=", now)]),
        ]),
      )
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

  newTopicRound(now: number) {
    const first = executeSqliteQuerySync(
      this.db,
      this.eligible(now).select("serviceCount").orderBy("serviceCount").limit(1),
    ).rows[0];
    return first ? first.serviceCount + 1 : 0;
  }
}
