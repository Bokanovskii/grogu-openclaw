import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  PhysicalStore,
  SessionClaim,
  SessionComparisonClaim,
} from "./legacy-main-session-migration.contract.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationComparison,
  readSqliteSessionGenerationWindows,
  rehomeSqliteSessionGenerationWindow,
} from "./session-accessor.sqlite-generation-copy.js";
import type { SqliteSessionGenerationComparison } from "./session-accessor.sqlite-generation.types.js";
import { readSessionNodeArtifactFingerprint } from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { openSessionSuggestionFields } from "./session-suggestion-encryption.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

function projectEntryIdentity(entry: SessionEntry): SessionEntry {
  const projected: SessionEntry & {
    sessionFile?: unknown;
    transcriptPath?: unknown;
  } = { ...entry };
  delete projected.sessionFile;
  delete projected.transcriptPath;
  return projected;
}

function generationWindowIdentity(
  generation: SqliteSessionGenerationComparison,
  canonicalKey: string,
) {
  const {
    updated_at: _updatedAt,
    transcript_updated_at: _transcriptUpdatedAt,
    transcript_observed_at: _transcriptObservedAt,
    ...identity
  } = rehomeSqliteSessionGenerationWindow(
    generation.window,
    canonicalKey,
    new Set([normalizeStoreSessionKey(generation.window.session_key.trim())]),
  );
  return identity;
}

export function generationsMatch(
  left: SqliteSessionGenerationComparison,
  right: SqliteSessionGenerationComparison,
  canonicalKey: string,
): boolean {
  return (
    left.contentFingerprint === right.contentFingerprint &&
    isDeepStrictEqual(
      generationWindowIdentity(left, canonicalKey),
      generationWindowIdentity(right, canonicalKey),
    )
  );
}

export function claimsMatch(left: SessionComparisonClaim, right: SessionComparisonClaim): boolean {
  const generations = new Map(
    right.generations.map((generation) => [generation.window.session_id, generation]),
  );
  return (
    isDeepStrictEqual(projectEntryIdentity(left.entry), projectEntryIdentity(right.entry)) &&
    left.generations.every((generation) => {
      const other = generations.get(generation.window.session_id);
      return !other || generationsMatch(generation, other, left.canonicalKey);
    })
  );
}

export function claimUnchanged(current: SessionClaim, expected: SessionClaim): boolean {
  return (
    current.databaseIdentity === expected.databaseIdentity &&
    current.nodeArtifactFingerprint === expected.nodeArtifactFingerprint &&
    isDeepStrictEqual(projectEntryIdentity(current.entry), projectEntryIdentity(expected.entry)) &&
    current.generations.length === expected.generations.length &&
    current.generations.every(
      (generation, index) => generation.fingerprint === expected.generations[index]?.fingerprint,
    )
  );
}

export function claimFullyCopied(source: SessionClaim, destination: SessionClaim): boolean {
  const sessionIds = new Set(
    destination.generations.map((generation) => generation.window.session_id),
  );
  return (
    claimsMatch(source, destination) &&
    source.generations.every((generation) => sessionIds.has(generation.window.session_id))
  );
}

export function readClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
): SessionClaim | undefined {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const row = readExactSessionEntryRowForCanonicalRepair(database, key);
    if (!row) {
      return undefined;
    }
    const windows = readSqliteSessionGenerationWindows(
      database,
      [key],
      collectSessionStateIdsForEntry(row.entry),
    );
    return {
      canonicalKey,
      databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
      entry: row.entry,
      generations: windows.map((window) => readSqliteSessionGenerationClaim(database, window)),
      key,
      nodeArtifactFingerprint: readSessionNodeArtifactFingerprint(database, key),
      store,
    };
  });
}

/** Detection compares history; only Doctor acquires the artifact custody needed to delete it. */
export function readComparisonClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
): SessionComparisonClaim | undefined {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const row = readExactSessionEntryRowForCanonicalRepair(database, key);
    if (!row) {
      return undefined;
    }
    const windows = readSqliteSessionGenerationWindows(
      database,
      [key],
      collectSessionStateIdsForEntry(row.entry),
    );
    return {
      canonicalKey,
      entry: row.entry,
      generations: windows.map((window) => readSqliteSessionGenerationComparison(database, window)),
      key,
      store,
    };
  });
}

export async function restoreColdSessionClaims(
  claims: SessionClaim[],
  env: NodeJS.ProcessEnv,
  beforePersistentApply?: () => void,
): Promise<void> {
  for (const [index, claim] of claims.entries()) {
    const cold = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where(
              "session_id",
              "in",
              sqliteStringSet(claim.generations.map((generation) => generation.window.session_id)),
            ),
        ).rows,
      { agentId: claim.store.databaseAgentId, env, path: claim.store.path },
    );
    if (!cold.found) {
      throw new Error(`Legacy session store changed before history restoration: ${claim.key}`);
    }
    if (
      cold.value.length === 0 &&
      claim.generations.every((generation) => !generation.coldArchive)
    ) {
      continue;
    }
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    for (const generation of cold.value) {
      await restoreSessionColdTranscript(
        {
          agentId: claim.store.databaseAgentId,
          env,
          sessionId: generation.session_id,
          storePath: claim.store.path,
        },
        beforePersistentApply,
      );
    }
    const refreshed = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaim(database, claim.store, claim.key, claim.canonicalKey),
      { agentId: claim.store.databaseAgentId, env, path: claim.store.path },
    );
    if (!refreshed.found || !refreshed.value) {
      throw new Error(`Legacy session changed during history restoration: ${claim.key}`);
    }
    claims[index] = refreshed.value;
  }
}

export type LegacySessionSuggestionRow = { readonly id: string } & Readonly<
  Record<string, unknown>
>;

/**
 * Decides whether a destination suggestion preserves its source. Rows arrive as authenticated
 * plaintext, never resealed ciphertext; a row that failed authentication never matches.
 */
export type LegacySessionSuggestionComparator = (
  source: LegacySessionSuggestionRow,
  destination: LegacySessionSuggestionRow,
  canonicalKey: string,
) => boolean;

const unauthenticatedSuggestions = new WeakSet<LegacySessionSuggestionRow>();

const authenticatedSuggestionsMatch: LegacySessionSuggestionComparator = (
  source,
  destination,
  canonicalKey,
) =>
  !unauthenticatedSuggestions.has(source) &&
  !unauthenticatedSuggestions.has(destination) &&
  // SQLite rows have null prototypes; compare their own columns only.
  isDeepStrictEqual({ ...source, session_key: canonicalKey }, { ...destination });

function authenticateSuggestion<Row extends Parameters<typeof openSessionSuggestionFields>[1]>(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: Row,
): Row {
  try {
    return openSessionSuggestionFields(database.db, row);
  } catch {
    unauthenticatedSuggestions.add(row);
    return row;
  }
}

/**
 * Reads one session's suggestions as authenticated plaintext, each opened under its own store key
 * and session-key context. Callers own the snapshot or transaction that fences the read.
 */
export function readAuthenticatedSessionSuggestions(
  database: Pick<OpenClawAgentDatabase, "db">,
  key: string,
): LegacySessionSuggestionRow[] {
  const present = database.db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_suggestions'")
    .get();
  return present
    ? executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_suggestions")
          .selectAll()
          .where("session_key", "=", key)
          .orderBy("id"),
      ).rows.map((row) => authenticateSuggestion(database, row))
    : [];
}

/** Reads authenticated suggestions in the snapshot that matches the claim's fenced fingerprint. */
export function readClaimSuggestions(
  database: Pick<OpenClawAgentDatabase, "db">,
  key: string,
  expectedNodeArtifactFingerprint: string,
): LegacySessionSuggestionRow[] | undefined {
  return runSqliteDeferredTransactionSync(database.db, () =>
    readSessionNodeArtifactFingerprint(database, key) === expectedNodeArtifactFingerprint
      ? readAuthenticatedSessionSuggestions(database, key)
      : undefined,
  );
}

/**
 * Compares the copied suggestion set by id. Missing and differing rows lose source data; extra
 * destination rows are the canonical node's own rows, which the destination receipt fences.
 */
export function compareCopiedSuggestions(params: {
  canonicalKey: string;
  destination: readonly LegacySessionSuggestionRow[];
  sameRow: LegacySessionSuggestionComparator;
  sources: readonly LegacySessionSuggestionRow[];
}): { differing: string[]; extra: string[]; missing: string[] } {
  const destination = new Map(params.destination.map((row) => [row.id, row]));
  const sourceIds = new Set<string>();
  const differing: string[] = [];
  const missing: string[] = [];
  for (const source of params.sources) {
    sourceIds.add(source.id);
    const copied = destination.get(source.id);
    if (!copied) {
      missing.push(source.id);
    } else if (!params.sameRow(source, copied, params.canonicalKey)) {
      differing.push(source.id);
    }
  }
  return {
    differing,
    extra: params.destination.filter((row) => !sourceIds.has(row.id)).map((row) => row.id),
    missing,
  };
}

/**
 * Verifies, under destination custody, that every source suggestion survived the copy. Returns the
 * divergence that keeps both copies, or undefined when source retirement may proceed.
 */
export function verifyCopiedSuggestions(
  params: { canonicalKey: string; env: NodeJS.ProcessEnv; receipt: SessionClaim },
  reader: Pick<OpenClawAgentDatabase, "db">,
  claims: readonly SessionClaim[],
  changed: () => Error,
  sameRow: LegacySessionSuggestionComparator = authenticatedSuggestionsMatch,
): string | undefined {
  const destination = readClaimSuggestions(
    reader,
    params.canonicalKey,
    params.receipt.nodeArtifactFingerprint,
  );
  const sources = claims.map((claim) => {
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaimSuggestions(database, claim.key, claim.nodeArtifactFingerprint),
      { agentId: claim.store.databaseAgentId, env: params.env, path: claim.store.path },
    );
    return read.found ? read.value : undefined;
  });
  if (!destination || sources.some((rows) => !rows)) {
    throw changed();
  }
  return describeLostSuggestions({
    canonicalKey: params.canonicalKey,
    destination,
    sameRow,
    sources: sources.flatMap((rows) => rows ?? []),
  });
}

/** Names source suggestions the destination does not preserve, or undefined when none are lost. */
export function describeLostSuggestions(params: {
  canonicalKey: string;
  destination: readonly LegacySessionSuggestionRow[];
  sameRow?: LegacySessionSuggestionComparator;
  sources: readonly LegacySessionSuggestionRow[];
}): string | undefined {
  const { differing, extra, missing } = compareCopiedSuggestions({
    ...params,
    sameRow: params.sameRow ?? authenticatedSuggestionsMatch,
  });
  const list = (ids: string[]) => ids.join(", ") || "none";
  return missing.length > 0 || differing.length > 0
    ? `canonical suggestions do not preserve the legacy source (missing: ${list(missing)}; differing: ${list(differing)}; canonical-only: ${list(extra)})`
    : undefined;
}
