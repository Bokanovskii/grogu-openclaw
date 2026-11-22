import { statfsSync } from "node:fs";
import type { ProtectedChatStorage } from "@openclaw/gateway-protocol/protected";
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
    throw new Error("Insufficient free space for Alcove.");
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
    bytes += info.isDirectory ? await fileBytes(files, relative) : info.storedSize + 4096;
  }
  return bytes;
}

type StorageMeasurementOptions = Pick<
  Parameters<typeof createAuthorizedUserFiles>[0],
  "usersRoot" | "encryption"
> & {
  chats: Pick<ProtectedChats, "capacityEntries" | "transcriptBytes">;
  maxFileBytes: number;
};

export async function measureProtectedStorage(
  options: StorageMeasurementOptions,
  profileId: string,
  assertCurrent: () => void,
  includeOtherProfiles: boolean,
  onPersonalChat?: (chat: ProtectedChatStorage["chats"][number]) => void,
  onEntry?: (
    entry: Awaited<ReturnType<ProtectedChats["capacityEntries"]>>[number],
    bytes: number,
  ) => void,
) {
  let globalBytes = 0;
  let personalBytes = 0;
  let chatCount = 0;
  let lastChatActivityAt: number | null = null;
  for (const entry of await options.chats.capacityEntries()) {
    assertCurrent();
    if (!includeOtherProfiles && entry.profileId !== profileId) {
      continue;
    }
    const files = await createAuthorizedUserFiles({
      usersRoot: options.usersRoot,
      profileId: entry.profileId,
      assertCurrent,
      maxBytes: options.maxFileBytes,
      encryption: options.encryption,
    });
    try {
      const bytes =
        chatBytes +
        (await options.chats.transcriptBytes(entry.id, entry.sessionKey)) +
        (await fileBytes(files, chatFilesDirectory(entry.id)));
      globalBytes += bytes;
      onEntry?.(entry, bytes);
      if (entry.profileId === profileId) {
        personalBytes += bytes;
        if (!entry.transient) {
          chatCount++;
          lastChatActivityAt = Math.max(lastChatActivityAt ?? entry.updatedAt, entry.updatedAt);
          onPersonalChat?.({
            id: entry.id,
            title: entry.title ?? "New chat",
            version: String(entry.updatedAt),
            updatedAt: entry.updatedAt,
            approximateBytes: bytes,
          });
        }
      }
    } finally {
      files.dispose();
    }
  }
  assertCurrent();
  return { globalBytes, personalBytes, chatCount, lastChatActivityAt };
}

export function createStorageAdmission(
  options: StorageMeasurementOptions & {
    stateDir: string;
    limits: StorageLimits;
  },
) {
  let pending = Promise.resolve();
  type Reservation = { profileId: string };
  type Ledger = {
    globalBytes: number;
    users: Map<string, number>;
    active: Set<Reservation>;
    baseline: Map<string, { profileId: string; id: string; bytes: number }>;
  };
  const entryKey = (entry: { profileId: string; id: string; sessionKey: string }) =>
    JSON.stringify([entry.profileId, entry.id, entry.sessionKey]);
  const chatKey = (profileId: string, id: string) => JSON.stringify([profileId, id]);
  let ledger: Ledger | undefined;
  let scanInProgress: Promise<void> | undefined;
  let deletedDuringScan: Set<string> | undefined;
  let pendingFileWrites = 0;
  const fileWriters = new Map<string, Promise<void>>();
  const forgetChat = (account: Ledger, profileId: string, id: string) => {
    for (const [key, entry] of account.baseline) {
      if (entry.profileId === profileId && entry.id === id) {
        account.globalBytes -= entry.bytes;
        account.users.set(profileId, (account.users.get(profileId) ?? 0) - entry.bytes);
        account.baseline.delete(key);
      }
    }
  };
  const admit = async (
    profileId: string,
    assertCurrent: () => void,
    operation: "create" | "turn",
  ) => {
    const previous = pending;
    let unlock!: () => void;
    pending = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    let active = true;
    let pendingWrites = 0;
    let currentLedger: Ledger | undefined;
    let currentReservation: Reservation | undefined;
    const finishReservation = () => {
      if (!active && pendingWrites === 0 && currentLedger && currentReservation) {
        currentLedger.active.delete(currentReservation);
        if (currentLedger.active.size === 0 && ledger === currentLedger) {
          ledger = undefined;
        }
      }
    };
    const release = () => {
      if (active) {
        active = false;
        finishReservation();
      }
    };
    const assertDisk = () => {
      assertCurrent();
      if (!active) {
        throw new Error("Alcove storage admission closed");
      }
      if (freeBytes(options.stateDir) < BigInt(options.limits.freeFloorBytes)) {
        throw new ProtectedError(
          507,
          "storage_full",
          "The server is low on storage. Contact the server operator.",
        );
      }
    };
    try {
      assertDisk();
      const measure = async () => {
        const deleted = new Set<string>();
        deletedDuringScan = deleted;
        let finishScan!: () => void;
        scanInProgress = new Promise<void>((resolve) => {
          finishScan = resolve;
        });
        try {
          const users = new Map<string, number>();
          const baseline = new Map<string, { profileId: string; id: string; bytes: number }>();
          const { globalBytes } = await measureProtectedStorage(
            options,
            profileId,
            assertCurrent,
            true,
            undefined,
            (entry, bytes) => {
              users.set(entry.profileId, (users.get(entry.profileId) ?? 0) + bytes);
              baseline.set(entryKey(entry), { profileId: entry.profileId, id: entry.id, bytes });
            },
          );
          const account: Ledger = {
            globalBytes,
            users,
            active: new Set<Reservation>(),
            baseline,
          };
          for (const entry of baseline.values()) {
            if (deleted.has(chatKey(entry.profileId, entry.id))) {
              forgetChat(account, entry.profileId, entry.id);
            }
          }
          ledger = account;
        } finally {
          deletedDuringScan = undefined;
          scanInProgress = undefined;
          finishScan();
        }
      };
      if (!ledger) {
        await measure();
      } else {
        const initial = operation === "create" ? chatBytes : 16 * 1024;
        if (
          pendingFileWrites === 0 &&
          (ledger.globalBytes + initial > options.limits.globalBytes ||
            (ledger.users.get(profileId) ?? 0) + initial > options.limits.userBytes)
        ) {
          const existing = ledger;
          const entries = await options.chats.capacityEntries();
          assertCurrent();
          if (ledger !== existing) {
            await measure();
          } else {
            const present = new Set(entries.map(entryKey));
            // Reclaim only the original measured bytes of deleted chats. New
            // charges remain reserved, even when their writes are already visible.
            for (const [key, entry] of existing.baseline) {
              if (!present.has(key)) {
                existing.globalBytes -= entry.bytes;
                existing.users.set(
                  entry.profileId,
                  (existing.users.get(entry.profileId) ?? 0) - entry.bytes,
                );
                existing.baseline.delete(key);
              }
            }
          }
        }
      }
      const account = ledger;
      if (!account) {
        throw new Error("Alcove storage measurement did not complete");
      }
      const reservation: Reservation = { profileId };
      currentLedger = account;
      currentReservation = reservation;
      account.active.add(reservation);
      let remaining = 8 * MiB;
      let failure: ProtectedError | undefined;
      const charge = (bytes: number) => {
        try {
          assertDisk();
          const userBytes = account.users.get(profileId) ?? 0;
          if (
            remaining < bytes ||
            options.limits.userBytes - userBytes < bytes ||
            options.limits.globalBytes - account.globalBytes < bytes
          ) {
            throw new ProtectedError(
              413,
              "quota_exceeded",
              "Storage limit reached. Delete a chat to free space.",
            );
          }
          remaining -= bytes;
          account.globalBytes += bytes;
          account.users.set(profileId, userBytes + bytes);
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
        recordCreatedChat(id: string, sessionKey: string) {
          if (operation !== "create") {
            throw new Error("Only chat creation can record a new chat");
          }
          account.baseline.set(entryKey({ profileId, id, sessionKey }), {
            profileId,
            id,
            bytes: chatBytes,
          });
        },
        assertResult() {
          if (failure) {
            throw failure;
          }
        },
        files(files: AuthorizedUserFiles): AuthorizedUserFiles {
          const checked = (name: string, data: string | Buffer) => {
            if (Buffer.byteLength(data) > options.maxFileBytes) {
              failure = new ProtectedError(
                413,
                "file_too_large",
                "A generated file exceeds the file size limit.",
              );
              throw failure;
            }
            return files.storedSize(Buffer.byteLength(data)) + name.split("/").length * 4096;
          };
          const withFileLock = async (write: () => Promise<void>) => {
            const previousWriter = fileWriters.get(profileId);
            let unlockWriter!: () => void;
            const nextWriter = new Promise<void>((resolve) => {
              unlockWriter = resolve;
            });
            fileWriters.set(profileId, nextWriter);
            try {
              await previousWriter;
              await write();
            } finally {
              if (fileWriters.get(profileId) === nextWriter) {
                fileWriters.delete(profileId);
              }
              unlockWriter();
            }
          };
          const size = async (name: string, directoryOnly = false) => {
            try {
              const info = await files.stat(name);
              return directoryOnly && !info.isDirectory
                ? 0
                : 4096 + (info.isDirectory ? 0 : info.storedSize);
            } catch (error) {
              if (error instanceof FsSafeError && error.code === "not-found") {
                return 0;
              }
              throw error;
            }
          };
          const pathSize = async (name: string) => {
            const parts = name.split("/");
            let total = 0;
            for (let index = 1; index <= parts.length; index++) {
              total += await size(parts.slice(0, index).join("/"), index < parts.length);
            }
            return total;
          };
          const withCharge = async (name: string, bytes: number, write: () => Promise<void>) => {
            charge(bytes);
            pendingWrites++;
            pendingFileWrites++;
            const refund = (amount: number) => {
              account.globalBytes -= amount;
              account.users.set(profileId, (account.users.get(profileId) ?? 0) - amount);
              remaining += amount;
            };
            try {
              await withFileLock(async () => {
                await scanInProgress;
                let before: number;
                try {
                  before = await pathSize(name);
                } catch (error) {
                  refund(bytes);
                  throw error;
                }
                const settle = async () => {
                  const after = await pathSize(name);
                  refund(bytes - Math.min(bytes, Math.max(0, after - before)));
                };
                try {
                  await write();
                } catch (error) {
                  try {
                    await settle();
                  } catch (settlementError) {
                    throw new AggregateError(
                      [error, settlementError],
                      "File write and quota settlement both failed.",
                      { cause: settlementError },
                    );
                  }
                  throw error;
                }
                await settle();
              });
            } finally {
              pendingWrites--;
              pendingFileWrites--;
              finishReservation();
            }
          };
          const withMutation = async (write: () => Promise<void>) => {
            pendingWrites++;
            pendingFileWrites++;
            try {
              await withFileLock(async () => {
                await scanInProgress;
                await write();
              });
            } finally {
              pendingWrites--;
              pendingFileWrites--;
              finishReservation();
            }
          };
          return {
            ...files,
            create(name, data) {
              return withCharge(name, checked(name, data), () => files.create(name, data));
            },
            write(name, data) {
              return withCharge(name, checked(name, data), () => files.write(name, data));
            },
            mkdir(name) {
              return withCharge(name, name.split("/").length * 4096, () => files.mkdir(name));
            },
            move(from, to) {
              return withMutation(() => files.move(from, to));
            },
            remove(name) {
              return withMutation(() => files.remove(name));
            },
          };
        },
      };
    } catch (error) {
      release();
      throw error;
    } finally {
      unlock();
    }
  };
  return Object.assign(admit, {
    deletedChat(profileId: string, id: string) {
      deletedDuringScan?.add(chatKey(profileId, id));
      if (ledger) {
        forgetChat(ledger, profileId, id);
      }
    },
  });
}
