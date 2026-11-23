import fs from "node:fs/promises";
import { afterEach, assert, expect, it } from "vitest";
import { admitProtectedPhysicalAgentStorage } from "../../grogu/protected/agent-storage.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
} from "./openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("refuses an unmarked physical store without migrating or changing its data", async () => {
  await withOpenClawTestState(
    { label: "protected-admission", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      const options = { agentId: "protected", env: state.env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      runOpenClawAgentWriteTransaction(({ db }) => {
        db.prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        ).run("agent:protected:family:profile:test", "session", '{"sessionId":"session"}', 1);
      }, options);
      closeOpenClawAgentDatabaseByPath(pathname);
      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(/key/iu);
      const keyPath = state.path("storage-key");
      await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
      state.applyEnv();

      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(
        /protected.*(unmarked|unencrypted)/iu,
      );
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(25);
        expect(database.prepare("SELECT entry_json FROM session_nodes").get()?.entry_json).toBe(
          '{"sessionId":"session"}',
        );
      } finally {
        database.close();
      }
    },
  );
});

it("admits a protected physical store and refuses a missing or wrong key", async () => {
  await withOpenClawTestState(
    { label: "protected-admission-key", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      const keyPath = state.path("storage-key");
      await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
      state.applyEnv();
      const scope = {
        agentId: "protected",
        env: state.env,
        sessionKey: "agent:protected:family:profile:test",
      };
      const pathname = resolveOpenClawAgentSqlitePath(scope);
      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(/missing/iu);
      replaceSessionEntrySync(scope, {
        sessionId: "session",
        updatedAt: 1,
        label: "private label",
      });
      closeOpenClawAgentDatabaseByPath(pathname);

      admitProtectedPhysicalAgentStorage(() => undefined);
      replaceSessionEntrySync(scope, {
        sessionId: "session",
        updatedAt: 2,
        label: "updated label",
      });
      expect(loadExactSessionEntryReadOnly(scope)?.entry.label).toBe("updated label");
      closeOpenClawAgentDatabaseByPath(pathname);

      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = undefined;
      state.applyEnv();
      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(/key/iu);
      await fs.writeFile(keyPath, Buffer.alloc(32, 8), { mode: 0o600 });
      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
      state.applyEnv();
      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(
        /configured storage key/iu,
      );
      await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
      admitProtectedPhysicalAgentStorage(() => undefined);
      expect(loadExactSessionEntryReadOnly(scope)?.entry.label).toBe("updated label");
    },
  );
});

it("refuses a plaintext key check even when it contains the expected value", async () => {
  await withOpenClawTestState(
    {
      label: "protected-admission-marker",
      env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined },
    },
    async (state) => {
      const keyPath = state.path("storage-key");
      await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
      state.applyEnv();
      const options = { agentId: "protected", env: state.env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      runOpenClawAgentWriteTransaction(() => undefined, options);
      closeOpenClawAgentDatabaseByPath(pathname);
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(pathname);
      try {
        database
          .prepare("UPDATE grogu_protected_storage SET key_check = ? WHERE id = 1")
          .run("protected-storage-key-v1");
      } finally {
        database.close();
      }
      await fs.writeFile(keyPath, Buffer.alloc(32, 8), { mode: 0o600 });
      expect(() =>
        withFreshOpenClawAgentDatabaseReadOnly(
          ({ db }) => db.prepare("SELECT count(*) AS count FROM session_nodes").get(),
          options,
        ),
      ).toThrow(/configured storage key/iu);
      expect(() => admitProtectedPhysicalAgentStorage(() => undefined)).toThrow(
        /configured storage key/iu,
      );
    },
  );
});

it("refuses a downgraded protected marker on retained and fresh readers", async () => {
  await withOpenClawTestState(
    {
      label: "protected-admission-downgrade",
      env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined },
    },
    async (state) => {
      const keyPath = state.path("storage-key");
      await fs.writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
      state.applyEnv();
      const options = { agentId: "protected", env: state.env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      runOpenClawAgentWriteTransaction(() => undefined, options);
      closeOpenClawAgentDatabaseByPath(pathname);
      const reader = openOpenClawAgentDatabaseReadOnly(options);
      assert(reader.found);
      const read = () => hasOpenClawAgentReadOnlySchema(reader.database);
      try {
        expect(read()).toBe(true);
        const { DatabaseSync } = await import("node:sqlite");
        const writer = new DatabaseSync(pathname);
        try {
          writer.exec("PRAGMA user_version = 25");
        } finally {
          writer.close();
        }
        expect(read).toThrow(/encryption marker without its schema version/iu);
        expect(() => withFreshOpenClawAgentDatabaseReadOnly(() => "read", options)).toThrow(
          /encryption marker without its schema version/iu,
        );
      } finally {
        reader.database.close();
      }
    },
  );
});
