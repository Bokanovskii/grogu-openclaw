import { existsSync } from "node:fs";
import { invalidateSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import { hasSqliteStorageValueEncryption } from "../storage/sqlite-encryption.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  ensureFirstUseStateColumns,
  missingFirstUseStateColumns,
} from "./openclaw-state-db-schema-helpers.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";
import { cleanupProtectedSharedStateAfterMigration } from "./openclaw-state-protected-cleanup.js";
import {
  PROTECTED_SHARED_STATE_SCHEMA_VERSION,
  readProtectedSharedStateMarker,
} from "./openclaw-state-protected-marker.js";
import { migrateProtectedSharedStateInTransaction } from "./openclaw-state-protected-migration.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export function prepareProtectedSharedStateInWorker(params: {
  pathname: string;
  env: NodeJS.ProcessEnv;
  open: () => OpenClawStateDatabase;
  write: WorkerWriteOperationContext["write"];
}): void {
  const { pathname, env, open, write } = params;
  const admit = (stage: "transaction" | "commit") =>
    requestSqliteWorkerOperationAdmission({
      stage,
      facts: { kind: "protected-shared-state-startup" },
    });
  withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () => {
    admit("transaction");
    if (existsSync(pathname)) {
      const db = openTrackedStateDatabase(pathname, { existingOnly: true });
      try {
        if (readSqliteUserVersion(db) === PROTECTED_SHARED_STATE_SCHEMA_VERSION) {
          const assertCurrent = () => {
            admit("transaction");
            assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
          };
          if (readProtectedSharedStateMarker(db).cleanupPending) {
            cleanupProtectedSharedStateAfterMigration(db, assertCurrent);
          }
        }
      } finally {
        db.close();
      }
    }
    const database = open();
    const db = database.db;
    if (!hasSqliteStorageValueEncryption(db)) {
      throw new Error("Protected shared-state startup requires the protected storage key.");
    }
    if (readSqliteUserVersion(db) !== PROTECTED_SHARED_STATE_SCHEMA_VERSION) {
      admit("transaction");
      db.exec("PRAGMA secure_delete = ON");
      write(
        () => {
          admit("transaction");
          migrateProtectedSharedStateInTransaction(db);
          admit("commit");
        },
        { operationLabel: "state.protected.migrate" },
      );
      invalidateSqliteSchemaFacts(db);
      cleanupProtectedSharedStateAfterMigration(db, () => {
        admit("transaction");
        assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      });
    }
    assertSupportedStateSchemaVersion(db, pathname);
    const automationTables = ["protected_automations", "protected_automation_run_chats"];
    if (!missingFirstUseStateColumns(db, automationTables).length) {
      return;
    }
    write(
      () => {
        admit("transaction");
        ensureFirstUseStateColumns(db, automationTables);
        admit("commit");
      },
      { operationLabel: "state.protected.automationPacingSchema" },
    );
  });
}
