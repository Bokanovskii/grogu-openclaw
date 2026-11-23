import fs from "node:fs";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  openSqliteStorageText,
  protectedStorageValueContext,
} from "../../storage/sqlite-encryption.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  outcomeKinds,
  readClaim,
  recordHarnessDeletions,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import {
  openSessionSuggestionFields,
  sealSessionSuggestionFields,
} from "./session-suggestion-encryption.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();
afterEach(() => vi.restoreAllMocks());

async function prepareProtectedCrossStore() {
  const fixture = createFixture();
  const keyPath = path.join(path.dirname(fixture.stateDir), "key");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  vi.stubEnv("OPENCLAW_PROTECTED_STORAGE_KEY_FILE", keyPath);
  const env = { ...fixture.env, OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath };
  const source = {
    databaseAgentId: "main",
    databasePath: databasePath(fixture.stateDir, "main"),
    key: "agent:main:chat",
  };
  const destination = {
    databaseAgentId: "ops",
    databasePath: databasePath(fixture.stateDir, "ops"),
    key: "agent:ops:chat",
  };
  for (const target of [source, destination]) {
    fs.mkdirSync(path.dirname(target.databasePath), { recursive: true });
    const preparatory = openNodeSqliteDatabase(target.databasePath);
    try {
      await withAgentDatabaseMaintenanceLease({ env }, async () => {
        ensureOpenClawAgentDatabaseSchema(preparatory, {
          agentId: target.databaseAgentId,
          path: target.databasePath,
          env,
        });
      });
    } finally {
      preparatory.close();
    }
  }
  const entry = seedClaim(source);
  const destinationOptions = {
    agentId: destination.databaseAgentId,
    path: destination.databasePath,
    env,
  };
  return { fixture, env, source, destination, entry, destinationOptions };
}

function insertProtectedSuggestion(
  target: { databaseAgentId: string; databasePath: string; key: string },
  env: NodeJS.ProcessEnv,
  id: string,
  text: string,
  overrides: { sealedFor?: string; authorLabel?: null; dispatched?: boolean } = {},
) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const row = sealSessionSuggestionFields(database.db, {
        id,
        session_key: overrides.sealedFor ?? target.key,
        author_id: "author",
        author_label: overrides.authorLabel === null ? null : "Author",
        text,
      });
      const dispatch = overrides.dispatched ? ["token", 2, "send"] : [null, null, null];
      database.db
        .prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, author_label, text, created_at, state, dispatch_token, dispatch_started_at, dispatch_resolution) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .run(
          row.id,
          target.key,
          row.author_id,
          row.author_label,
          row.text,
          overrides.dispatched ? "accepted" : "pending",
          ...dispatch,
        );
    },
    { agentId: target.databaseAgentId, path: target.databasePath, env },
  );
}

/** Reads each suggestion as authenticated plaintext under the key it is stored with. */
function readProtectedSuggestions(
  target: { databaseAgentId: string; databasePath: string },
  env: NodeJS.ProcessEnv,
) {
  return runOpenClawAgentWriteTransaction(
    (database) =>
      database.db
        .prepare("SELECT * FROM session_suggestions ORDER BY id")
        .all()
        .map((row) => {
          const sealed = row as Parameters<typeof openSessionSuggestionFields>[1];
          expect(sealed.text).not.toContain("text");
          return openSessionSuggestionFields(database.db, sealed);
        }),
    { agentId: target.databaseAgentId, path: target.databasePath, env },
  );
}

function serializeStore(
  target: { databaseAgentId: string; databasePath: string },
  env: NodeJS.ProcessEnv,
) {
  return runOpenClawAgentWriteTransaction(({ db }) => db.serialize(), {
    agentId: target.databaseAgentId,
    path: target.databasePath,
    env,
  });
}

describe("protected legacy main session migration", () => {
  it("moves protected suggestions across stores as authenticated plaintext", async () => {
    const { fixture, env, source, destination, entry } = await prepareProtectedCrossStore();
    insertProtectedSuggestion(source, env, "dispatched", "dispatched text", {
      authorLabel: null,
      dispatched: true,
    });
    insertProtectedSuggestion(source, env, "pending", "pending text");
    const expected = readProtectedSuggestions(source, env);
    for (const row of expected) {
      row.session_key = destination.key;
    }

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(true);
    expect(outcomeKinds(result)).toContain("migrated-cross-store");
    expect(readClaim(source)).toBeUndefined();
    expect(readProtectedSuggestions(source, env)).toEqual([]);
    expect(readClaim(destination)?.entry).toMatchObject(entry);
    // Opening under the canonical context proves each row was resealed, not copied as ciphertext.
    expect(readProtectedSuggestions(destination, env)).toEqual(expected);
  });

  it.each([
    ["identical", "shared text", true],
    ["conflicting", "destination text", false],
  ] as const)(
    "retires the source only for an authenticated %s duplicate suggestion",
    async (_name, destinationText, retired) => {
      const { fixture, env, source, destination, entry } = await prepareProtectedCrossStore();
      seedClaim({ ...destination, entry });
      insertProtectedSuggestion(source, env, "shared-id", "shared text");
      insertProtectedSuggestion(destination, env, "shared-id", destinationText);
      const sourceRows = readProtectedSuggestions(source, env);
      const destinationRows = readProtectedSuggestions(destination, env);

      const result = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env,
        mode: "doctor-fix",
      });

      expect(result.complete).toBe(retired);
      expect(readProtectedSuggestions(destination, env)).toEqual(destinationRows);
      if (retired) {
        expect(outcomeKinds(result)).toContain("canonical-exists-identical");
        expect(readClaim(source)).toBeUndefined();
        return;
      }
      expect(outcomeKinds(result)).toEqual(["divergent-canonical"]);
      expect(result.outcomes[0]?.detail).toContain("differing: shared-id");
      expect(readClaim(source)?.entry).toMatchObject(entry);
      expect(readProtectedSuggestions(source, env)).toEqual(sourceRows);
    },
  );

  it("keeps a source suggestion that fails authentication and never reseals it", async () => {
    const { fixture, env, source, destination, entry } = await prepareProtectedCrossStore();
    // Ciphertext bound to another context stands in for a wrong key or tampered row.
    insertProtectedSuggestion(source, env, "forged", "forged text", { sealedFor: "agent:x:y" });
    const sourceBytes = runOpenClawAgentWriteTransaction(
      ({ db }) => db.prepare("SELECT * FROM session_suggestions").all(),
      { agentId: source.databaseAgentId, path: source.databasePath, env },
    );

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(false);
    expect(outcomeKinds(result)).toEqual(["divergent-canonical"]);
    expect(result.outcomes[0]?.detail).toContain("missing: forged");
    expect(readClaim(source)?.entry).toMatchObject(entry);
    expect(
      runOpenClawAgentWriteTransaction(
        ({ db }) => db.prepare("SELECT * FROM session_suggestions").all(),
        { agentId: source.databaseAgentId, path: source.databasePath, env },
      ),
    ).toEqual(sourceBytes);
    expect(readProtectedSuggestions(destination, env)).toEqual([]);
  });

  it.each([
    ["settled", true],
    ["changed by a destination writer", false],
  ] as const)(
    "keeps both protected copies after an unknown cleanup outcome until a %s retry reconciles",
    async (_name, settled) => {
      const { fixture, env, source, destination, entry, destinationOptions } =
        await prepareProtectedCrossStore();
      insertProtectedSuggestion(source, env, "moved", "moved text");
      const interrupted = new Error("cleanup outcome unknown");
      let copied = false;
      await expect(
        migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env,
          mode: "doctor-fix",
          beforePersistentApply: () => {
            copied ||= readProtectedSuggestions(destination, env).length > 0;
            if (copied) {
              throw interrupted;
            }
          },
        }),
      ).rejects.toBe(interrupted);
      expect(readClaim(source)?.entry).toMatchObject(entry);
      expect(readProtectedSuggestions(source, env)).toHaveLength(1);
      expect(readProtectedSuggestions(destination, env)).toEqual([
        expect.objectContaining({ id: "moved", session_key: destination.key, text: "moved text" }),
      ]);
      if (!settled) {
        runOpenClawAgentWriteTransaction(({ db }) => {
          const sealed = sealSessionSuggestionFields(db, {
            id: "moved",
            session_key: destination.key,
            author_id: "author",
            author_label: "Author",
            text: "edited text",
          });
          db.prepare("UPDATE session_suggestions SET text = ? WHERE id = 'moved'").run(sealed.text);
        }, destinationOptions);
      }

      const retried = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env,
        mode: "doctor-fix",
      });

      expect(retried.complete).toBe(settled);
      expect(readProtectedSuggestions(destination, env)).toEqual([
        expect.objectContaining({ id: "moved", text: settled ? "moved text" : "edited text" }),
      ]);
      if (settled) {
        expect(outcomeKinds(retried)).toContain("canonical-exists-identical");
        expect(readClaim(source)).toBeUndefined();
        expect(readProtectedSuggestions(source, env)).toEqual([]);
      } else {
        expect(outcomeKinds(retried)).toEqual(["divergent-canonical"]);
        expect(readClaim(source)?.entry).toMatchObject(entry);
        expect(readProtectedSuggestions(source, env)).toEqual([
          expect.objectContaining({ id: "moved", text: "moved text" }),
        ]);
      }
    },
  );

  it("does not copy a protected suggestion added after the claim scan", async () => {
    const { fixture, env, source, destination, entry, destinationOptions } =
      await prepareProtectedCrossStore();
    const before = serializeStore(destination, env);
    let injected = false;

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env,
      mode: "doctor-fix",
      beforePersistentApply: () => {
        if (!injected) {
          injected = true;
          insertProtectedSuggestion(source, env, "late", "late suggestion");
        }
      },
    });

    expect(injected).toBe(true);
    expect(result.complete).toBe(false);
    // The copy transaction's claim fingerprint sees the new suggestion and refuses the copy.
    expect(outcomeKinds(result)).toEqual(["divergent-canonical"]);
    expect(readClaim(source)?.entry).toMatchObject(entry);
    expect(serializeStore(destination, destinationOptions.env)).toEqual(before);
  });

  it("rolls back every protected suggestion rekey when an in-place move is interrupted", async () => {
    const root = tempDirs.make("protected-in-place-migration-");
    const storePath = path.join(root, "sessions.sqlite");
    const keyPath = path.join(root, "key");
    fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    vi.stubEnv("OPENCLAW_PROTECTED_STORAGE_KEY_FILE", keyPath);
    const fixture = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: storePath },
    });
    const options = { agentId: "main", path: storePath, env: fixture.env };
    const preparatory = openNodeSqliteDatabase(storePath);
    try {
      await withAgentDatabaseMaintenanceLease({ env: fixture.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(preparatory, options);
      });
    } finally {
      preparatory.close();
    }
    const sourceKey = "agent:main:chat";
    const destinationKey = "agent:ops:chat";
    const source = { databaseAgentId: "main", databasePath: storePath, key: sourceKey };
    seedClaim(source);
    // More rows than one rekey batch prove the whole move shares one transaction.
    for (let index = 0; index < 65; index++) {
      insertProtectedSuggestion(
        source,
        fixture.env,
        String(index).padStart(3, "0"),
        `suggestion ${index}`,
      );
    }
    runOpenClawAgentWriteTransaction(
      (database) =>
        database.db.exec(`
          CREATE TRIGGER interrupt_suggestion_move BEFORE UPDATE OF session_key ON session_suggestions
          WHEN OLD.id = '064'
          BEGIN SELECT RAISE(ABORT, 'interrupted suggestion move'); END;
        `),
      options,
    );
    const assertRows = (expectedKey: string, wrongKey: string) =>
      runOpenClawAgentWriteTransaction((database) => {
        const rows = database.db
          .prepare(
            "SELECT id, session_key, author_id, author_label, text FROM session_suggestions ORDER BY id",
          )
          .all();
        expect(rows).toHaveLength(65);
        for (const [index, row] of rows.entries()) {
          expect(row.session_key).toBe(expectedKey);
          for (const [column, plaintext] of [
            ["author_id", "author"],
            ["author_label", "Author"],
            ["text", `suggestion ${index}`],
          ] as const) {
            const context = (key: string) =>
              protectedStorageValueContext("session_suggestions", column, [key, String(row.id)]);
            expect(
              openSqliteStorageText(database.db, String(row[column]), context(expectedKey)),
            ).toBe(plaintext);
            expect(() =>
              openSqliteStorageText(database.db, String(row[column]), context(wrongKey)),
            ).toThrow();
          }
        }
      }, options);

    await expect(
      recordHarnessDeletions(() =>
        migrateLegacyMainSessionKeys({ cfg: fixture.cfg, env: fixture.env, mode: "doctor-fix" }),
      ),
    ).rejects.toThrow("interrupted suggestion move");
    assertRows(sourceKey, destinationKey);
    runOpenClawAgentWriteTransaction(
      (database) => database.db.exec("DROP TRIGGER interrupt_suggestion_move"),
      options,
    );
    const { result } = await recordHarnessDeletions(() =>
      migrateLegacyMainSessionKeys({ cfg: fixture.cfg, env: fixture.env, mode: "doctor-fix" }),
    );
    expect(outcomeKinds(result)).toContain("migrated-in-place");
    assertRows(destinationKey, sourceKey);
  });

  it.each(["normal", "blocked-checkpoint", "denied-checkpoint", "incomplete-checkpoint"] as const)(
    "checkpoints a protected cross-store copy before deleting the source with %s",
    async (scenario) => {
      const { fixture, env, source, destination, entry, destinationOptions } =
        await prepareProtectedCrossStore();
      let injected = false;
      if (scenario === "blocked-checkpoint") {
        runOpenClawAgentWriteTransaction(({ db }) => {
          db.exec("PRAGMA busy_timeout=0");
        }, destinationOptions);
      }
      const blockingReader =
        scenario === "blocked-checkpoint"
          ? openNodeSqliteDatabase(destination.databasePath, { readOnly: true })
          : undefined;
      if (blockingReader) {
        blockingReader.exec("BEGIN");
        blockingReader.prepare("SELECT count(*) FROM session_nodes").get();
      }
      const denyingWriter =
        scenario === "denied-checkpoint" || scenario === "incomplete-checkpoint"
          ? openOpenClawAgentDatabase(destinationOptions).db
          : undefined;

      const migrate = () =>
        migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env,
          mode: "doctor-fix",
          beforePersistentApply: () => {
            if (
              !denyingWriter ||
              injected ||
              denyingWriter.isTransaction ||
              !denyingWriter
                .prepare("SELECT 1 FROM session_nodes WHERE session_key = ?")
                .get(destination.key)
            ) {
              return;
            }
            injected = true;
            if (scenario === "denied-checkpoint") {
              denyingWriter.setAuthorizer((action, name) =>
                action === constants.SQLITE_PRAGMA && name === "wal_checkpoint"
                  ? constants.SQLITE_DENY
                  : constants.SQLITE_OK,
              );
              return;
            }
            const prepare = denyingWriter.prepare.bind(denyingWriter);
            vi.spyOn(denyingWriter, "prepare").mockImplementation((sql) => {
              const statement = prepare(sql);
              if (sql === "PRAGMA wal_checkpoint(TRUNCATE);") {
                vi.spyOn(statement, "get").mockReturnValueOnce({
                  busy: 0,
                  log: 3,
                  checkpointed: 2,
                });
              }
              return statement;
            });
          },
        });
      if (blockingReader) {
        try {
          await expect(migrate()).rejects.toThrow("SQLite checkpoint remained busy");
          expect(readClaim(source)?.entry).toMatchObject(entry);
          expect(readClaim(destination)?.entry).toMatchObject(entry);
        } finally {
          blockingReader.exec("ROLLBACK");
          blockingReader.close();
        }
      }
      if (denyingWriter) {
        try {
          await expect(migrate()).rejects.toThrow(
            scenario === "denied-checkpoint" ? /not authorized/i : /checkpoint.*incomplete/i,
          );
          expect(injected).toBe(true);
          expect(readClaim(source)?.entry).toMatchObject(entry);
        } finally {
          denyingWriter.setAuthorizer(null);
          vi.restoreAllMocks();
        }
        await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
        expect(readClaim(destination)?.entry).toMatchObject(entry);
      }
      const result = await migrate();
      expect(result.complete).toBe(true);
      expect(outcomeKinds(result)).toContain(
        scenario === "normal" ? "migrated-cross-store" : "canonical-exists-identical",
      );
      expect(readClaim(source)).toBeUndefined();
      expect(readClaim(destination)?.entry).toMatchObject(entry);
    },
  );

  it("holds the destination write lock through every source commit and recovers after revocation", async () => {
    const { fixture, env, source, destination, entry } = await prepareProtectedCrossStore();
    const probe = new DatabaseSync(destination.databasePath, { timeout: 0 });
    const destinationLock = () => {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
        return "free";
      } catch (error) {
        if (!/locked|busy/i.test(String(error))) {
          throw error;
        }
        return "held";
      }
    };
    const observed: string[] = [];
    const revoked = new Error("Doctor SQLite maintenance authority has expired.");
    const migrate = (revoke: boolean) =>
      migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env,
        mode: "doctor-fix",
        beforePersistentApply: () => {
          const state = destinationLock();
          observed.push(state);
          if (revoke && state === "held") {
            throw revoked;
          }
        },
      });
    try {
      await expect(migrate(true)).rejects.toBe(revoked);
      expect(readClaim(source)?.entry).toMatchObject(entry);
      expect(destinationLock()).toBe("free");

      observed.length = 0;
      const result = await migrate(false);
      expect(result.complete).toBe(true);
      expect(outcomeKinds(result)).toContain("canonical-exists-identical");
      // Every source commit guard after verification ran while independent writers were excluded.
      const guarded = observed.slice(observed.indexOf("held"), observed.lastIndexOf("held") + 1);
      expect(guarded.length).toBeGreaterThan(1);
      expect(guarded.every((state) => state === "held")).toBe(true);
      expect(destinationLock()).toBe("free");
      expect(readClaim(source)).toBeUndefined();
      expect(readClaim(destination)?.entry).toMatchObject(entry);
    } finally {
      probe.close();
    }
  });

  it.each(["main", "ops"] as const)(
    "refuses retirement when %s agent admission is revoked at the source commit and recovers on rerun",
    async (revokedAgentId) => {
      const { fixture, env, source, destination, entry } = await prepareProtectedCrossStore();
      const locked = (file: string) => {
        const probe = new DatabaseSync(file, { timeout: 0 });
        try {
          probe.exec("BEGIN IMMEDIATE");
          probe.exec("ROLLBACK");
          return false;
        } catch (error) {
          if (!/locked|busy/i.test(String(error))) {
            throw error;
          }
          return true;
        } finally {
          probe.close();
        }
      };
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: revokedAgentId,
        paths: [revokedAgentId === "main" ? source.databasePath : destination.databasePath],
        reason: "revoked during cleanup",
      });
      let revoked = false;
      const result = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env,
        mode: "doctor-fix",
        beforePersistentApply: () => {
          // The reclamation worker holds the source write transaction only while awaiting commit authorization.
          if (!revoked && locked(destination.databasePath) && locked(source.databasePath)) {
            revoked = true;
            recordAgentDatabaseAdmissions([refusal], { env });
          }
        },
      }).catch((error: unknown) => error);
      recordAgentDatabaseAdmissions([], { env });
      expect(revoked).toBe(true);
      expect(result).toBeInstanceOf(AgentDatabaseAdmissionError);
      expect(readClaim(source)?.entry).toMatchObject(entry);
      expect(locked(destination.databasePath)).toBe(false);

      const recovered = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env,
        mode: "doctor-fix",
      });
      expect(recovered.complete).toBe(true);
      expect(readClaim(source)).toBeUndefined();
      expect(readClaim(destination)?.entry).toMatchObject(entry);
    },
  );
});
