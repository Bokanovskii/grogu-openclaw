// Transcript search over per-agent rows. Unencrypted appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  getSqliteReadOperationRevision,
  runSqliteReadOperationSync,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { hasSqliteStorageValueEncryption } from "../../storage/sqlite-encryption.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { extractTranscriptIndexEntry } from "./session-transcript-projection-append.js";
import { readSessionTranscriptIndexStatus } from "./session-transcript-projection-writer.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchReadResult,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import { transcriptSearchLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { readTranscriptPayload, type TranscriptPayloadRecord } from "./transcript-payload.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;
const ENCRYPTED_SEARCH_MAX_ROWS = 4_000;
const ENCRYPTED_SEARCH_MAX_BYTES = 4 * 1024 * 1024;
// SQLite data_version values are comparable only on the same live connection.
const searchConnections = new WeakMap<DatabaseSync, string>();

function readSearchRevision(database: DatabaseSync): string | undefined {
  return runSqliteReadOperationSync(database, () => {
    const revision = getSqliteReadOperationRevision(database);
    if (!revision) {
      return undefined;
    }
    let connection = searchConnections.get(database);
    if (!connection) {
      connection = randomUUID();
      searchConnections.set(database, connection);
      const unregister = registerNodeSqliteDisposeCallback(database, () => {
        searchConnections.delete(database);
        unregister();
      });
    }
    return `${connection}:${revision.schema.revision}:${revision.dataVersion}:${revision.mutationRevision}`;
  });
}

/** A later clean status certifies hits only while their reader's snapshot is unchanged. */
export function isSessionTranscriptSearchCurrentSync(
  revision: string,
  options: OpenClawAgentDatabaseOptions,
): boolean {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSearchRevision(database.db) === revision,
    options,
  );
  return result.found && result.value;
}

function toFtsQuery(query: string, match: SessionTranscriptSearchParams["match"]): string {
  return query
    .split(/\s+/u)
    .map(
      (token, index, tokens) =>
        `"${token.replaceAll('"', '""')}"${match === "prefix" && index === tokens.length - 1 ? "*" : ""}`,
    )
    .join(" AND ");
}

function searchWords(text: string) {
  return Array.from(text.matchAll(/[\p{L}\p{N}\p{Co}\p{M}]+/gu), (word) => ({
    value: word[0].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(),
    offset: word.index,
  })).filter((word) => word.value.length > 0);
}

function encryptedSearchSnippet(
  text: string,
  terms: string[][],
  match: SessionTranscriptSearchParams["match"],
): string | undefined {
  if (!terms.length) {
    return undefined;
  }
  const words = searchWords(text);
  let firstOffset = text.length;
  for (const [termIndex, term] of terms.entries()) {
    const matchedWord = words.find((_, index) =>
      term.every((value, part) => {
        const candidate = words[index + part]?.value;
        return match === "prefix" && termIndex === terms.length - 1 && part === term.length - 1
          ? candidate?.startsWith(value)
          : candidate === value;
      }),
    );
    if (!matchedWord) {
      return undefined;
    }
    firstOffset = Math.min(firstOffset, matchedWord.offset);
  }
  const prefix = firstOffset > 0 ? "…" : "";
  const tail = text.slice(firstOffset);
  const budget = SEARCH_SNIPPET_MAX_CHARS - prefix.length;
  return tail.length > budget
    ? `${prefix}${truncateUtf16Safe(tail, budget - 1)}…`
    : `${prefix}${tail}`;
}

/** Query a captured disk owner off-thread; reconciliation remains host-owned. */
export async function searchSessionTranscripts(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: { agentId: string; path: string },
  incognito?: IncognitoSessionHistoryBinding,
): Promise<SessionTranscriptSearchResult> {
  validateSearchQuery(params.query);
  const shared = incognito
    ? undefined
    : captureIncognitoSessionBinding({
        ...params,
        storePath: preparedDatabase?.path ?? params.storePath,
      });
  const binding: Pick<IncognitoSessionHistoryBinding, "actor" | "authority"> | undefined =
    incognito ??
    (shared && {
      actor: shared.actor,
      authority: {
        assertCurrent() {
          shared.admissionSignal?.throwIfAborted();
          shared.actor.assertReadable();
        },
      },
    });
  if (binding) {
    if (
      incognito &&
      params.sessionKeys &&
      (params.sessionKeys.length !== 1 || params.sessionKeys[0] !== incognito.target.sessionKey)
    ) {
      throw new Error("Incognito search requires its captured session selection");
    }
    const prepared =
      incognito &&
      prepareIncognitoSessionHistoryRead(incognito, {
        ...params,
        sessionId: params.sessionId ?? incognito.target.sessionId,
        storePath: preparedDatabase?.path ?? params.storePath,
      });
    const { actor, authority } = prepared ?? binding;
    const selected = new Set(params.sessionKeys);
    const currentSelection = () =>
      actor.sessions
        .deadlines()
        .filter(({ sessionKey }) => !selected.size || selected.has(sessionKey));
    const sessions = prepared
      ? [prepared.target]
      : currentSelection().map(({ sessionKey, sessionId }) => ({
          sessionKey,
          sessionId,
          lifecycleRevision: actor.sessions.readSharing(sessionKey)?.entry?.lifecycleRevision,
        }));
    const claims = new Map(
      sessions.map(({ sessionKey }) => [sessionKey, actor.sessions.captureCurrent(sessionKey)]),
    );
    const snapshots = new Map<string, ReturnType<typeof actor.sessions.captureSnapshot>>();
    const assertCurrent = () => {
      authority.assertCurrent();
      actor.assertReadable();
      if (!prepared) {
        const current = currentSelection();
        if (
          current.length !== claims.size ||
          current.some(({ sessionKey }) => !claims.has(sessionKey))
        ) {
          throw new Error("Incognito search selection changed during preparation");
        }
      }
      for (const [key, claim] of claims) {
        claim.assertCurrent();
        snapshots.get(key)?.assertCurrent();
      }
    };
    const selection = {
      sessions,
      sessionId: prepared ? (params.sessionId ?? prepared.target.sessionId) : params.sessionId,
      query: params.query,
      limit: params.limit,
      match: params.match,
      role: params.role,
      order: params.order,
    };
    assertCurrent();
    const projection = { actor, authority: binding.authority };
    const database = captureLifecycleDatabaseScope({
      agentId: actor.agentId,
      path: actor.path,
      env: params.env,
    });
    const result = await actor.sessions.withSharedState(() =>
      actor.sessions.history(
        { assertCurrent, authorize: (stage, facts) => authority.authorize?.(stage, facts) },
        { type: "session.history.search", input: selection },
        undefined,
        () => {
          for (const key of claims.keys()) {
            snapshots.set(key, actor.sessions.captureSnapshot(key));
          }
        },
      ),
    );
    assertCurrent();
    for (const claim of claims.values()) {
      claim.authorize(authority, "commit");
    }
    if (result.result.indexing) {
      startSessionTranscriptIndexReconcile(
        { ...database, preferredSessionId: selection.sessionId },
        projection,
      );
    }
    return {
      ...result.result,
      indexing:
        result.result.indexing || isSessionTranscriptIndexReconcileRunning(database, projection),
    };
  }
  const scope = captureLifecycleDatabaseScope(
    preparedDatabase
      ? {
          agentId: params.agentId,
          databaseAgentId: preparedDatabase.agentId,
          path: preparedDatabase.path,
          env: params.env,
        }
      : resolveSqliteReadScope(params),
  );
  const options = toDatabaseOptions(scope);
  const request = {
    ...params,
    agentId: scope.agentId,
    env: scope.env,
    sessionKeys: params.sessionKeys?.slice(),
  };
  let statusOwnerFailure: { error: unknown } | undefined;
  const readIndexStatus = async (
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    assertCurrent?.();
    let indexing: boolean;
    try {
      if (statusOwnerFailure) {
        throw statusOwnerFailure.error;
      }
      indexing = await readSessionTranscriptIndexStatus(options, assertCurrent, signal);
    } catch {
      // Writable maintenance failure must not discard an authorized read-only result.
      signal?.throwIfAborted();
      assertCurrent?.();
      return true;
    }
    signal?.throwIfAborted();
    assertCurrent?.();
    if (indexing) {
      startSessionTranscriptIndexReconcile(options);
    }
    return indexing;
  };
  if (isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)) {
    // Process-local SQLite cannot cross the worker boundary without changing its lifetime.
    const { found, revision, ...result } = searchSessionTranscriptsReadOnlySync(request, options);
    const indexing = found && (await readIndexStatus());
    const current =
      !found ||
      (!indexing &&
        revision !== undefined &&
        isSessionTranscriptSearchCurrentSync(revision, options));
    return { ...result, indexing: !current || isSessionTranscriptIndexReconcileRunning(options) };
  }
  let execution: OpenClawAgentDatabaseExecution | undefined;
  try {
    try {
      // Status reads must not idle-close and checkpoint the writer between the hit
      // snapshot and its revision check. Native opening remains lazy and off-thread.
      if (supportsOpenClawAgentDatabaseExecution(options)) {
        execution = captureOpenClawAgentDatabaseExecution(options);
      }
    } catch (error) {
      statusOwnerFailure = { error };
    }
    return await withSessionHistoryWorkerDatabase(
      options,
      async (owner) => {
        const result = await owner.searchTranscripts(request, (signal) =>
          readIndexStatus(owner.assertCurrent, signal),
        );
        owner.assertCurrent();
        return {
          ...result,
          indexing: result.indexing || isSessionTranscriptIndexReconcileRunning(options),
        };
      },
      transcriptSearchLane,
    );
  } finally {
    await execution?.release();
  }
}

function validateSearchQuery(input: string): string {
  const query = input.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  return query;
}

/** Native query kernel; projection readiness belongs to the maintenance owner. */
export function searchSessionTranscriptsReadOnlySync(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
): SessionTranscriptSearchReadResult {
  const query = validateSearchQuery(params.query);
  const scope = preparedDatabase ? { agentId: params.agentId } : resolveSqliteReadScope(params);
  const databaseOptions = preparedDatabase ?? toDatabaseOptions(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    return {
      // Capture before BEGIN to detect commits during or after the hit snapshot.
      revision: readSearchRevision(database.db),
      ...runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
          // Shared databases hold multiple logical agents. Filter before LIMIT;
          // reserved global/unknown sentinels retain their store-wide scope.
          const db = getNodeSqliteKysely<DB>(database.db);
          const selectedWindows = db
            .selectFrom("session_windows")
            .select(["session_id", "session_key"])
            .where((eb) =>
              params.sessionKeys === undefined
                ? eb.or([
                    /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */
                    sql<boolean>`${eb.ref("session_key")} GLOB ${toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" })}`,
                    eb("session_key", "in", ["global", "unknown"]),
                  ])
                : params.sessionKeys.length > 0
                  ? eb("session_key", "in", sqliteStringSet(params.sessionKeys))
                  : eb.and([]),
            )
            .$if(params.sessionId !== undefined, (builder) =>
              builder.where("session_id", "=", params.sessionId!),
            );
          const archivedTranscriptsExcluded =
            executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("session_transcript_cold_archives as cold")
                .innerJoin(selectedWindows.as("window"), "window.session_id", "cold.session_id")
                .select((eb) => eb.fn.countAll<number>().as("count")),
            )?.count ?? 0;
          if (hasSqliteStorageValueEncryption(database.db)) {
            // Scope metadata before hydrating ciphertext. Only the active, clean
            // projection is eligible, just as for the unencrypted FTS query.
            const candidates = executeSqliteQuerySync(
              database.db,
              db
                .selectFrom(selectedWindows.as("window"))
                .innerJoin(
                  "session_transcript_active_events as active",
                  "active.session_id",
                  "window.session_id",
                )
                .innerJoin("session_transcript_index_state as state", (join) =>
                  join
                    .onRef("state.session_id", "=", "active.session_id")
                    .on("state.needs_rebuild", "=", 0),
                )
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "active.session_id")
                    .onRef("event.seq", "=", "active.event_seq"),
                )
                .where("active.message_position", "is not", null)
                .select([
                  "window.session_key",
                  "event.session_id",
                  "event.seq",
                  "event.created_at",
                  transcriptEventReadBytesSql("event").as("read_bytes"),
                ])
                .orderBy("event.created_at", "desc")
                .orderBy("event.seq", "desc")
                .limit(ENCRYPTED_SEARCH_MAX_ROWS + 1),
            ).rows;
            const readPayload = prepareSqliteQueryTakeFirstSync<
              { sessionId: string; seq: number },
              TranscriptPayloadRecord
            >(database.db, (parameter) =>
              db
                .selectFrom("transcript_events")
                .select(["event_json", "event_zstd", "event_utf8_bytes", "navigation_json"])
                .where(
                  "session_id",
                  "=",
                  parameter((row) => row.sessionId),
                )
                .where(
                  "seq",
                  "=",
                  parameter((row) => row.seq),
                ),
            );
            const terms = query
              .split(/\s+/u)
              .map((term) => searchWords(term).map((word) => word.value))
              .filter((term) => term.length > 0);
            const hits: SessionTranscriptSearchResult["hits"] = [];
            let truncated = candidates.length > ENCRYPTED_SEARCH_MAX_ROWS;
            let readBytes = 0;
            for (const row of candidates.slice(0, ENCRYPTED_SEARCH_MAX_ROWS)) {
              readBytes += row.read_bytes;
              if (readBytes > ENCRYPTED_SEARCH_MAX_BYTES) {
                truncated = true;
                break;
              }
              const payload = readPayload({ sessionId: row.session_id, seq: row.seq });
              if (!payload) {
                throw new Error("Transcript search lost a row within its read snapshot");
              }
              const event: unknown = JSON.parse(
                readTranscriptPayload(payload, {
                  database: database.db,
                  sessionId: row.session_id,
                  seq: row.seq,
                }),
              );
              const entry = extractTranscriptIndexEntry(event, row.created_at);
              if (!entry || (params.role && entry.role !== params.role)) {
                continue;
              }
              const snippet = encryptedSearchSnippet(entry.text, terms, params.match);
              if (snippet === undefined) {
                continue;
              }
              hits.push({
                sessionKey: row.session_key,
                sessionId: row.session_id,
                messageId: entry.messageId,
                role: entry.role,
                timestamp: entry.timestamp,
                snippet,
                score: 0,
              });
            }
            hits.sort((left, right) => right.timestamp - left.timestamp);
            return {
              found: true,
              hits: hits.slice(0, limit),
              truncated: truncated || hits.length > limit,
              ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
            };
          }
          const match =
            /* kysely-allow-raw: FTS5 table MATCH with a bound search query. */
            sql<boolean>`session_transcript_fts MATCH ${toFtsQuery(query, params.match)}`;
          /* kysely-allow-raw: Shared FTS ordering, including SQLite-only rowid for recent ties. */
          const order =
            params.order === "recent"
              ? sql`session_transcript_fts.timestamp desc, fts_rowid desc`
              : sql`rank asc, session_transcript_fts.timestamp desc, session_transcript_fts.message_id asc`;
          // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
          // representation. session_key lives on the window row so key renames
          // never leave stale keys inside the index. Sessions flagged needs_rebuild
          // are excluded: their rows may still hold rewound-away branch text that
          // sessions_history no longer exposes, so they stay hidden until reconcile
          // rebuilds them (indexing=true tells the caller to retry).
          const candidates = db
            .selectFrom("session_transcript_fts")
            // Keep MATCH outermost; the narrow map rejects excluded content before hydration.
            .crossJoin("session_transcript_fts_rows as mapped")
            .crossJoin(selectedWindows.as("window"))
            .where(
              "mapped.id",
              "=",
              /* kysely-allow-raw: FTS5 implicit rowid stays inside SQLite, including 64-bit identities. */
              sql<number>`session_transcript_fts.rowid`,
            )
            .whereRef("window.session_id", "=", "mapped.session_id")
            .where(match)
            // Depend on the scoped window so SQLite cannot read role before excluding sessions.
            .$if(Boolean(params.role), (builder) =>
              builder.where((eb) =>
                eb
                  .case()
                  .when("window.session_key", "is not", null)
                  .then(eb("role", "=", params.role!))
                  .else(false)
                  .end(),
              ),
            )
            .where(
              "mapped.session_id",
              "not in",
              db
                .selectFrom("session_transcript_index_state")
                .select("session_id")
                .where("needs_rebuild", "!=", 0),
            )
            .select([
              "window.session_key",
              /* kysely-allow-raw: FTS5 implicit rowid is not a generated schema column. */
              sql`session_transcript_fts.rowid`.as("fts_rowid"),
              /* kysely-allow-raw: FTS5 ranking primitive. */
              sql`bm25(session_transcript_fts)`.as("rank"),
            ])
            .orderBy(order)
            .limit(limit + 1);
          const rows = executeSqliteQuerySync(
            database.db,
            db
              .with(
                (cte) => cte("hits").materialized(),
                () => candidates,
              )
              .selectFrom("hits")
              .crossJoin("session_transcript_fts")
              /* kysely-allow-raw: Bound FTS5 hydration only visits the retained candidate rowids. */
              .where((eb) => eb(sql`session_transcript_fts.rowid`, "=", eb.ref("hits.fts_rowid")))
              .where(match)
              .select([
                "hits.session_key",
                "session_transcript_fts.session_id",
                "message_id",
                "role",
                "timestamp",
                "hits.rank as rank",
                /* kysely-allow-raw: Materialization bounds snippet tokenization to limit + 1 rows. */
                sql`snippet(session_transcript_fts, 0, '', '', ' … ', 48)`.as("snippet"),
              ])
              .orderBy(order),
          ).rows;
          const hits = rows.flatMap((row): SessionTranscriptSearchResult["hits"] => {
            if (
              typeof row.session_key !== "string" ||
              typeof row.session_id !== "string" ||
              typeof row.message_id !== "string" ||
              (row.role !== "user" && row.role !== "assistant") ||
              typeof row.snippet !== "string"
            ) {
              return [];
            }
            const timestamp =
              typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
            const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
            return [
              {
                sessionKey: row.session_key,
                sessionId: row.session_id,
                messageId: row.message_id,
                role: row.role,
                timestamp: Number.isFinite(timestamp) ? timestamp : 0,
                snippet:
                  row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
                    ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
                    : row.snippet,
                score: Number.isFinite(rank) ? -rank : 0,
              },
            ];
          });
          return {
            found: true,
            hits: hits.slice(0, limit),
            truncated: hits.length > limit,
            ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
          };
        },
        { databaseLabel: database.path, operationLabel: "session transcript search" },
      ),
    };
  }, databaseOptions);
  return result.found ? result.value : { found: false, hits: [], truncated: false };
}
