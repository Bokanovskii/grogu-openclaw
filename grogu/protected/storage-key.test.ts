import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROTECTED_SESSION_ENTRY_TABLE } from "../../src/config/sessions/session-entry-encryption.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { openSecretStoreValue } from "../../src/secrets/store/secret-store-encryption.js";
import { resolveOpenClawAgentSqlitePath } from "../../src/state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  loadStorageValueEncryptionFromFile,
  PROTECTED_STORAGE_KEY_FILE_ENV,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../../src/storage/sqlite-encryption.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

void test("the predecessor maintenance environment provisions and migrates without replacing a key", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-storage-key-"));
  const stateDir = path.join(home, "state");
  const configDir = path.join(home, "config");
  const secretsDir = path.join(home, "secrets");
  const keyPath = path.join(secretsDir, "storage-key");
  const sessionKey = "agent:protected:family:p:storage-migration";
  const profileId = "existing-file-owner";
  const plaintext = "existing-install-private-title";
  t.after(() => rm(home, { recursive: true, force: true }));
  await Promise.all([
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(secretsDir, { recursive: true, mode: 0o700 }),
  ]);
  const userDirectory = createHash("sha256").update(profileId).digest("hex");
  const userFilePath = path.join(stateDir, "users", userDirectory, "legacy.txt");
  await mkdir(path.dirname(userFilePath), { recursive: true, mode: 0o700 });
  await writeFile(userFilePath, plaintext, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
  };
  delete env[PROTECTED_STORAGE_KEY_FILE_ENV];
  const run = (scriptOrAction: string, isScript = false) =>
    spawnSync(
      process.execPath,
      isScript
        ? ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", scriptOrAction]
        : ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", scriptOrAction],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
  const seeded = run(
    `
      const { replaceSessionEntrySync } = await import("./src/config/sessions/session-accessor.js");
      replaceSessionEntrySync(
        { agentId: "protected", env: process.env, sessionKey: ${JSON.stringify(sessionKey)} },
        { sessionId: "storage-migration-session", updatedAt: 1, label: ${JSON.stringify(plaintext)} },
      );
      const { runOpenClawStateWriteTransaction } = await import("./src/state/openclaw-state-db.js");
      const { ensureSecretStoreSchema } = await import("./src/state/openclaw-state-db-schema-additive.js");
      runOpenClawStateWriteTransaction(({ db }) => {
        ensureSecretStoreSchema(db);
        db.prepare(
          "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("identity", "synthetic-member", "model-account:synthetic", "synthetic shared credential", "secret", 1, 1);
      }, { env: process.env });
    `,
    true,
  );
  assert.equal(seeded.status, 0, seeded.stderr);

  const migrated = run("provision-storage-key");
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /shared state, the agent store, and user files are encrypted/u);
  const admitted = run(
    `
      const { resolveProtectedStorageKeyFile } = await import("./grogu/protected/storage-key.js");
      const { acquireProtectedStateOwner } = await import("./grogu/protected/state-owner.js");
      const { admitProtectedPhysicalAgentStorage } = await import("./grogu/protected/agent-storage.js");
      const { loadExactSessionEntryReadOnly } = await import("./src/config/sessions/session-accessor.js");
      resolveProtectedStorageKeyFile();
      const owner = await acquireProtectedStateOwner(process.env.OPENCLAW_STATE_DIR);
      if (!owner) throw new Error("Could not acquire state owner");
      try {
        admitProtectedPhysicalAgentStorage(() => owner.assertCurrent());
        const row = loadExactSessionEntryReadOnly({ agentId: "protected", env: process.env, sessionKey: ${JSON.stringify(sessionKey)} });
        if (row?.entry.label !== ${JSON.stringify(plaintext)}) throw new Error("Migrated session did not survive admission");
      } finally {
        owner.release();
      }
    `,
    true,
  );
  assert.equal(admitted.status, 0, admitted.stderr);
  const originalKey = await readFile(keyPath);
  const keyStat = await lstat(keyPath, { bigint: true });
  assert.equal(keyStat.size, 32n);
  assert.equal(keyStat.mode & 0o777n, 0o600n);
  if (process.getuid) {
    assert.equal(keyStat.uid, BigInt(process.getuid()));
  }
  const encryptedFile = await readFile(userFilePath);
  assert.equal(encryptedFile.includes(Buffer.from(plaintext)), false);
  assert.ok(encryptedFile.subarray(0, 8).equals(Buffer.from("OCSEAL1\n")));
  const encryption = loadStorageValueEncryptionFromFile(keyPath, stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot: await root(path.join(stateDir, "users")),
    profileId,
    assertCurrent: () => undefined,
    maxBytes: 2 * 1024 * 1024,
    encryption,
  });
  try {
    assert.equal(await files.readText("legacy.txt"), plaintext);
  } finally {
    files.dispose();
    encryption.dispose();
  }

  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "protected", env });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 28);
    const encryptedEntry = database
      .prepare(
        `SELECT encrypted_entry_json FROM ${PROTECTED_SESSION_ENTRY_TABLE} WHERE session_key = ?`,
      )
      .get(sessionKey)?.encrypted_entry_json;
    if (typeof encryptedEntry !== "string") {
      throw new Error("Protected session entry was not persisted.");
    }
    assert.match(encryptedEntry, /^OCSEAL1:/u);
  } finally {
    database.close();
  }
  const shared = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  registerSqliteStorageValueEncryption(
    shared,
    loadStorageValueEncryptionFromFile(keyPath, stateDir),
  );
  try {
    assert.equal(shared.prepare("PRAGMA user_version").get()?.user_version, 21);
    assert.equal(
      shared.prepare("SELECT cleanup_pending FROM grogu_protected_shared_state").get()
        ?.cleanup_pending,
      0,
    );
    const stored = shared.prepare("SELECT value FROM secret_store_entries").get()?.value;
    assert.ok(typeof stored === "string");
    assert.match(stored, /^OCSEAL1:/u);
    setSqliteStorageValueEncryptionStrict(shared, true);
    assert.equal(
      openSecretStoreValue(
        shared,
        { scope_kind: "identity", scope_id: "synthetic-member", name: "model-account:synthetic" },
        stored,
      ),
      "synthetic shared credential",
    );
  } finally {
    disposeSqliteStorageValueEncryption(shared);
    shared.close();
  }
  const databaseDirectory = path.dirname(databasePath);
  const databaseFiles = await readdir(databaseDirectory);
  for (const name of [path.basename(databasePath), `${path.basename(databasePath)}-wal`]) {
    if (databaseFiles.includes(name)) {
      assert.equal(
        (await readFile(path.join(databaseDirectory, name))).includes(Buffer.from(plaintext)),
        false,
        `${name} retained plaintext session metadata`,
      );
    }
  }

  const retried = run("provision-storage-key");
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(await readFile(keyPath), originalKey);

  await unlink(userFilePath);
  await unlink(keyPath);
  const missingKey = run("provision-storage-key");
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /refusing to generate a replacement key/u);
  await assert.rejects(lstat(keyPath));

  const wrongKey = Buffer.alloc(32, 0x5a);
  await writeFile(keyPath, wrongKey, { mode: 0o600, flag: "wx" });
  const refusedWrongKey = run("provision-storage-key");
  assert.notEqual(refusedWrongKey.status, 0);
  assert.match(refusedWrongKey.stderr, /configured storage key/u);
  assert.deepEqual(await readFile(keyPath), wrongKey);
});

void test("refuses to create a key when user files are already encrypted", async (t) => {
  // openclaw-temp-dir: allow provides an isolated HOME for the real maintenance subprocess
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-file-key-"));
  const stateDir = path.join(home, "state");
  const configDir = path.join(home, "config");
  const secretsDir = path.join(home, "secrets");
  const keyPath = path.join(secretsDir, "storage-key");
  const profileId = "file-only-encrypted-profile";
  const userDirectory = createHash("sha256").update(profileId).digest("hex");
  const userFilePath = path.join(stateDir, "users", userDirectory, "private.txt");
  const plaintext = Buffer.from("encrypted before key loss");
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => rm(home, { recursive: true, force: true }));
  await Promise.all([
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(secretsDir, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(userFilePath), { recursive: true, mode: 0o700 }),
  ]);
  try {
    await writeFile(
      userFilePath,
      encryption.encrypt(plaintext, `openclaw:user-file:${userDirectory}`),
      { mode: 0o600 },
    );
  } finally {
    encryption.dispose();
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
  };
  delete env[PROTECTED_STORAGE_KEY_FILE_ENV];
  const result = spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "provision-storage-key"],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /user files are already encrypted; restore the original storage key/u,
  );
  await assert.rejects(lstat(keyPath));
  await assert.rejects(lstat(resolveOpenClawAgentSqlitePath({ agentId: "protected", env })));
  assert.equal((await readFile(userFilePath)).includes(plaintext), false);
});

void test("refuses to replace a missing key when shared state may be encrypted", async (t) => {
  // openclaw-temp-dir: allow provides an isolated HOME for the real maintenance subprocess
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-shared-key-"));
  const stateDir = path.join(home, "state");
  const configDir = path.join(home, "config");
  const secretsDir = path.join(home, "secrets");
  const keyPath = path.join(secretsDir, "storage-key");
  t.after(() => rm(home, { recursive: true, force: true }));
  await Promise.all([
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(secretsDir, { recursive: true, mode: 0o700 }),
  ]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
  };
  delete env[PROTECTED_STORAGE_KEY_FILE_ENV];
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  await mkdir(path.dirname(sharedPath), { recursive: true, mode: 0o700 });
  const shared = new DatabaseSync(sharedPath);
  shared.exec("PRAGMA user_version = 21");
  shared.close();

  const assertRefused = async () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "provision-storage-key"],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(keyPath));
    assert.match(result.stderr, /shared state.*refusing to generate a replacement key/iu);
    await assert.rejects(lstat(resolveOpenClawAgentSqlitePath({ agentId: "protected", env })));
  };
  await assertRefused();

  const marked = new DatabaseSync(sharedPath);
  marked.exec(
    "PRAGMA user_version = 20; CREATE TABLE grogu_protected_shared_state (id INTEGER PRIMARY KEY)",
  );
  marked.close();
  await assertRefused();

  const deferred = new DatabaseSync(sharedPath);
  deferred.exec(`
    DROP TABLE grogu_protected_shared_state;
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO config_machine_state (state_key, value_json)
      VALUES ('state.schema.contentVersion', '21');
  `);
  deferred.close();
  await assertRefused();
});
