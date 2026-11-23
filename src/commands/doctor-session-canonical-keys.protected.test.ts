import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  openSessionSuggestionFields,
  sealSessionSuggestionFields,
} from "../config/sessions/session-suggestion-encryption.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.test-support.js";

const sessionKey = "agent:main:misplaced";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function createProtectedFixture(stateDir: string) {
  const keyPath = path.join(path.dirname(stateDir), "protected.key");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  vi.stubEnv("OPENCLAW_PROTECTED_STORAGE_KEY_FILE", keyPath);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
  const store = (agentId: string) => {
    const storePath = resolveSessionStorePathCore(storeTemplate, { agentId, env });
    const options = {
      agentId,
      env,
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env }).path,
    };
    return {
      options,
      storePath,
      write: <T>(operation: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0]) =>
        runOpenClawAgentWriteTransaction(operation, options),
      loadEntry: () => loadExactSessionEntryReadOnly({ agentId, env, sessionKey, storePath }),
    };
  };
  const cfg = {
    agents: { entries: { main: {}, ops: {} } },
    session: { store: storeTemplate },
  } as OpenClawConfig;
  return { cfg, env, source: store("ops"), destination: store("main") };
}

type Store = ReturnType<typeof createProtectedFixture>["source"];

function insertSuggestion(store: Store, id: string, text: string, sealedFor = sessionKey) {
  store.write(({ db }) => {
    const row = sealSessionSuggestionFields(db, {
      id,
      session_key: sealedFor,
      author_id: "author",
      author_label: "Author",
      text,
    });
    db.prepare(
      "INSERT INTO session_suggestions (id, session_key, author_id, author_label, text, created_at, state) VALUES (?, ?, ?, ?, ?, 1, 'pending')",
    ).run(row.id, sessionKey, row.author_id, row.author_label, row.text);
  });
}

/** Reads authenticated plaintext; a forged or unresealed row would fail to open. */
function readSuggestions(store: Store) {
  return store.write(({ db }) =>
    db
      .prepare("SELECT * FROM session_suggestions ORDER BY id")
      .all()
      .map((row) => {
        const sealed = row as Parameters<typeof openSessionSuggestionFields>[1];
        expect(sealed.text).not.toContain("text");
        return openSessionSuggestionFields(db, sealed);
      }),
  );
}

function rawSuggestions(store: Store) {
  return store.write(({ db }) => db.prepare("SELECT * FROM session_suggestions ORDER BY id").all());
}

function writeEntry(store: Store, updatedAt: number) {
  store.write((database) =>
    writeSessionEntry(
      database,
      sessionKey,
      { sessionId: `session-${updatedAt}`, updatedAt },
      { allowStoredAliases: true, previousEntry: null },
    ),
  );
}

async function prepare(stateDir: string) {
  const fixture = createProtectedFixture(stateDir);
  for (const { options } of [fixture.source, fixture.destination]) {
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
    const preparatory = openNodeSqliteDatabase(options.path);
    try {
      await withAgentDatabaseMaintenanceLease({ env: fixture.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(preparatory, options);
      });
    } finally {
      preparatory.close();
    }
  }
  writeEntry(fixture.source, 10);
  return fixture;
}

describe("doctor canonical repair of protected cross-store suggestions", () => {
  it("moves protected suggestions to the canonical store as authenticated plaintext", async () => {
    await withStateDirEnv("openclaw-doctor-protected-move-", async ({ stateDir }) => {
      const { cfg, env, source, destination } = await prepare(stateDir);
      insertSuggestion(source, "first", "first text");
      insertSuggestion(source, "second", "second text");
      const expected = readSuggestions(source);

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        removedRows: 1,
        repairedGroups: 1,
      });

      expect(source.loadEntry()).toBeUndefined();
      expect(readSuggestions(source)).toEqual([]);
      expect(destination.loadEntry()?.entry).toMatchObject({ sessionId: "session-10" });
      expect(readSuggestions(destination)).toEqual(expected);
    });
  });

  it.each([
    ["a conflicting canonical suggestion", "differing: shared"],
    ["a source suggestion that fails authentication", "missing: shared"],
  ])("keeps the source when the copy loses %s", async (name, detail) => {
    await withStateDirEnv("openclaw-doctor-protected-keep-", async ({ stateDir }) => {
      const { cfg, env, source, destination } = await prepare(stateDir);
      const forged = name.includes("authentication");
      // Ciphertext bound to another context stands in for a wrong key or tampered row.
      insertSuggestion(source, "shared", "source text", forged ? "agent:x:y" : sessionKey);
      if (!forged) {
        // An older canonical row loses the winner choice but keeps its same-id suggestion.
        writeEntry(destination, 5);
        insertSuggestion(destination, "shared", "canonical text");
      }
      const sourceRows = rawSuggestions(source);
      const destinationRows = rawSuggestions(destination);

      await expect(repairCanonicalSessionKeys({ apply: true, cfg, env })).rejects.toThrow(
        new RegExp(`${detail}.*source data was not deleted`),
      );

      expect(source.loadEntry()?.entry).toMatchObject({ sessionId: "session-10" });
      expect(rawSuggestions(source)).toEqual(sourceRows);
      if (forged) {
        // The unauthenticated row was never resealed into the canonical store.
        expect(rawSuggestions(destination)).toEqual([]);
      } else {
        expect(rawSuggestions(destination)).toEqual(destinationRows);
      }
    });
  });
});
