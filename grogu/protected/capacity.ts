import { statfsSync } from "node:fs";
import type { ProtectedChatStorage } from "@openclaw/gateway-protocol/protected";
import {
  authorizedUserFilesDirectory,
  createAuthorizedUserFiles,
  measureAuthorizedUserFileTree,
  measureAuthorizedUserFileTrees,
  type AuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import type { ProtectedAutomationStorageUsage } from "../../src/state/protected-automations.js";
import { chatFilesDirectory } from "./chat-files.js";
import type { ProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import {
  createStoredDataReplacementReservation,
  createStoredDataReservation,
  retireStoredData,
  storedDataTransferKey,
  transferStoredData,
  storedDataEntryKey,
  storedDataRetirementKey,
  type StoredDataEntry,
  type StoredDataLedger,
  type StoredDataReplacement,
  type StoredDataReplacementReservation,
  type StoredDataReservation,
  type StoredDataRetirement,
  type StoredDataTransfer,
} from "./storage-entry-quota.js";

const MiB = 1024 * 1024;
const chatBytes = 32 * 1024;
export const storageEntryOverheadBytes = 4096;
const memberMemoryDirectory = "member-memory";
export type StorageLimits = { globalBytes: number; userBytes: number; freeFloorBytes: number };
export const defaultUserLimitBytes = 512 * MiB;
export const minimumUserLimitBytes = 16 * MiB;

export type StorageFiles = AuthorizedUserFiles & {
  updateText(name: string, update: (current: string | undefined) => string): Promise<void>;
};

export type StorageAdmission = {
  release(): void;
  charge(bytes: number): void;
  chargeChatCreation(): void;
  recordCreatedChat(id: string, sessionKey: string): void;
  chargeAutomationCreate(storedBytes: number): void;
  settleAutomationCreate(storedBytes: number, created: boolean, automationId?: string): void;
  chargeAutomationPatch(currentStoredBytes: number, nextStoredBytes: number): void;
  settleAutomationPatch(
    currentStoredBytes: number,
    nextStoredBytes: number,
    updated: boolean,
  ): void;
  assertResult(): void;
  reserveStoredData(bytes: number): StoredDataReservation;
  // Await admission before the native transaction. Reserve synchronously against its
  // measured ledger; retain the receipt through commit/rollback, including unknown outcomes.
  reserveStoredDataReplacement(change: StoredDataReplacement): StoredDataReplacementReservation;
  files(files: AuthorizedUserFiles): StorageFiles;
};

function freeBytes(directory: string) {
  const { bavail, bsize } = statfsSync(directory, { bigint: true });
  return bavail * bsize;
}

export function measureStorageLimits(stateDir: string): StorageLimits {
  const available = freeBytes(stateDir);
  const freeFloorBytes = 512 * MiB;
  const globalBytes = Math.floor(Number(available - BigInt(freeFloorBytes)) / 16);
  if (globalBytes < minimumUserLimitBytes) {
    throw new Error("Insufficient free space for Alcove.");
  }
  return {
    globalBytes,
    userBytes: Math.min(defaultUserLimitBytes, globalBytes),
    freeFloorBytes,
  };
}

type StorageMeasurementOptions = {
  usersRoot: Parameters<typeof measureAuthorizedUserFileTrees>[0]["usersRoot"];
  encryption?: Parameters<typeof createAuthorizedUserFiles>[0]["encryption"];
  chats: Pick<ProtectedChats, "capacityEntries" | "transcriptBytes">;
  maxFileBytes: number;
  automationUsage?: (
    profileId: string,
    assertCurrent: () => void,
  ) => Promise<ProtectedAutomationStorageUsage>;
  storedDataUsage?: (
    profileId: string,
    assertCurrent: () => void,
  ) => Promise<readonly StoredDataEntry[]>;
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
  onAutomationUsage?: (profileId: string, bytes: number) => void,
  onAutomationEntry?: (entry: ProtectedAutomationStorageUsage["entries"][number]) => void,
  onStoredDataEntry?: (entry: StoredDataEntry) => void,
  onMemoryUsage?: (userDirectory: string, bytes: number) => void,
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
        (await measureAuthorizedUserFileTree(
          files,
          chatFilesDirectory(entry.id),
          storageEntryOverheadBytes,
        ));
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
  const memberMemory = await measureAuthorizedUserFileTrees({
    usersRoot: options.usersRoot,
    assertCurrent,
    maxBytes: options.maxFileBytes,
    encryption: options.encryption,
    directory: memberMemoryDirectory,
    entryOverhead: storageEntryOverheadBytes,
    ...(includeOtherProfiles ? {} : { profileId }),
  });
  const ownDirectory = authorizedUserFilesDirectory(profileId);
  for (const [directory, bytes] of memberMemory) {
    if (includeOtherProfiles || directory === ownDirectory) {
      globalBytes += bytes;
      onMemoryUsage?.(directory, bytes);
    }
    if (directory === ownDirectory) {
      personalBytes += bytes;
    }
  }
  assertCurrent();
  const automationUsage = await options.automationUsage?.(profileId, assertCurrent);
  if (automationUsage) {
    const totalAutomationBytes =
      automationUsage.totalDefinitionBytes +
      automationUsage.totalRecords * storageEntryOverheadBytes;
    const profileAutomationBytes =
      automationUsage.profileDefinitionBytes +
      automationUsage.profileRecords * storageEntryOverheadBytes;
    globalBytes += includeOtherProfiles ? totalAutomationBytes : profileAutomationBytes;
    personalBytes += profileAutomationBytes;
    for (const profile of automationUsage.profiles) {
      onAutomationUsage?.(
        profile.profileId,
        profile.definitionBytes + profile.records * storageEntryOverheadBytes,
      );
    }
    for (const entry of automationUsage.entries) {
      onAutomationEntry?.(entry);
    }
  }
  const storedEntries = await options.storedDataUsage?.(profileId, assertCurrent);
  const storedKeys = new Set<string>();
  for (const entry of storedEntries ?? []) {
    assertCurrent();
    const key = storedDataEntryKey(entry);
    if (storedKeys.has(key)) {
      throw new Error("Stored data measurement contains a duplicate entry.");
    }
    storedKeys.add(key);
    if (includeOtherProfiles || entry.profileId === profileId) {
      globalBytes += entry.bytes;
      onStoredDataEntry?.(entry);
    }
    if (entry.profileId === profileId) {
      personalBytes += entry.bytes;
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
  type Ledger = StoredDataLedger & {
    active: Set<Reservation>;
    baseline: Map<string, { profileId: string; id: string; bytes: number }>;
    baselineAutomations: Set<string>;
    postMeasurementAutomations: Set<string>;
    retiredAutomations: Set<string>;
    memoryBytes: Map<string, number>;
    memoryAccounted: Set<string>;
  };
  const entryKey = (entry: { profileId: string; id: string; sessionKey: string }) =>
    JSON.stringify([entry.profileId, entry.id, entry.sessionKey]);
  const accountMemory = (account: Ledger, profileId: string) => {
    if (account.memoryAccounted.has(profileId)) {
      return;
    }
    account.memoryAccounted.add(profileId);
    const bytes = account.memoryBytes.get(authorizedUserFilesDirectory(profileId)) ?? 0;
    account.users.set(profileId, (account.users.get(profileId) ?? 0) + bytes);
  };
  const chatKey = (profileId: string, id: string) => JSON.stringify([profileId, id]);
  const automationKey = (profileId: string, id: string) => JSON.stringify([profileId, id]);
  let ledger: Ledger | undefined;
  let scanInProgress: Promise<void> | undefined;
  let deletedDuringScan: Set<string> | undefined;
  let deletedAutomationsDuringScan:
    | Map<string, ProtectedAutomationStorageUsage["entries"][number]>
    | undefined;
  let pendingFileWrites = 0;
  type StoredDataScanChange =
    | { kind: "retire"; change: StoredDataRetirement }
    | { kind: "transfer"; change: StoredDataTransfer };
  let storedDataChangesDuringScan: StoredDataScanChange[] | undefined;
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
  const forgetAutomation = (
    account: Ledger,
    entry: ProtectedAutomationStorageUsage["entries"][number],
  ) => {
    const key = automationKey(entry.profileId, entry.id);
    if (account.retiredAutomations.has(key)) {
      return;
    }
    const wasMeasured = account.baselineAutomations.delete(key);
    const wasCharged = account.postMeasurementAutomations.delete(key);
    account.retiredAutomations.add(key);
    if (!wasMeasured && !wasCharged) {
      return;
    }
    const bytes = entry.definitionBytes + storageEntryOverheadBytes;
    account.globalBytes -= bytes;
    account.users.set(entry.profileId, (account.users.get(entry.profileId) ?? 0) - bytes);
  };
  const admit = async (
    profileId: string,
    assertCurrent: () => void,
    operation: "create" | "turn" | "automation" | "stored-data",
    // null exempts the caller (the owner) from member and shared budgets, not the disk floor.
    userLimitBytes: number | null = options.limits.userBytes,
  ): Promise<StorageAdmission> => {
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
        const deletedAutomations = new Map<
          string,
          ProtectedAutomationStorageUsage["entries"][number]
        >();
        deletedDuringScan = deleted;
        deletedAutomationsDuringScan = deletedAutomations;
        const storedDataChanges: StoredDataScanChange[] = [];
        storedDataChangesDuringScan = storedDataChanges;
        let finishScan!: () => void;
        scanInProgress = new Promise<void>((resolve) => {
          finishScan = resolve;
        });
        try {
          const users = new Map<string, number>();
          const baseline = new Map<string, { profileId: string; id: string; bytes: number }>();
          const baselineAutomations = new Set<string>();
          const storedEntries = new Map<string, StoredDataEntry>();
          const memoryBytes = new Map<string, number>();
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
            (automationProfileId, bytes) => {
              users.set(automationProfileId, (users.get(automationProfileId) ?? 0) + bytes);
            },
            (entry) => {
              baselineAutomations.add(automationKey(entry.profileId, entry.id));
            },
            (entry) => {
              users.set(entry.profileId, (users.get(entry.profileId) ?? 0) + entry.bytes);
              storedEntries.set(storedDataEntryKey(entry), entry);
            },
            (directory, bytes) => memoryBytes.set(directory, bytes),
          );
          const account: Ledger = {
            globalBytes,
            users,
            active: new Set<Reservation>(),
            baseline,
            baselineAutomations,
            postMeasurementAutomations: new Set<string>(),
            retiredAutomations: new Set<string>(),
            memoryBytes,
            memoryAccounted: new Set<string>(),
            storedEntries,
            retiredStoredEntries: new Map<string, StoredDataEntry | null>(),
          };
          for (const entry of baseline.values()) {
            if (deleted.has(chatKey(entry.profileId, entry.id))) {
              forgetChat(account, entry.profileId, entry.id);
            }
          }
          for (const entry of deletedAutomations.values()) {
            forgetAutomation(account, entry);
          }
          // Preserve receipt order so late retirement cannot erase a transferred identity.
          for (const event of storedDataChanges) {
            if (event.kind === "retire") {
              retireStoredData(account, event.change);
            } else {
              transferStoredData(account, event.change);
            }
          }
          ledger = account;
        } finally {
          deletedDuringScan = undefined;
          deletedAutomationsDuringScan = undefined;
          storedDataChangesDuringScan = undefined;
          scanInProgress = undefined;
          finishScan();
        }
      };
      if (!ledger) {
        await measure();
      } else {
        accountMemory(ledger, profileId);
        const initial = operation === "create" ? chatBytes : operation === "turn" ? 16 * 1024 : 0;
        if (
          pendingFileWrites === 0 &&
          (ledger.globalBytes + initial > options.limits.globalBytes ||
            (userLimitBytes !== null &&
              (ledger.users.get(profileId) ?? 0) + initial > userLimitBytes))
        ) {
          const existing = ledger;
          const entries = await options.chats.capacityEntries();
          assertCurrent();
          if (ledger !== existing) {
            await measure();
          } else {
            const present = new Set(entries.map(entryKey));
            // Reclaim only original measured chat bytes. New charges stay reserved.
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
      accountMemory(account, profileId);
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
            (userLimitBytes !== null && userLimitBytes - userBytes < bytes)
          ) {
            throw new ProtectedError(
              413,
              "quota_exceeded",
              "Storage limit reached. Delete stored data to free space, or contact the server operator.",
            );
          }
          if (userLimitBytes !== null && options.limits.globalBytes - account.globalBytes < bytes) {
            throw new ProtectedError(
              413,
              "quota_exceeded",
              "The server's shared storage for members is full. Contact the server operator.",
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
      if (operation === "create") {
        charge(chatBytes);
      } else if (operation === "turn") {
        charge(16 * 1024);
      }
      const refund = (bytes: number) => {
        account.globalBytes -= bytes;
        account.users.set(profileId, (account.users.get(profileId) ?? 0) - bytes);
        remaining = Math.min(8 * MiB, remaining + bytes);
      };
      const storedDataOptions = {
        account,
        profileId,
        charge,
        refund,
        begin() {
          pendingWrites++;
        },
        finish() {
          pendingWrites--;
          finishReservation();
        },
      };
      return {
        release,
        charge,
        reserveStoredData(bytes) {
          return createStoredDataReservation({
            ...storedDataOptions,
            bytes,
          });
        },
        reserveStoredDataReplacement(change) {
          assertDisk();
          return createStoredDataReplacementReservation({ ...storedDataOptions, change });
        },
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
        chargeAutomationCreate(storedBytes) {
          if (operation !== "automation") {
            throw new Error("Only automation admission can charge an automation create.");
          }
          charge(storedBytes + storageEntryOverheadBytes);
        },
        settleAutomationCreate(storedBytes, created, automationId) {
          if (operation !== "automation") {
            throw new Error("Only automation admission can settle an automation create.");
          }
          if (created) {
            if (!automationId) {
              throw new Error("A created automation must have an identifier.");
            }
            const key = automationKey(profileId, automationId);
            if (account.retiredAutomations.has(key)) {
              const bytes = storedBytes + storageEntryOverheadBytes;
              account.globalBytes -= bytes;
              account.users.set(profileId, (account.users.get(profileId) ?? 0) - bytes);
              remaining = Math.min(8 * MiB, remaining + bytes);
              return;
            }
            account.postMeasurementAutomations.add(key);
            return;
          }
          const bytes = storedBytes + storageEntryOverheadBytes;
          account.globalBytes -= bytes;
          account.users.set(profileId, (account.users.get(profileId) ?? 0) - bytes);
          remaining = Math.min(8 * MiB, remaining + bytes);
        },
        chargeAutomationPatch(currentStoredBytes, nextStoredBytes) {
          if (operation !== "automation") {
            throw new Error("Only automation admission can charge an automation edit.");
          }
          const growth = nextStoredBytes - currentStoredBytes;
          if (growth > 0) {
            charge(growth);
          }
        },
        settleAutomationPatch(currentStoredBytes, nextStoredBytes, updated) {
          if (operation !== "automation") {
            throw new Error("Only automation admission can settle an automation edit.");
          }
          const delta = nextStoredBytes - currentStoredBytes;
          const freed = updated ? -delta : delta;
          if (freed > 0) {
            account.globalBytes -= freed;
            account.users.set(profileId, (account.users.get(profileId) ?? 0) - freed);
            remaining = Math.min(8 * MiB, remaining + freed);
          }
        },
        assertResult() {
          if (failure) {
            throw failure;
          }
        },
        files(files: AuthorizedUserFiles): StorageFiles {
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
          const chargedWrite = async (name: string, bytes: number, write: () => Promise<void>) => {
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
          const withCharge = async (name: string, bytes: number, write: () => Promise<void>) => {
            charge(bytes);
            await withMutation(() => chargedWrite(name, bytes, write));
          };
          return {
            ...files,
            assertCurrent() {
              if (!active) {
                throw new Error("Storage admission is closed.");
              }
              files.assertCurrent();
            },
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
            removeEmptyDirectory(name) {
              return withMutation(() => files.removeEmptyDirectory(name));
            },
            async updateText(name, update) {
              if (!active) {
                throw new Error("Storage admission is closed.");
              }
              await withMutation(async () => {
                if (!active) {
                  throw new Error("Storage admission is closed.");
                }
                files.assertCurrent();
                let current: string | undefined;
                try {
                  current = await files.readText(name);
                } catch (error) {
                  if (!(error instanceof FsSafeError && error.code === "not-found")) {
                    throw error;
                  }
                }
                const next = update(current);
                const bytes = checked(name, next);
                charge(bytes);
                await chargedWrite(name, bytes, () => {
                  if (!active) {
                    throw new Error("Storage admission is closed.");
                  }
                  files.assertCurrent();
                  return files.write(name, next);
                });
              });
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
    async reserveStoredData(
      profileId: string,
      assertCurrent: () => void,
      bytes: number,
      userLimitBytes: number | null = options.limits.userBytes,
    ) {
      const admission = await admit(profileId, assertCurrent, "stored-data", userLimitBytes);
      try {
        const reservation = admission.reserveStoredData(bytes);
        return {
          settle(result: Parameters<StoredDataReservation["settle"]>[0]) {
            reservation.settle(result);
            admission.release();
          },
          release() {
            reservation.release();
            admission.release();
          },
        };
      } catch (error) {
        admission.release();
        throw error;
      }
    },
    retiredStoredData(changes: readonly StoredDataRetirement[]) {
      for (const change of changes) {
        storedDataRetirementKey(change);
        storedDataChangesDuringScan?.push({ kind: "retire", change: structuredClone(change) });
        if (ledger) {
          retireStoredData(ledger, change);
        }
      }
    },
    transferredStoredData(changes: readonly StoredDataTransfer[]) {
      for (const change of changes) {
        storedDataTransferKey(change);
        if (ledger) {
          transferStoredData(ledger, change);
        }
        storedDataChangesDuringScan?.push({ kind: "transfer", change: structuredClone(change) });
      }
    },
    deletedChat(profileId: string, id: string) {
      deletedDuringScan?.add(chatKey(profileId, id));
      if (ledger) {
        forgetChat(ledger, profileId, id);
      }
    },
    deletedAutomations(records: readonly ProtectedAutomationStorageUsage["entries"][number][]) {
      for (const entry of records) {
        const key = automationKey(entry.profileId, entry.id);
        deletedAutomationsDuringScan?.set(key, entry);
        if (ledger) {
          forgetAutomation(ledger, entry);
        }
      }
    },
  });
}
