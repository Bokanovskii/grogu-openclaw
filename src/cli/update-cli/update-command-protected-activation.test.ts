import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupProtectedSharedStateAfterMigration } from "../../state/openclaw-state-protected-cleanup.js";
import { migrateProtectedSharedStateInTransaction } from "../../state/openclaw-state-protected-migration.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it("checks authenticated protected formats after activation without widening personal limits", async () => {
  const root = await fs.realpath(dirs.make("update-protected-activation-"));
  const stateDir = path.join(root, "state");
  const keyPath = path.join(root, "key");
  await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath },
    async () => {
      const env = { ...process.env };
      const shared = openOpenClawStateDatabase({ env });
      runOpenClawAgentWriteTransaction(
        (database) => {
          appendTranscriptEventsInTransaction(
            database,
            { agentId: "main", sessionKey: "agent:main:update-check", sessionId: "protected" },
            [
              {
                type: "message",
                id: "request",
                parentId: null,
                message: { role: "user", content: "protected" },
              },
            ],
          );
        },
        { agentId: "main", env },
      );
      closeOpenClawAgentDatabasesForTest();
      await closeStateDatabaseForTest();
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
      const candidateRoot = process.cwd();
      const inspect = async (inspectionEnv: NodeJS.ProcessEnv = env) => {
        const result = {
          status: "ok" as const,
          mode: "npm" as const,
          root: candidateRoot,
          steps: [],
          durationMs: 0,
        };
        const blocked = await inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          config: {},
          env: inspectionEnv,
        });
        return { result, blocked };
      };
      expect(await inspect()).toMatchObject({
        blocked: undefined,
        result: { status: "ok", steps: [] },
      });
      {
        using sharedDatabase = openNodeSqliteDatabase(shared.path);
        sharedDatabase.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
        migrateProtectedSharedStateInTransaction(sharedDatabase);
        sharedDatabase.exec("COMMIT");
        cleanupProtectedSharedStateAfterMigration(sharedDatabase, () => {});
      }
      expect(await inspect()).toMatchObject({
        blocked: "state-migrated-no-rollback",
        result: { status: "ok", steps: [] },
      });
      expect(
        (await inspect({ ...env, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined })).result.status,
      ).toBe("error");
      const agent = new DatabaseSync(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      try {
        agent.exec("PRAGMA user_version = 27");
      } finally {
        agent.close();
      }
      expect((await inspect()).result).toMatchObject({
        status: "error",
        reason: "openclaw doctor",
        steps: [expect.objectContaining({ stderrTail: expect.stringContaining("found 27") })],
      });
      const malformed = new DatabaseSync(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      try {
        malformed.exec(
          "PRAGMA user_version = 26; UPDATE schema_meta SET schema_version = 25 WHERE meta_key = 'primary'",
        );
      } finally {
        malformed.close();
      }
      expect((await inspect()).result).toMatchObject({
        status: "error",
        reason: "rollback-state-unverified",
        steps: [
          expect.objectContaining({
            stderrTail: expect.stringContaining("Protected agent database inspection failed"),
          }),
        ],
      });
    },
  );
});
