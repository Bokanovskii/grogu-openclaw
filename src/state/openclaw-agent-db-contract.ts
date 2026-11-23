import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type {
  DatabaseFileIdentity,
  DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";

export const OPENCLAW_AGENT_SCHEMA_VERSION = 25;
// Protected-only versions above the personal schema; they collide with future upstream numbers.
// 26 seals transcript storage, 27 adds archive attribution, 28 seals suggestions.
export const FIRST_PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION + 1;
export const PROTECTED_ARCHIVE_ATTRIBUTION_AGENT_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION + 2;
export const PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION + 3;

/** Marked protected stores this build admits, including predecessors it migrates. */
export function isProtectedAgentSchemaVersion(version: number): boolean {
  return (
    version >= FIRST_PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION &&
    version <= PROTECTED_ENCRYPTED_AGENT_SCHEMA_VERSION
  );
}
export const CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION = 25;
export const AGENT_STORAGE_SCHEMA_VERSION = 23;
export const TRANSCRIPT_FTS_ROW_SCHEMA_VERSION = 22;
export const AGENT_MEDIA_SCHEMA_VERSION = 17;
export const CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION = 21;
// Bound the disk work shared by startup inspection, admission, and canonical preparation.
export { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../infra/worker-pool-sizing.js";
// Bounds startup session reconciliation for large fleets without letting one slow store hold every slot.
export const AGENT_DATABASE_PREPARATION_CONCURRENCY = 4;

export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

/** Internal existing-store custody; never part of the plugin-facing database options. */
export type OpenClawAgentDatabaseRepairAdmission =
  | {
      expectedIdentity?: DatabaseFileIdentity;
      assertCurrent?: () => void;
      requireProtectedStorage?: never;
    }
  | {
      /** Bind the check to an existing physical store and its live owner. */
      expectedIdentity: DatabaseFileIdentity;
      assertCurrent: () => void;
      /** Refuse an unencrypted or unmarked store before schema convergence. */
      requireProtectedStorage: true;
    };

/** Shared-state registry row describing an agent database seen by this process. */
export type OpenClawRegisteredAgentDatabase = {
  agentId: string;
  path: string;
  schemaVersion: number;
  lastSeenAt: number;
  sizeBytes: number | null;
};

export type OpenClawAgentDatabaseRegistryReadResult =
  | { status: "available"; entries: OpenClawRegisteredAgentDatabase[] }
  | { status: "unavailable" };

/** An in-process witness from the canonical invalidator, never serialized as authority. */
export type AgentDatabaseRegistryChange = Readonly<{ previous: symbol; current: symbol }>;

export type OpenClawAgentDatabaseRegistrationCommit = Readonly<{
  agentId: string;
  agentPath: string;
  stateDatabasePath: string;
  stateDatabaseIdentity: string;
}>;

export type AgentDatabaseRegistryWorkerOperations = {
  "agentDatabaseRegistry.remove": {
    input: { agentId: string; agentPath: string; identity: DatabasePathIdentity };
    output: OpenClawAgentDatabaseRegistrationCommit;
  };
};

export type OpenClawAgentDatabaseRegistrationObserver = {
  starting?: () => void;
  committed?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void;
};

export type OpenClawAgentDatabaseOwnerInspection =
  | { status: "owned"; agentId: string }
  | { status: "unowned" }
  | { status: "unreadable" };

export const SESSION_PARTICIPANTS_TABLE = "session_participants";
