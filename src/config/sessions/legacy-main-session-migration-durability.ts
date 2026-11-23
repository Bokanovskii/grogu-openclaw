import { truncateSqliteWal } from "../../infra/sqlite-wal-checkpoint.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSqliteStorageValueEncryption } from "../../storage/sqlite-encryption.js";
import type { SessionClaim } from "./legacy-main-session-migration.contract.js";

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
 * Makes a protected destination copy durable before its source is deleted. A completed TRUNCATE
 * checkpoint syncs even a copy committed earlier by a NORMAL-synchronous writer.
 */
export function checkpointProtectedLegacySessionCopy(
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
