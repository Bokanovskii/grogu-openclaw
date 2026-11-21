import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "@openclaw/fs-safe/advanced";
import type { Root as FsRoot } from "@openclaw/fs-safe/root";
import type { StorageValueEncryption } from "../storage/encryption.js";
import { FsSafeError, root as openRoot } from "./fs-safe.js";
import { retainMutationAuthority } from "./mutation-authority.js";

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
    name.split("/").some((part) => !part || part === "." || part === ".." || part === "~")
  ) {
    throw new FsSafeError("invalid-path", "File path must stay inside your file directory.");
  }
  return name;
}

/**
 * The authenticated request selects profileId. Session owners and client fields
 * must never select it. usersRoot is admitted once by the service at startup.
 */
export async function createAuthorizedUserFiles(options: {
  usersRoot: Pick<FsRoot, "mkdir" | "rootReal" | "stat">;
  profileId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  maxBytes: number;
  encryption?: StorageValueEncryption;
}): Promise<AuthorizedUserFiles> {
  if (!options.profileId || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("User file admission requires a profile and a positive byte limit.");
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
  const userDirectory = createHash("sha256").update(options.profileId).digest("hex");
  const encryptionContext = `openclaw:user-file:${userDirectory}`;
  await options.usersRoot.mkdir(userDirectory, {
    private: true,
    mutationSymlinks: "reject",
    assertBeforeMutation: assertCurrent,
  });
  assertCurrent();
  const expectedPath = path.join(options.usersRoot.rootReal, userDirectory);
  const admitted = await options.usersRoot.stat(userDirectory);
  assertCurrent();
  // Capture the exact directory instead of resolving a potentially replaced
  // link into a new root. fs-safe retains this identity through each operation.
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
    dispose: () => {
      disposed = true;
    },
  };
  return files;
}
