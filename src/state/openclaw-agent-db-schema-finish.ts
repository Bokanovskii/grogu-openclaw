import type { DatabaseSync } from "node:sqlite";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { assertAgentSchemaVersion } from "./openclaw-agent-db-schema-helpers.js";

export function finishAgentSchemaMigration(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion: number,
  schemaSql: string,
  requiresMaintenance: boolean,
  assertMigration: () => void,
): void {
  repairCanonicalSqliteIndexes(database, pathname, schemaSql, {
    verifyPhysicalIntegrity: false,
  });
  database.exec(`PRAGMA user_version = ${targetVersion};`);
  persistAgentSchemaMetadata(database, agentId, targetVersion);
  assertAgentSchemaVersion(database, { agentId, pathname, version: targetVersion }, schemaSql);
  if (requiresMaintenance && database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error(`Agent schema migration failed foreign key validation for ${pathname}.`);
  }
  assertMigration();
}
