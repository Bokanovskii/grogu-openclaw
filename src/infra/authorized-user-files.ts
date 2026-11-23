import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "@openclaw/fs-safe/advanced";
import type { Root as FsRoot } from "@openclaw/fs-safe/root";
import { isStorageValueEncrypted, type StorageValueEncryption } from "../storage/encryption.js";
import { FsSafeError, root as openRoot } from "./fs-safe.js";
import { retainMutationAuthority } from "./mutation-authority.js";

const MIGRATION_DIRECTORY = ".openclaw-protected-storage-migration";
const MIGRATION_MARKER_FILE = "owner";
const MIGRATION_MARKER_PATH = `${MIGRATION_DIRECTORY}/${MIGRATION_MARKER_FILE}`;
const MIGRATION_MARKER_VALUE = "openclaw-protected-user-files-v1\n";

type UserFilesRoot = Pick<FsRoot, "mkdir" | "rootReal" | "stat">;
type UserFilesMigrationRoot = UserFilesRoot & Pick<FsRoot, "list">;

export type AuthorizedUserFiles = {
  assertCurrent(): void;
  read(name: string): Promise<Buffer>;
  readText(name: string): Promise<string>;
  list(name?: string): Promise<string[]>;
  stat(name: string): Promise<Awaited<ReturnType<FsRoot["stat"]>> & { storedSize: number }>;
  storedSize(plaintextBytes: number): number;
  mkdir(name: string): Promise<void>;
  create(name: string, data: string | Buffer): Promise<void>;
  write(name: string, data: string | Buffer): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  removeEmptyDirectory(name: string): Promise<void>;
  dispose(): void;
};

export type UserFileScope = {
  files: AuthorizedUserFiles;
  directory: string;
  /** Opaque server-owned profile, chat, and grant binding. */
  cacheKey: string;
};

function relativeName(name: string, allowRoot = false): string {
  if (allowRoot && name === "") {
    return ".";
  }
  if (
    !name ||
    name.includes("\\") ||
    name.includes("%") ||
    name.includes(":") ||
    /\p{Cc}/u.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === ".." || part === "~") ||
    name.split("/")[0] === MIGRATION_DIRECTORY
  ) {
    throw new FsSafeError("invalid-path", "File path must stay inside your file directory.");
  }
  return name;
}

type AuthorizedUserFilesOwner = {
  files: AuthorizedUserFiles;
  verifyExisting(): Promise<void>;
  migrateToEncrypted(): Promise<void>;
};

async function createAuthorizedUserFilesOwner(options: {
  usersRoot: UserFilesRoot;
  userDirectory: string;
  createDirectory: boolean;
  assertCurrent: () => void;
  signal?: AbortSignal;
  maxBytes: number;
  encryption?: StorageValueEncryption;
}): Promise<AuthorizedUserFilesOwner> {
  if (
    !/^[a-f0-9]{64}$/u.test(options.userDirectory) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0
  ) {
    throw new TypeError(
      "User file admission requires a profile directory and positive byte limit.",
    );
  }
  let disposed = false;
  const encryption = options.encryption;
  const storedSize = (bytes: number) => encryption?.storedSize(bytes) ?? bytes;
  const assertCurrent = retainMutationAuthority(() => {
    if (disposed) {
      throw new Error("User file authority is closed.");
    }
    options.signal?.throwIfAborted();
    options.assertCurrent();
  });
  assertCurrent();
  const userDirectory = options.userDirectory;
  const encryptionContext = `openclaw:user-file:${userDirectory}`;
  if (options.createDirectory) {
    await options.usersRoot.mkdir(userDirectory, {
      private: true,
      mutationSymlinks: "reject",
      assertBeforeMutation: assertCurrent,
    });
  }
  assertCurrent();
  const expectedPath = path.join(options.usersRoot.rootReal, userDirectory);
  const admitted = await options.usersRoot.stat(userDirectory);
  assertCurrent();
  const stat = fs.lstatSync(expectedPath, { bigint: true });
  if (
    !admitted.isDirectory ||
    admitted.isSymbolicLink ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== BigInt(admitted.dev) ||
    stat.ino !== BigInt(admitted.ino)
  ) {
    throw new FsSafeError("path-mismatch", "User file directory changed during admission.");
  }
  const root = await openRoot(expectedPath, {
    hardlinks: "reject",
    symlinks: "reject",
    mutationSymlinks: "reject",
    assertBeforeMutation: () => {
      assertCurrent();
      assertDirectoryIdentitySync(expectedPath, {
        dev: stat.dev,
        ino: stat.ino,
        realPath: expectedPath,
      });
    },
    maxBytes: storedSize(options.maxBytes),
    mode: 0o600,
  });
  if (root.rootReal !== expectedPath) {
    throw new FsSafeError("path-mismatch", "User file directory changed during admission.");
  }
  const assertDirectory = () => {
    assertCurrent();
    assertDirectoryIdentitySync(expectedPath, {
      dev: stat.dev,
      ino: stat.ino,
      realPath: expectedPath,
    });
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertDirectory();
    const result = await operation();
    assertDirectory();
    return result;
  };
  const boundedData = (data: string | Buffer) => {
    if (Buffer.byteLength(data) > options.maxBytes) {
      throw new FsSafeError("too-large", "File exceeds the allowed size.");
    }
    return encryption ? encryption.encrypt(Buffer.from(data), encryptionContext) : data;
  };
  const read = async (name: string) => {
    const data = await root.readBytes(relativeName(name));
    assertDirectory();
    return encryption ? encryption.decrypt(data, encryptionContext) : data;
  };
  const files: AuthorizedUserFiles = {
    assertCurrent,
    read: (name) => run(() => read(name)),
    readText: (name) => run(async () => (await read(name)).toString("utf8")),
    list: (name = "") => run(() => root.list(relativeName(name, true))),
    stat: (name) =>
      run(async () => {
        const result = await root.stat(relativeName(name));
        if (result.isSymbolicLink || (result.isFile && result.nlink !== 1)) {
          throw new FsSafeError("path-alias", "File links are not available.");
        }
        return {
          ...result,
          size: result.isFile && encryption ? encryption.plaintextSize(result.size) : result.size,
          storedSize: result.size,
        };
      }),
    storedSize,
    mkdir: (name) => run(() => root.mkdir(relativeName(name), { private: true })),
    create: (name, data) =>
      run(() =>
        root.create(relativeName(name), boundedData(data), {
          atomic: true,
          private: true,
          mkdir: true,
        }),
      ),
    write: (name, data) =>
      run(() => root.write(relativeName(name), boundedData(data), { mkdir: true })),
    move: (from, to) => run(() => root.move(relativeName(from), relativeName(to))),
    remove: (name) =>
      run(() =>
        root.remove(relativeName(name), {
          recursive: true,
          force: false,
          maxEntries: 10_000,
          maxDepth: 32,
          signal: options.signal,
        }),
      ),
    removeEmptyDirectory: (name) =>
      run(() => root.remove(relativeName(name), { recursive: false, force: false })),
    dispose: () => {
      disposed = true;
    },
  };

  const walkFiles = async (
    directory: string,
    visit: (name: string) => Promise<void>,
    skipMigrationDirectory = false,
  ): Promise<void> => {
    const entries = await root.list(directory || ".", { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (!directory && skipMigrationDirectory && entry.name === MIGRATION_DIRECTORY) {
        continue;
      }
      if (
        entry.isSymbolicLink ||
        (!entry.isDirectory && !entry.isFile) ||
        (entry.isFile && entry.nlink !== 1)
      ) {
        throw new FsSafeError("path-alias", "User file migration found a linked or special file.");
      }
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walkFiles(name, visit, skipMigrationDirectory);
      } else {
        await visit(name);
      }
    }
  };

  const decodeStored = (value: Buffer): Buffer => {
    if (!isStorageValueEncrypted(value)) {
      if (value.length > options.maxBytes) {
        throw new FsSafeError("too-large", "File exceeds the allowed size.");
      }
      return value;
    }
    if (!encryption) {
      throw new Error(
        "Protected user files are already encrypted; restore the original storage key.",
      );
    }
    let plaintext: Buffer;
    try {
      plaintext = encryption.decrypt(value, encryptionContext);
    } catch (error) {
      throw new Error(
        "Protected user-file ciphertext could not be authenticated with the configured storage key; restore the original key or investigate corruption.",
        { cause: error },
      );
    }
    if (plaintext.length > options.maxBytes) {
      throw new FsSafeError("too-large", "File exceeds the allowed size.");
    }
    return plaintext;
  };

  // Recursive removal may unlink the marker before its now-empty staging directories.
  const migrationAreaContainsOnlyEmptyDirectories = async (directory: string): Promise<boolean> => {
    const entries = await root.list(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymbolicLink) {
        return false;
      }
      if (!(await migrationAreaContainsOnlyEmptyDirectories(`${directory}/${entry.name}`))) {
        return false;
      }
    }
    return true;
  };

  const migrationAreaState = async (): Promise<"missing" | "empty" | "ready"> => {
    let migrationStat: Awaited<ReturnType<FsRoot["stat"]>>;
    try {
      migrationStat = await root.stat(MIGRATION_DIRECTORY);
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "not-found") {
        return "missing";
      }
      throw error;
    }
    if (!migrationStat.isDirectory || migrationStat.isSymbolicLink) {
      throw new Error("Protected user-file migration path is occupied by unexpected data.");
    }
    const entries = await root.list(MIGRATION_DIRECTORY, { withFileTypes: true });
    if (!entries.some((entry) => entry.name === MIGRATION_MARKER_FILE)) {
      if (await migrationAreaContainsOnlyEmptyDirectories(MIGRATION_DIRECTORY)) {
        return "empty";
      }
      throw new Error("Protected user-file migration found unowned staging data.");
    }
    if ((await root.readText(MIGRATION_MARKER_PATH)) !== MIGRATION_MARKER_VALUE) {
      throw new Error("Protected user-file migration marker is invalid.");
    }
    return "ready";
  };

  const verifyExisting = async () =>
    run(async () => {
      await walkFiles(
        "",
        async (name) => {
          decodeStored(await root.readBytes(relativeName(name)));
        },
        true,
      );
      if ((await migrationAreaState()) !== "ready") {
        return;
      }
      await walkFiles(MIGRATION_DIRECTORY, async (stagedName) => {
        if (stagedName === MIGRATION_MARKER_PATH) {
          return;
        }
        const targetName = stagedName.slice(MIGRATION_DIRECTORY.length + 1);
        const staged = await root.readBytes(stagedName);
        if (!isStorageValueEncrypted(staged)) {
          throw new Error("Protected user-file migration found an unencrypted staged copy.");
        }
        const stagedPlaintext = decodeStored(staged);
        const target = await root.readBytes(relativeName(targetName));
        if (!stagedPlaintext.equals(decodeStored(target))) {
          throw new Error("Protected user file changed while a staged copy was pending.");
        }
      });
    });

  const ensureMigrationArea = async () => {
    const state = await migrationAreaState();
    if (state === "missing") {
      await root.mkdir(MIGRATION_DIRECTORY, { private: true });
    } else if (state === "ready") {
      return;
    }
    await root.create(MIGRATION_MARKER_PATH, MIGRATION_MARKER_VALUE, {
      atomic: true,
      private: true,
    });
  };

  const migrateFile = async (name: string) => {
    const original = await root.readBytes(name);
    const plaintext = decodeStored(original);
    const stagedName = `${MIGRATION_DIRECTORY}/${name}`;
    if (isStorageValueEncrypted(original)) {
      let staged: Buffer | undefined;
      try {
        staged = await root.readBytes(stagedName);
      } catch (error) {
        if (!(error instanceof FsSafeError && error.code === "not-found")) {
          throw error;
        }
      }
      if (staged) {
        if (!isStorageValueEncrypted(staged) || !decodeStored(staged).equals(plaintext)) {
          throw new Error("Protected user-file migration found a conflicting staged copy.");
        }
        await root.remove(stagedName);
      }
      return;
    }
    if (!encryption) {
      throw new Error("Protected user-file migration requires the original storage key.");
    }
    let staged: Buffer;
    try {
      staged = await root.readBytes(stagedName);
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        throw error;
      }
      await root.create(stagedName, encryption.encrypt(plaintext, encryptionContext), {
        atomic: true,
        private: true,
        mkdir: true,
      });
      staged = await root.readBytes(stagedName);
    }
    if (!isStorageValueEncrypted(staged) || !decodeStored(staged).equals(plaintext)) {
      throw new Error("Protected user-file encrypted staging copy failed read-back verification.");
    }
    if (!(await root.readBytes(name)).equals(original)) {
      throw new Error(
        "Protected user file changed during migration; retry with the listener stopped.",
      );
    }
    assertDirectory();
    await root.move(stagedName, name, { overwrite: true });
    const promoted = await root.readBytes(name);
    if (
      !promoted.equals(staged) ||
      !isStorageValueEncrypted(promoted) ||
      !decodeStored(promoted).equals(plaintext)
    ) {
      throw new Error("Protected user-file migration failed verification after replacement.");
    }
  };

  const migrateToEncrypted = async () =>
    run(async () => {
      if (!encryption) {
        throw new Error("Protected user-file migration requires the original storage key.");
      }
      await ensureMigrationArea();
      await walkFiles("", async (name) => await migrateFile(relativeName(name)), true);
      let markerFound = false;
      await walkFiles(MIGRATION_DIRECTORY, async (name) => {
        if (name !== MIGRATION_MARKER_PATH) {
          throw new Error("Protected user-file migration left unverified staged data.");
        }
        markerFound = true;
      });
      if (!markerFound) {
        throw new Error("Protected user-file migration marker is missing.");
      }
      await root.remove(MIGRATION_DIRECTORY, {
        recursive: true,
        force: false,
        maxEntries: 1_000_000,
        maxDepth: 32,
        signal: options.signal,
      });
    });

  return { files, verifyExisting, migrateToEncrypted };
}

async function forEachAuthorizedUserFilesOwner(
  options: {
    usersRoot: UserFilesMigrationRoot;
    assertCurrent: () => void;
    maxBytes: number;
    encryption?: StorageValueEncryption;
    allowUnrelatedEntries?: boolean;
    onlyUserDirectory?: string;
  },
  operation: (owner: AuthorizedUserFilesOwner, userDirectory: string) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("User file migration requires a positive byte limit.");
  }
  options.assertCurrent();
  const entries = await options.usersRoot.list(".", { withFileTypes: true });
  options.assertCurrent();
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (options.onlyUserDirectory && entry.name !== options.onlyUserDirectory) {
      continue;
    }
    if (options.allowUnrelatedEntries && !/^[a-f0-9]{64}$/u.test(entry.name)) {
      continue;
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.isDirectory || entry.isSymbolicLink) {
      throw new Error(
        "Protected user-file root contains an unexpected entry; inspect it before startup.",
      );
    }
    const owner = await createAuthorizedUserFilesOwner({
      usersRoot: options.usersRoot,
      userDirectory: entry.name,
      createDirectory: false,
      assertCurrent: options.assertCurrent,
      maxBytes: options.maxBytes,
      encryption: options.encryption,
    });
    try {
      await operation(owner, entry.name);
    } finally {
      owner.files.dispose();
    }
  }
}

export function authorizedUserFilesDirectory(profileId: string): string {
  return createHash("sha256").update(profileId).digest("hex");
}

/** Measure ciphertext and directory entries without exposing another member's files. */
export async function measureAuthorizedUserFileTree(
  files: AuthorizedUserFiles,
  directory: string,
  entryOverhead: number,
): Promise<number> {
  let names: string[];
  try {
    names = await files.list(directory);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return 0;
    }
    throw error;
  }
  let bytes = entryOverhead;
  for (const name of names) {
    const relative = `${directory}/${name}`;
    const info = await files.stat(relative);
    bytes += info.isDirectory
      ? await measureAuthorizedUserFileTree(files, relative, entryOverhead)
      : info.storedSize + entryOverhead;
  }
  return bytes;
}

/** Snapshot one named subtree across admitted user directories for global storage accounting. */
export async function measureAuthorizedUserFileTrees(options: {
  usersRoot: UserFilesMigrationRoot;
  assertCurrent: () => void;
  maxBytes: number;
  encryption?: StorageValueEncryption;
  directory: string;
  entryOverhead: number;
  profileId?: string;
}): Promise<Map<string, number>> {
  relativeName(options.directory);
  if (!Number.isSafeInteger(options.entryOverhead) || options.entryOverhead < 0) {
    throw new TypeError("User file measurement requires a valid entry overhead.");
  }
  const measured = new Map<string, number>();
  await forEachAuthorizedUserFilesOwner(
    {
      ...options,
      allowUnrelatedEntries: true,
      ...(options.profileId !== undefined
        ? { onlyUserDirectory: authorizedUserFilesDirectory(options.profileId) }
        : {}),
    },
    async (owner, userDirectory) => {
      const bytes = await measureAuthorizedUserFileTree(
        owner.files,
        options.directory,
        options.entryOverhead,
      );
      if (bytes > 0) {
        measured.set(userDirectory, bytes);
      }
    },
  );
  return measured;
}

/** Run one short operation through each admitted member-file owner. */
export async function forEachAuthorizedUserFiles(
  options: {
    usersRoot: UserFilesMigrationRoot;
    assertCurrent: () => void;
    maxBytes: number;
    encryption?: StorageValueEncryption;
  },
  operation: (files: AuthorizedUserFiles, userDirectory: string) => Promise<void>,
): Promise<void> {
  await forEachAuthorizedUserFilesOwner(
    { ...options, allowUnrelatedEntries: true },
    async (owner, userDirectory) => {
      options.assertCurrent();
      await operation(owner.files, userDirectory);
      options.assertCurrent();
    },
  );
}

export async function verifyAuthorizedUserFiles(options: {
  usersRoot: UserFilesMigrationRoot;
  assertCurrent: () => void;
  maxBytes: number;
  encryption?: StorageValueEncryption;
}): Promise<void> {
  await forEachAuthorizedUserFilesOwner(options, (owner) => owner.verifyExisting());
}

export async function migrateAuthorizedUserFiles(options: {
  usersRoot: UserFilesMigrationRoot;
  assertCurrent: () => void;
  maxBytes: number;
  encryption: StorageValueEncryption;
}): Promise<void> {
  await forEachAuthorizedUserFilesOwner(options, (owner) => owner.migrateToEncrypted());
}

/**
 * The authenticated request selects profileId. Session owners and client fields
 * must never select it. usersRoot is admitted once by the service at startup.
 */
export async function createAuthorizedUserFiles(options: {
  usersRoot: UserFilesRoot;
  profileId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  maxBytes: number;
  encryption?: StorageValueEncryption;
}): Promise<AuthorizedUserFiles> {
  if (!options.profileId || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("User file admission requires a profile and a positive byte limit.");
  }
  const userDirectory = authorizedUserFilesDirectory(options.profileId);
  const owner = await createAuthorizedUserFilesOwner({
    ...options,
    userDirectory,
    createDirectory: true,
  });
  return owner.files;
}
