import type { DatabaseSync } from "node:sqlite";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  isProtectedAgentSchemaVersion,
} from "../state/openclaw-agent-db-contract.js";
import { inspectAgentDatabaseSchema } from "../state/openclaw-agent-schema-inspection.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { PROTECTED_SHARED_STATE_SCHEMA_VERSION } from "../state/openclaw-state-protected-marker.js";
import { inspectStateDatabaseSchema } from "../state/openclaw-state-schema-preflight.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationInProcess } from "./sqlite-readonly-location.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  queueStateDatabaseSpelling,
  type StateDatabaseDiscovery,
} from "./update-candidate-paths.js";
import {
  createUpdateStateSnapshotReporter,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";

export function collectRegisteredPaths(
  db: DatabaseSync,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
) {
  // Raw registries can predate agent IDs; keep their paths without inventing ownership.
  const rows = tableExists(db, "agent_databases")
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "agent_databases">>(db)
          .selectFrom("agent_databases")
          .select("path")
          .select((eb) =>
            tableHasColumn(db, "agent_databases", "agent_id")
              ? eb.ref("agent_id").as("agent_id")
              : eb.val(null).as("agent_id"),
          )
          .orderBy("path"),
      ).rows
    : [];
  return rows.map(({ path: stored, agent_id: agentId }) => {
    const source = resolveOpenClawRegisteredAgentDatabasePath(shared, stored);
    // Keep every raw alias for released rollback baselines.
    queueStateDatabaseSpelling(
      files,
      resolveOpenClawStateDirForDatabasePath(shared),
      source,
      typeof agentId === "string" && agentId.length > 0 ? { role: "agent", agentId } : undefined,
    );
    return { stored, source };
  });
}

export function readSharedDatabaseVersion(
  location: string,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
  inspectOwnProtectedFormats = false,
): Omit<UpdateStateSchemaVersion, "path"> {
  const db = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    collectRegisteredPaths(db, shared, files);
    const userVersion = readSqliteUserVersion(db);
    const contentVersion = readStateSchemaContentVersion(db);
    const ownProtectedFormat = inspectOwnProtectedFormats
      ? inspectUpdateProtectedState(db, shared, userVersion)
      : undefined;
    return {
      userVersion,
      contentVersion,
      ...(ownProtectedFormat ? { ownProtectedFormat } : {}),
    };
  } finally {
    db.close();
  }
}

function inspectUpdateProtectedState(database: DatabaseSync, pathname: string, version: number) {
  if (version !== PROTECTED_SHARED_STATE_SCHEMA_VERSION) {
    return undefined;
  }
  const inspection = inspectStateDatabaseSchema(database, {
    pathname,
    supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    inspectOwnProtectedFormats: true,
    scope: "state",
    purpose: "runtime",
  });
  if (inspection.inspectionErrors.length) {
    throw new AggregateError(
      inspection.inspectionErrors,
      `Protected shared-state inspection failed: ${pathname}`,
    );
  }
  return !inspection.schemas.incompatible.length &&
    !inspection.schemas.indeterminate.length &&
    !inspection.schemas.pendingMigrations?.length
    ? { kind: "state" as const, personalVersion: OPENCLAW_STATE_SCHEMA_VERSION }
    : undefined;
}

export async function inspectUpdateProtectedAgent(
  pathname: string,
  discovery: StateDatabaseDiscovery,
  version: number,
  stagingRoot?: string,
  onProgress?: (progress: UpdateStateInspectionProgress) => void,
) {
  if (!isProtectedAgentSchemaVersion(version)) {
    return { userVersion: version };
  }
  const progress = createUpdateStateSnapshotReporter(
    pathname,
    "agent schema inspection",
    onProgress,
  );
  const snapshot = await prepareSqliteReadOnlyLocationInProcess(
    pathname,
    stagingRoot,
    undefined,
    progress.onProgress,
  );
  return withPreparedSqliteSnapshot(snapshot, (location) => {
    const database = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      const inspection = inspectAgentDatabaseSchema(database, {
        pathname,
        agentId: discovery.owners?.find((owner) => owner.role === "agent")?.agentId,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        inspectOwnProtectedFormats: true,
        verifyCurrentSchemaShape: true,
      });
      if (inspection.reason) {
        throw new Error(
          `Protected agent database inspection failed: ${pathname}: ${inspection.reason}`,
        );
      }
      const meta = inspection.agentSchemaMeta;
      return {
        userVersion: inspection.version,
        ...(inspection.ownProtectedFormat &&
        meta?.role === "agent" &&
        meta.schemaVersion === inspection.version &&
        meta.agentId &&
        discovery.owners?.every(
          (owner) => owner.role === "agent" && owner.agentId === meta.agentId,
        ) !== false
          ? {
              ownProtectedFormat: {
                kind: "agent" as const,
                personalVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
              },
            }
          : {}),
      };
    } finally {
      database.close();
    }
  });
}
