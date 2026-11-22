import { randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  migrateAuthorizedUserFiles,
  verifyAuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import {
  loadStorageValueEncryptionFromFile,
  PROTECTED_STORAGE_KEY_FILE_ENV,
} from "../../src/storage/sqlite-encryption.js";
import { protectedMaxFileBytes } from "./settings.js";

function assertPrivateOwnedDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(`Protected ${label} must be a private directory owned by the service user.`);
  }
}

export function resolveProtectedStorageKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  if (
    !home ||
    !path.isAbsolute(home) ||
    !stateDir ||
    path.resolve(stateDir) !== path.resolve(home, "state") ||
    !configPath ||
    path.resolve(configPath) !== path.resolve(home, "config", "openclaw.json")
  ) {
    throw new Error("Protected storage key requires the validated service-home layout.");
  }
  const keyPath = path.join(home, "secrets", "storage-key");
  const configuredPath = env[PROTECTED_STORAGE_KEY_FILE_ENV];
  if (configuredPath && path.resolve(configuredPath) !== path.resolve(keyPath)) {
    throw new Error("Protected storage key must use the service-owned secrets/storage-key path.");
  }
  env[PROTECTED_STORAGE_KEY_FILE_ENV] = keyPath;
  return keyPath;
}

function assertProtectedStorageKeyDirectory(keyPath: string): void {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("Protected storage key requires HOME.");
  }
  assertPrivateOwnedDirectory(home, "service home");
  const secretsDir = path.dirname(keyPath);
  assertPrivateOwnedDirectory(secretsDir, "secrets directory");
  const homeRealPath = realpathSync(home);
  const secretsRealPath = realpathSync(secretsDir);
  if (
    path.dirname(secretsRealPath) !== homeRealPath ||
    path.basename(secretsRealPath) !== "secrets"
  ) {
    throw new Error("Protected storage secrets directory must remain inside the service home.");
  }
}

export function requireProtectedStorageEncryption() {
  const keyPath = process.env[PROTECTED_STORAGE_KEY_FILE_ENV];
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!keyPath || !stateDir) {
    throw new Error("Protected storage key path and state directory are required.");
  }
  assertProtectedStorageKeyDirectory(keyPath);
  try {
    return loadStorageValueEncryptionFromFile(keyPath, stateDir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Protected storage key is missing. Restore the existing key or, only for plaintext state, stop the listener and run the provision-storage-key maintenance command.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function assertAgentDatabaseMayReceiveNewKey(databasePath: string): Promise<void> {
  try {
    const fileStat = lstatSync(databasePath, { bigint: true });
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1n) {
      throw new Error("Protected agent database is not a regular, unlinked file.");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const [
    { DatabaseSync },
    { readSqliteUserVersion },
    { PROTECTED_ENCRYPTION_TABLE },
    { OPENCLAW_AGENT_SCHEMA_VERSION },
  ] = await Promise.all([
    import("node:sqlite"),
    import("../../src/infra/sqlite-user-version.js"),
    import("../../src/state/openclaw-agent-db-schema-read.js"),
    import("../../src/state/openclaw-agent-db-contract.js"),
  ]);
  // This maintenance-only read refuses encrypted state before it can create a key.
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = readSqliteUserVersion(database);
    const hasEncryptionMarker = Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(PROTECTED_ENCRYPTION_TABLE),
    );
    if (hasEncryptionMarker || version > OPENCLAW_AGENT_SCHEMA_VERSION) {
      throw new Error(
        "Protected agent storage may already be encrypted; refusing to generate a replacement key. Restore the original key.",
      );
    }
  } finally {
    database.close();
  }
}

async function createProtectedStorageKey(keyPath: string, stateDir: string): Promise<void> {
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  if (fsConstants.O_NOFOLLOW === undefined) {
    throw new Error("This platform cannot safely create the protected storage key.");
  }
  const key = randomBytes(32);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(keyPath, flags, 0o600);
    await file.writeFile(key);
    await file.sync();
  } catch (error) {
    if (file) {
      await file.close();
      file = undefined;
      try {
        await unlink(keyPath);
      } catch (cleanupError) {
        throw new Error(
          `Could not remove the incomplete protected storage key after ${String(error)}: ${String(cleanupError)}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  } finally {
    key.fill(0);
    await file?.close();
  }
  const encryption = loadStorageValueEncryptionFromFile(keyPath, stateDir);
  encryption.dispose();
}

export async function provisionProtectedStorageKeyAndMigrate(
  assertCurrent: () => void,
): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Protected storage key provisioning requires OPENCLAW_STATE_DIR.");
  }
  const keyPath = resolveProtectedStorageKeyFile();
  assertProtectedStorageKeyDirectory(keyPath);
  const stateRoot = await root(stateDir);
  await stateRoot.mkdir("users", {
    private: true,
    mutationSymlinks: "reject",
    assertBeforeMutation: assertCurrent,
  });
  const usersRoot = await root(path.join(stateRoot.rootReal, "users"));
  const { resolveOpenClawAgentSqlitePath } =
    await import("../../src/state/openclaw-agent-db.paths.js");
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "protected" });
  assertCurrent();
  let existingKey = false;
  try {
    const keyStat = await lstat(keyPath, { bigint: true });
    existingKey = keyStat.isFile();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (!existingKey) {
    await verifyAuthorizedUserFiles({
      usersRoot,
      assertCurrent,
      maxBytes: protectedMaxFileBytes,
    });
    await assertAgentDatabaseMayReceiveNewKey(databasePath);
    assertCurrent();
    await createProtectedStorageKey(keyPath, stateDir);
  }
  const encryption = requireProtectedStorageEncryption();
  try {
    await verifyAuthorizedUserFiles({
      usersRoot,
      assertCurrent,
      maxBytes: protectedMaxFileBytes,
      encryption,
    });
    assertCurrent();
    const { runOpenClawAgentWriteTransaction } =
      await import("../../src/state/openclaw-agent-db.js");
    runOpenClawAgentWriteTransaction(() => undefined, {
      agentId: "protected",
      env: process.env,
    });
    await migrateAuthorizedUserFiles({
      usersRoot,
      assertCurrent,
      maxBytes: protectedMaxFileBytes,
      encryption,
    });
    assertCurrent();
  } finally {
    encryption.dispose();
  }
}
