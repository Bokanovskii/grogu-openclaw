import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseExecutionFileIdentity } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

type TestState = Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];

async function useStorageKey(state: TestState, fill = 7) {
  const keyPath = state.path("storage-key");
  await fs.writeFile(keyPath, Buffer.alloc(32, fill), { mode: 0o600 });
  state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;
  state.applyEnv();
}

function prepareStore(state: TestState, insert = false) {
  const options = { agentId: "protected", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  if (insert) {
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run("agent:protected:family:profile:test", "session", '{"sessionId":"session"}', 1);
    }, options);
  }
  const native = readOpenClawAgentDatabaseIdentity(database);
  const identity: AgentDatabaseExecutionFileIdentity = {
    kind: "file",
    physicalIdentity: String(native.identity),
    birthtime: native.birthtime,
    nativeLocation: native.filename,
  };
  closeOpenClawAgentDatabaseByPath(database.path);
  return { pathname: database.path, identity };
}

function createSource(
  state: TestState,
  admitted = { count: 0 },
): AgentDatabaseRequestExecutionSource {
  const context = captureOpenClawStateWorkerContext({ env: state.env });
  return {
    assertCurrent: () => context.admission.assertCurrent(),
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        context.admission.assertCurrent();
        admitted.count += 1;
        if (!grant()) {
          throw new Error("Protected owner fixture lost admission");
        }
      }, binding.attachment),
    }),
  };
}

async function runProtected(
  state: TestState,
  pathname: string,
  identity: AgentDatabaseExecutionFileIdentity,
  {
    protectedStorage = true,
    createIfMissing = false,
  }: {
    protectedStorage?: true;
    createIfMissing?: boolean;
  } = {},
) {
  const context = captureOpenClawStateWorkerContext({ env: state.env });
  let hostAdmissions = 0;
  const assertCurrent = () => {
    hostAdmissions += 1;
    context.admission.assertCurrent();
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        if (!grant()) {
          throw new Error("Protected native fixture lost admission");
        }
      }, binding.attachment),
    }),
  };
  const generation = createAgentDatabaseNativeGeneration(
    "protected",
    pathname,
    context,
    assertCurrent,
    assertCurrent,
    identity,
    () => {},
    () => async () => {},
    undefined,
    undefined,
    protectedStorage,
  );
  try {
    return await generation.run(source, async () => hostAdmissions, undefined, createIfMissing);
  } finally {
    await generation.close();
  }
}

function readUserVersion(pathname: string) {
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    return db.prepare("PRAGMA user_version").get()?.user_version;
  } finally {
    db.close();
  }
}

it("opens a prepared protected store in the native worker only through host admission", async () => {
  await withOpenClawTestState(
    { label: "protected-native-open", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      await useStorageKey(state);
      const { pathname, identity } = prepareStore(state);
      await expect(runProtected(state, pathname, identity)).resolves.toBeGreaterThan(0);

      state.envVars.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = undefined;
      state.applyEnv();
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(/storage key/iu);
      await useStorageKey(state, 8);
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(
        /configured storage key/iu,
      );
    },
  );
});

it("refuses an unmarked store before native schema convergence", async () => {
  await withOpenClawTestState(
    { label: "protected-native-unmarked", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      const { pathname, identity } = prepareStore(state, true);
      const before = readUserVersion(pathname);
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(
        /requires its storage key/iu,
      );
      expect(readUserVersion(pathname)).toBe(before);
      await useStorageKey(state);
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(
        /protected.*(unmarked|unencrypted)/iu,
      );
      expect(readUserVersion(pathname)).toBe(before);
    },
  );
});

it("refuses a missing or replaced store without creating one", async () => {
  await withOpenClawTestState(
    { label: "protected-native-replaced", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      await useStorageKey(state);
      const { pathname, identity } = prepareStore(state);
      await fs.rm(pathname);
      await fs.rm(`${pathname}-wal`, { force: true });
      await fs.rm(`${pathname}-shm`, { force: true });
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(/needs setup/u);
      await expect(
        runProtected(state, pathname, identity, { createIfMissing: true }),
      ).rejects.toThrow(/needs setup/u);
      await expect(fs.stat(pathname)).rejects.toThrow(/ENOENT/u);

      const replacement = prepareStore(state, true);
      expect(replacement.identity.physicalIdentity).not.toBe(identity.physicalIdentity);
      await expect(runProtected(state, pathname, identity)).rejects.toThrow(/changed|differs/u);
      await expect(runProtected(state, pathname, replacement.identity)).resolves.toBeGreaterThan(0);
      expect(() =>
        createAgentDatabaseNativeGeneration(
          "protected",
          pathname,
          captureOpenClawStateWorkerContext({ env: state.env }),
          () => {},
          () => {},
          undefined,
          () => {},
          () => async () => {},
          undefined,
          undefined,
          true,
        ),
      ).toThrow(/existing prepared physical store/u);
    },
  );
});

it.each(["ordinary", "protected"] as const)(
  "refuses reusing a held %s generation under the other grant without closing it",
  async (first) => {
    await withOpenClawTestState(
      {
        label: `protected-owner-${first}`,
        env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined },
      },
      async (state) => {
        await useStorageKey(state);
        const { identity } = prepareStore(state);
        const options = { agentId: "protected", env: state.env };
        const source = createSource(state);
        const capture = (protectedStorage: boolean) =>
          protectedStorage
            ? captureOpenClawAgentDatabaseExecution(options, {
                expectedIdentity: identity,
                protectedStorage: true,
              })
            : captureOpenClawAgentDatabaseExecution(options);
        const holder = capture(first === "protected");
        const other = capture(first !== "protected");
        try {
          await expect(holder.runExisting(source, async () => "held")).resolves.toBe("held");
          const claim = holder.captureGenerationClaim();
          await expect(other.runExisting(source, async () => "reused")).rejects.toThrow(
            /different protected grant/u,
          );
          claim.assertCurrent();
          await expect(holder.runExisting(source, async () => "still held")).resolves.toBe(
            "still held",
          );
          expect(holder.captureGenerationClaim().incarnation).toBe(claim.incarnation);
        } finally {
          await other.release();
          await holder.release();
        }
      },
    );
  },
);

it("prepares an existing protected store without initializing a missing one", async () => {
  await withOpenClawTestState(
    { label: "protected-owner-prepare", env: { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: undefined } },
    async (state) => {
      await useStorageKey(state);
      const { pathname, identity } = prepareStore(state, true);
      const options = { agentId: "protected", env: state.env };
      const admitted = { count: 0 };
      const source = createSource(state, admitted);
      const constraints = { expectedIdentity: identity, protectedStorage: true } as const;
      const execution = captureOpenClawAgentDatabaseExecution(options, constraints);
      try {
        await execution.prepare(source, undefined, { readmitSchema: true });
        const claim = execution.capturePreparedGenerationClaim();
        expect(claim?.identity).toBe(identity.physicalIdentity);
        const warm = admitted.count;
        await execution.prepare(source);
        expect(admitted.count).toBe(warm);
        // A warm protected generation still honors requested schema readmission.
        await execution.prepare(source, undefined, { readmitSchema: true });
        expect(admitted.count).toBeGreaterThan(warm);
        expect(execution.capturePreparedGenerationClaim()?.incarnation).toBe(claim?.incarnation);
      } finally {
        await execution.release();
      }
      await closeOpenClawAgentDatabasesAsync();
      const missing = captureOpenClawAgentDatabaseExecution(options, constraints);
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          await fs.rm(`${pathname}${suffix}`, { force: true });
        }
        await expect(missing.prepare(source)).rejects.toThrow(/needs setup|ENOENT/u);
      } finally {
        await missing.release();
      }
      await expect(fs.stat(pathname)).rejects.toThrow(/ENOENT/u);
    },
  );
});
