import { statSync } from "node:fs";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { truncateSqliteWal } from "../../infra/sqlite-wal-checkpoint.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { hasSqliteStorageValueEncryption } from "../../storage/sqlite-encryption.js";
import type {
  LegacyMainSessionMigrationOutcome,
  PhysicalStore,
  SessionComparisonClaim,
  SessionClaim,
} from "./legacy-main-session-migration.contract.js";
import {
  hasSessionSuggestions,
  ProtectedCrossStoreSuggestionError,
} from "./session-accessor.sqlite-node-artifacts.js";

export function isProtectedLegacySessionMove(params: {
  writer: OpenClawAgentDatabase;
  sources: readonly SessionClaim[];
  env: NodeJS.ProcessEnv;
  changed: () => Error;
}): boolean {
  if (hasSqliteStorageValueEncryption(params.writer.db)) {
    return true;
  }
  for (const claim of params.sources) {
    const source = withOpenClawAgentDatabaseReadOnly(
      (database) => hasSqliteStorageValueEncryption(database.db),
      { agentId: claim.store.databaseAgentId, path: claim.store.path, env: params.env },
    );
    if (!source.found) {
      throw params.changed();
    }
    if (source.value) {
      return true;
    }
  }
  return false;
}

/**
 * Protected suggestion ciphertext is bound to its session key, and cross-store moves are not yet
 * authenticated end to end. Refuses before any copy, restore, or quarantine mutates a claim, and
 * reports the copy transaction's own refusal when suggestions appear after this check.
 */
export async function guardProtectedCrossStoreSuggestions<Claim extends SessionComparisonClaim>(
  params: {
    aliases: readonly Claim[];
    allCanonical: readonly Claim[];
    destination: PhysicalStore;
    canonicalKey: string;
    env: NodeJS.ProcessEnv;
    outcomes: LegacyMainSessionMigrationOutcome[];
    warnings: string[];
  },
  migrate: (canonicalClaims: Claim[]) => Promise<void>,
): Promise<void> {
  const canonicalClaims = params.allCanonical.filter((claim) => claim.key === params.canonicalKey);
  const claims = [...params.aliases, ...canonicalClaims];
  try {
    if (
      !hasProtectedCrossStoreSuggestions(
        claims,
        params.destination,
        params.canonicalKey,
        params.env,
      )
    ) {
      await migrate(canonicalClaims);
      return;
    }
  } catch (error) {
    if (!(error instanceof ProtectedCrossStoreSuggestionError)) {
      throw error;
    }
  }
  const detail = new ProtectedCrossStoreSuggestionError(params.canonicalKey).message;
  params.outcomes.push({
    kind: "protected-suggestions-unsupported",
    canonicalKey: params.canonicalKey,
    detail,
    paths: [...new Set(claims.map((claim) => claim.store.path))],
    sourceKeys: params.aliases.map((claim) => claim.key),
  });
  params.warnings.push(`session: ${detail}`);
}

function hasProtectedCrossStoreSuggestions(
  claims: readonly SessionComparisonClaim[],
  destination: PhysicalStore,
  canonicalKey: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    claims.every((claim) => isSameOpenClawAgentDatabasePath(claim.store.path, destination.path))
  ) {
    return false;
  }
  const probes = [
    ...claims.map((claim) => ({ store: claim.store, key: claim.key })),
    { store: destination, key: canonicalKey },
  ];
  let protectedStore = false;
  let suggestions = false;
  for (const probe of probes) {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        protectedStore ||= hasSqliteStorageValueEncryption(database.db);
        suggestions ||= hasSessionSuggestions(database, [probe.key]);
      },
      { agentId: probe.store.databaseAgentId, path: probe.store.path, env },
    );
    if (!result.found && probe.store !== destination) {
      throw new Error(`Legacy session store disappeared before migration: ${probe.store.path}`);
    }
  }
  return protectedStore && suggestions;
}

/**
 * Makes a protected destination copy durable before its source is deleted. A completed TRUNCATE
 * checkpoint syncs even a copy committed earlier by a NORMAL-synchronous writer.
 */
function checkpointProtectedLegacySessionCopy(
  writer: OpenClawAgentDatabase,
  canonicalKey: string,
): void {
  const journal = writer.db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  const synchronous = writer.db.prepare("PRAGMA synchronous").get()?.synchronous;
  if (journal !== "wal" || typeof synchronous !== "number" || synchronous < 1) {
    throw new Error(
      `Cannot confirm durable protected session copy for ${canonicalKey}; source data was not deleted.`,
    );
  }
  const checkpoint = truncateSqliteWal(writer.db, writer.path);
  if (checkpoint.logFrames !== 0 || checkpoint.checkpointedFrames !== 0) {
    throw new Error(
      `SQLite checkpoint was incomplete for ${canonicalKey}; source data was not deleted.`,
    );
  }
}

export type LegacySessionDestinationCustody = {
  /** SQLite-free, so source commit edges can check it while a Worker holds the source lock. */
  assertHeld(): void;
  release(): void;
};

/**
 * Holds the destination write lock on a private connection bound to the writer's physical file.
 * The verified copy cannot change until every source reclamation commit has settled; protected
 * moves also prove that nothing committed after the synced TRUNCATE checkpoint.
 */
export function acquireLegacySessionDestinationCustody(params: {
  writer: OpenClawAgentDatabase;
  canonicalKey: string;
  durable: boolean;
  changed: () => Error;
}): LegacySessionDestinationCustody {
  const { identity } = readOpenClawAgentDatabaseIdentity(params.writer);
  if (params.durable) {
    checkpointProtectedLegacySessionCopy(params.writer, params.canonicalKey);
  }
  const lock = {
    db: openNodeSqliteDatabase(params.writer.path, { timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS }),
    path: params.writer.path,
  };
  const release = () => {
    if (lock.db.isOpen) {
      if (lock.db.isTransaction) {
        lock.db.exec("ROLLBACK");
      }
      lock.db.close();
    }
  };
  const assertHeld = () => {
    if (
      !lock.db.isTransaction ||
      readOpenClawAgentDatabaseIdentity(lock).identity !== identity ||
      !isOpenClawAgentDatabasePathCurrent(lock)
    ) {
      throw params.changed();
    }
  };
  try {
    registerOpenClawAgentDatabaseIdentity(lock.db);
    lock.db.exec("BEGIN IMMEDIATE");
    assertHeld();
    if (params.durable) {
      // Only a later commit appends WAL frames; an empty WAL keeps the checkpoint's sync current.
      const location = lock.db.location();
      const wal = location ? statSync(`${location}-wal`, { throwIfNoEntry: false }) : undefined;
      if (wal?.size !== 0) {
        throw new Error(
          `Protected session copy changed after its durable checkpoint for ${params.canonicalKey}; source data was not deleted.`,
        );
      }
    }
    return { assertHeld, release };
  } catch (error) {
    release();
    throw error;
  }
}
