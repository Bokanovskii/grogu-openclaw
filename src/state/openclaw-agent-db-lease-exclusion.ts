import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  agentDatabaseLeaseStaleReason,
  mayShareAgentDatabaseFile,
} from "./openclaw-agent-db-lease-provenance.js";
import { OpenClawAgentDatabaseLeaseActiveError } from "./openclaw-agent-db-lease.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

/**
 * Exclusive-service boot admission: a live opener registered before the service
 * owner must not cross startup. Later claims serialize behind this transaction
 * and observe the owner record; stale rows stay with the claim path to reap.
 */
export function assertNoForeignOpenClawAgentDatabaseLeases(
  pathname: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const startTime = getFileLockProcessStartTime(process.pid);
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "agent_database_leases">>(
      database.db,
    );
    const foreign = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("agent_database_leases")
        .select(["agent_id", "path", "owner_pid", "owner_start_time"]),
    ).rows.find(
      (held) =>
        mayShareAgentDatabaseFile(held.path, pathname) &&
        !agentDatabaseLeaseStaleReason(held) &&
        (held.owner_pid !== process.pid || held.owner_start_time !== startTime),
    );
    if (foreign) {
      throw new OpenClawAgentDatabaseLeaseActiveError(
        `Agent ${foreign.agent_id} database is still open in process ${foreign.owner_pid}; stop that process before starting the service.`,
      );
    }
  }, options);
}
