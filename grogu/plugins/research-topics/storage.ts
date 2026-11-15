import type { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";

type Database = ReturnType<typeof openNodeSqliteDatabase>;

const TOPICS = `
CREATE TABLE topics (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, why TEXT NOT NULL,
  notes TEXT NOT NULL, findingsRef TEXT NOT NULL, priority TEXT NOT NULL,
  purpose TEXT NOT NULL, workState TEXT NOT NULL, status TEXT NOT NULL,
  completionRule TEXT, monitoringReason TEXT NOT NULL,
  origin TEXT NOT NULL, notifyBar TEXT NOT NULL, revision INTEGER NOT NULL,
  createdAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL,
  lastCheckedAtMs INTEGER, nextDueAtMs INTEGER, lastNotifiedAtMs INTEGER,
  serviceCount INTEGER NOT NULL CHECK(serviceCount >= 0), waitingSinceMs INTEGER NOT NULL,
  lastCheckOperationId TEXT, lastCheckFingerprint TEXT,
  completionId TEXT, completionReason TEXT, ownerText TEXT, completedAtMs INTEGER
) STRICT;
CREATE INDEX topics_due ON topics(status, workState, serviceCount, priority, waitingSinceMs, id);
CREATE TABLE topic_sources (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  sourceId TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY(topicId, sourceId)
) STRICT;
CREATE INDEX topic_sources_source ON topic_sources(sourceId, topicId);
CREATE TABLE topic_aliases (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  alias TEXT NOT NULL, PRIMARY KEY(topicId, alias)
) STRICT;
CREATE TABLE topic_tags (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, PRIMARY KEY(topicId, tag)
) STRICT;
CREATE INDEX topic_tags_lookup ON topic_tags(tag, topicId);
CREATE TABLE topic_sessions (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  sessionKey TEXT NOT NULL, sessionId TEXT NOT NULL, messageId TEXT NOT NULL,
  PRIMARY KEY(topicId, sessionKey, sessionId, messageId)
) STRICT;
CREATE INDEX topic_sessions_lookup ON topic_sessions(sessionKey, topicId);
CREATE TABLE completion_destinations (
  topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  destinationId TEXT NOT NULL, kind TEXT NOT NULL, sessionKey TEXT NOT NULL,
  sessionId TEXT NOT NULL, receiptJson TEXT,
  PRIMARY KEY(topicId, destinationId)
) STRICT;
CREATE VIRTUAL TABLE topic_search USING fts5(
  topicId UNINDEXED, title, aliases, summary, tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER topics_delete_search AFTER DELETE ON topics BEGIN
  DELETE FROM topic_search WHERE topicId = old.id;
END;
`;
const SOURCES = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY, minimumIntervalMinutes INTEGER NOT NULL,
  lastAttemptedAtMs INTEGER, lastFetchedAtMs INTEGER, lastStatus TEXT,
  backoffUntilMs INTEGER, attemptId TEXT, lastResultFingerprint TEXT,
  revision INTEGER NOT NULL
) STRICT;
`;

// Called once, inside the connection's admission transaction. DDL and migration roll back together.
export function initializeLedgerDatabase(db: Database, now: number) {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version > 2) {
    throw new Error("Research ledger schema is newer than this plugin. Use the matching plugin.");
  }
  if (version === 0) {
    db.exec(SOURCES + TOPICS);
  } else if (version === 1) {
    if (db.prepare("SELECT 1 FROM topics WHERE leaseUntilMs > ? LIMIT 1").get(now)) {
      throw new Error(
        "Research schema migration refused: a live topic lease exists. Let v1 work settle, stop v1, then retry.",
      );
    }
    db.exec(`
      ALTER TABLE topic_sources RENAME TO legacy_topic_sources;
      ALTER TABLE topics RENAME TO legacy_topics;
      ALTER TABLE sources RENAME TO legacy_sources;
      DROP INDEX topics_due;
      DROP INDEX topic_sources_source;
    `);
    db.exec(SOURCES + TOPICS);
    db.exec(`
      INSERT INTO sources
        (id, minimumIntervalMinutes, lastAttemptedAtMs, lastFetchedAtMs,
         lastStatus, backoffUntilMs, attemptId, lastResultFingerprint, revision)
      SELECT id, minimumIntervalMinutes, lastAttemptedAtMs, lastFetchedAtMs, lastStatus,
        CASE WHEN backoffUntilMs IS NULL AND leaseUntilMs IS NULL THEN NULL
             ELSE max(coalesce(backoffUntilMs, 0), coalesce(leaseUntilMs, 0)) END,
        NULL, NULL, revision + 1
      FROM legacy_sources;
      INSERT INTO topics
        (id, title, brief, why, notes, findingsRef, priority, purpose, workState, status,
         completionRule, monitoringReason, origin, notifyBar, revision, createdAtMs,
         updatedAtMs, lastCheckedAtMs, nextDueAtMs, lastNotifiedAtMs, serviceCount,
         waitingSinceMs)
      SELECT id, title,
        trim(why || char(10) || notes || char(10) || findingsRef) ||
          char(10) || 'Legacy timing (not a watch instruction): cadenceMinutes=' ||
          coalesce(cast(cadenceMinutes AS TEXT), 'null') || ', nextDueAtMs=' ||
          coalesce(cast(nextDueAtMs AS TEXT), 'null') ||
          '. Reconcile purpose and completion rule.',
        why, notes, findingsRef, priority, 'decision',
        CASE WHEN status = 'paused' THEN 'waiting' ELSE 'ready' END,
        'active', NULL, '', origin, notifyBar, revision + 1, createdAtMs, updatedAtMs,
        lastCheckedAtMs, NULL, lastNotifiedAtMs, 0, coalesce(lastCheckedAtMs, createdAtMs)
      FROM legacy_topics WHERE status NOT IN ('done', 'archived');
      INSERT INTO topic_sources
      SELECT l.topicId, l.sourceId FROM legacy_topic_sources l
      JOIN topics t ON t.id = l.topicId;
      INSERT INTO topic_search(topicId, title, aliases, summary)
      SELECT id, title, '', why || char(10) || notes FROM topics;
      DROP TABLE legacy_topic_sources;
      DROP TABLE legacy_topics;
      DROP TABLE legacy_sources;
    `);
  } else if (version !== 2) {
    throw new Error("Unsupported research ledger schema. Use a compatible forward repair.");
  }
  if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
    throw new Error("Research ledger integrity failed. Stop writes and arrange a forward repair.");
  }
  if (db.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("Research ledger links failed integrity checks. Arrange a forward repair.");
  }
  db.exec("PRAGMA user_version=2;");
}
