import { statfsSync } from "node:fs";
import {
  createAuthorizedUserFiles,
  type AuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import { chatFilesDirectory } from "./chat-files.js";
import type { ProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";

const MiB = 1024 * 1024;
const chatBytes = 32 * 1024;
export type StorageLimits = { globalBytes: number; userBytes: number; freeFloorBytes: number };

function freeBytes(directory: string) {
  const { bavail, bsize } = statfsSync(directory, { bigint: true });
  return bavail * bsize;
}

export function measureStorageLimits(stateDir: string): StorageLimits {
  const available = freeBytes(stateDir);
  const freeFloorBytes = 512 * MiB;
  const globalBytes = Math.min(256 * MiB, Number(available - BigInt(freeFloorBytes)) / 16);
  if (globalBytes < 16 * MiB) {
    throw new Error("Insufficient free space for the Family pilot.");
  }
  return {
    globalBytes: Math.floor(globalBytes),
    userBytes: Math.floor(globalBytes / 4),
    freeFloorBytes,
  };
}

async function fileBytes(files: AuthorizedUserFiles, directory: string): Promise<number> {
  let names: string[];
  try {
    names = await files.list(directory);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return 0;
    }
    throw error;
  }
  let bytes = 4096;
  for (const name of names) {
    const relative = `${directory}/${name}`;
    const info = await files.stat(relative);
    bytes += info.isDirectory ? await fileBytes(files, relative) : info.size + 4096;
  }
  return bytes;
}

export function createStorageAdmission(
  options: Pick<Parameters<typeof createAuthorizedUserFiles>[0], "usersRoot"> & {
    stateDir: string;
    limits: StorageLimits;
    chats: ProtectedChats;
    maxFileBytes: number;
  },
) {
  let held = false;
  return async (profileId: string, assertCurrent: () => void, operation: "create" | "turn") => {
    if (held) {
      throw new ProtectedError(409, "storage_busy", "Another Family write is active. Try again.");
    }
    held = true;
    let active = true;
    const release = () => {
      if (active) {
        active = false;
        held = false;
      }
    };
    const assertDisk = () => {
      assertCurrent();
      if (!active) {
        throw new Error("Family storage admission closed");
      }
      if (freeBytes(options.stateDir) < BigInt(options.limits.freeFloorBytes)) {
        throw new ProtectedError(507, "storage_full", "Family storage is low. Contact the host.");
      }
    };
    try {
      assertDisk();
      let global = 0;
      let personal = 0;
      for (const entry of await options.chats.capacityEntries()) {
        assertCurrent();
        const files = await createAuthorizedUserFiles({
          usersRoot: options.usersRoot,
          profileId: entry.profileId,
          assertCurrent,
          maxBytes: options.maxFileBytes,
        });
        try {
          const bytes =
            chatBytes +
            (await options.chats.transcriptBytes(entry.id, entry.sessionKey)) +
            (entry.chargeFiles ? await fileBytes(files, chatFilesDirectory(entry.id)) : 0);
          global += bytes;
          if (entry.profileId === profileId) {
            personal += bytes;
          }
        } finally {
          files.dispose();
        }
      }
      let remaining = Math.min(
        options.limits.userBytes - personal,
        options.limits.globalBytes - global,
        8 * MiB,
      );
      let failure: ProtectedError | undefined;
      const charge = (bytes: number) => {
        try {
          assertDisk();
          if (remaining < bytes) {
            throw new ProtectedError(
              413,
              "quota_exceeded",
              "Family storage budget is full. Delete a chat to free space.",
            );
          }
          remaining -= bytes;
        } catch (error) {
          if (error instanceof ProtectedError) {
            failure = error;
          }
          throw error;
        }
      };
      charge(operation === "create" ? chatBytes : 16 * 1024);
      return {
        release,
        charge,
        chargeChatCreation() {
          charge(chatBytes);
        },
        assertResult() {
          if (failure) {
            throw failure;
          }
        },
        files(files: AuthorizedUserFiles): AuthorizedUserFiles {
          const checked = (data: string | Buffer) => {
            if (Buffer.byteLength(data) > options.maxFileBytes) {
              failure = new ProtectedError(
                413,
                "file_too_large",
                "A generated file exceeds the Family file limit.",
              );
              throw failure;
            }
            charge(Buffer.byteLength(data) + 4096);
          };
          return {
            ...files,
            create(name, data) {
              checked(data);
              return files.create(name, data);
            },
            write(name, data) {
              checked(data);
              return files.write(name, data);
            },
            mkdir(name) {
              charge(4096);
              return files.mkdir(name);
            },
          };
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  };
}
