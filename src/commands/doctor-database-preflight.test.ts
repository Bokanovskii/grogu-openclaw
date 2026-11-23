import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { cleanupProtectedSharedStateAfterMigration } from "../state/openclaw-state-protected-cleanup.js";
import { migrateProtectedSharedStateInTransaction } from "../state/openclaw-state-protected-migration.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { guardUpdateDoctorSchemaUpgrade } from "./doctor-update-schema-guard.js";

it("admits supported protected stores during update Doctor and refuses a newer agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const keyPath = state.path("protected-key");
    fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    await withEnvAsync(
      { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      async () => {
        await state.writeConfig({ agents: { entries: { main: {} } }, plugins: { enabled: false } });
        const env = { ...state.env, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath };
        const statePath = openOpenClawStateDatabase({ env }).path;
        const agent = openOpenClawAgentDatabase({ agentId: "main", env });
        const agentPath = agent.path;
        expect(agent.db.prepare("PRAGMA user_version").get()?.user_version).toBe(28);
        await closeOpenClawAgentDatabasesAsync();
        await closeStateDatabaseForTest();

        const admit = async () => {
          expect(
            await guardUpdateDoctorSchemaUpgrade({ preserveSourceArtifacts: true }),
          ).toMatchObject({ incompatible: [], indeterminate: [] });
        };
        const verifyReady = () =>
          assertOpenClawDatabasesReady({
            env: process.env,
            operation: "doctor",
            config: { agents: { entries: { main: {} } } },
            configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
          });
        await admit();
        await expect(verifyReady()).resolves.toBeUndefined();
        await withEnvAsync({ OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined }, async () => {
          await expect(verifyReady()).rejects.toThrow();
        });
        {
          using shared = openNodeSqliteDatabase(statePath);
          shared.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
          migrateProtectedSharedStateInTransaction(shared);
          shared.exec("COMMIT");
          cleanupProtectedSharedStateAfterMigration(shared, () => {});
        }
        await admit();
        await expect(verifyReady()).resolves.toBeUndefined();
        {
          using writer = new DatabaseSync(agentPath);
          writer.exec("UPDATE schema_meta SET agent_id = 'other' WHERE meta_key = 'primary'");
        }
        expect(
          (await prepareDoctorDatabasePreflight({ preserveSourceArtifacts: true })).agentRefusals,
        ).toEqual([expect.objectContaining({ agentId: "main" })]);
        {
          using writer = new DatabaseSync(agentPath);
          writer.exec("UPDATE schema_meta SET agent_id = 'main' WHERE meta_key = 'primary'");
          writer.exec("PRAGMA user_version = 29");
        }
        await expect(
          guardUpdateDoctorSchemaUpgrade({ preserveSourceArtifacts: true }),
        ).rejects.toThrow(/newer than this build/);
      },
    );
  });
});

it.each([false, true])(
  "keeps an idle WAL agent store's update generation when preserving sources: %s",
  async (preserveSourceArtifacts) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({ agents: { entries: { main: {} } }, plugins: { enabled: false } });
      const agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();
      // A stopped Gateway leaves its WAL family behind; the next native open with
      // no holder rebuilds -shm and changes the generation recorded at capture.
      const family = state.path("exited-writer");
      fs.mkdirSync(family);
      {
        using writer = new DatabaseSync(agentPath);
        writer.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE fixture_tick(x); DROP TABLE fixture_tick;",
        );
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.copyFileSync(`${agentPath}${suffix}`, path.join(family, suffix || "db"));
        }
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.copyFileSync(path.join(family, suffix || "db"), `${agentPath}${suffix}`);
      }
      const captured = readUpdateDatabaseGenerations([agentPath]);

      const result = await prepareDoctorDatabasePreflight(
        preserveSourceArtifacts ? { preserveSourceArtifacts } : {},
      );

      expect(result).toMatchObject({ incompatible: [], indeterminate: [] });
      expect(readUpdateDatabaseGenerations([agentPath])[agentPath] === captured[agentPath]).toBe(
        preserveSourceArtifacts,
      );
    });
  },
);

it.each([true, false])(
  "preserves an unregistered custom WAL store before repair (known history: %s)",
  async (knownHistory) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sharedStatePath = knownHistory
        ? openOpenClawStateDatabase({ env: state.env }).path
        : undefined;
      closeOpenClawStateDatabaseForTest();
      const storeDir = state.path("custom-store");
      fs.mkdirSync(storeDir);
      const pathname = path.join(storeDir, "sessions.sqlite");
      const writer = new DatabaseSync(state.path("fixture-writer.sqlite"));
      try {
        writer.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE schema_meta (
          meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT,
          app_version TEXT, created_at INTEGER, updated_at INTEGER
        );
        INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}, 'retired-owner', 'fixture', 1, 1);
        PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION - 1};
      `);
        fs.copyFileSync(state.path("fixture-writer.sqlite"), pathname);
        fs.copyFileSync(state.path("fixture-writer.sqlite-wal"), `${pathname}-wal`);
      } finally {
        writer.close();
      }
      await state.writeConfig({
        agents: { entries: { main: {} } },
        session: { store: pathname },
      });
      const sourceFiles = [
        pathname,
        `${pathname}-wal`,
        state.configPath,
        ...(sharedStatePath ? [sharedStatePath] : []),
      ];
      const before = sourceFiles.map((file) => fs.readFileSync(file));
      const sharedStateDir = state.statePath("state");
      expect(fs.existsSync(sharedStateDir)).toBe(knownHistory);

      const result = await prepareDoctorDatabasePreflight();

      expect(result).toMatchObject({
        incompatible: [],
        indeterminate: [],
      });
      expect(result.pendingMigrations ?? []).toEqual(
        knownHistory
          ? [
              expect.objectContaining({
                kind: "agent",
                path: pathname,
                foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
              }),
            ]
          : [],
      );
      if (!knownHistory) {
        expect(result.agentDatabaseMigrationDiscovery?.discovery).toMatchObject({
          deletionJournal: {
            status: "unavailable",
            reason: "shared state database missing",
          },
          targets: [],
          retainedTargets: [],
          unverifiedTargets: [
            {
              agentId: "retired-owner",
              path: pathname,
              realPath: fs.realpathSync.native(pathname),
              source: "configured",
            },
          ],
          registryRemovals: [],
          failures: [],
        });
      }
      expect(result.agentRefusals ?? []).toEqual([]);
      expect(fs.readdirSync(storeDir).toSorted()).toEqual([
        "sessions.sqlite",
        "sessions.sqlite-wal",
      ]);
      expect(sourceFiles.map((file) => fs.readFileSync(file))).toEqual(before);
      expect(fs.existsSync(sharedStateDir)).toBe(knownHistory);
    });
  },
);
