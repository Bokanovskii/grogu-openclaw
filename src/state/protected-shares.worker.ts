import { listProtectedShares, readProtectedShare } from "./protected-shares-queries.js";
import { readProtectedSharesStorageUsage } from "./protected-shares-storage.js";
import {
  createProtectedShareGrants,
  prepareProtectedShare,
  revokeProtectedShareGrant,
} from "./protected-shares.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

export const protectedShareOperations = {
  "protectedShares.prepare": (input: Parameters<typeof prepareProtectedShare>[1], { open }) =>
    prepareProtectedShare(open(), input),
  "protectedShares.create": (input: Parameters<typeof createProtectedShareGrants>[1], { open }) =>
    createProtectedShareGrants(open(), input),
  "protectedShares.read": (input: Parameters<typeof readProtectedShare>[1], { open }) =>
    readProtectedShare(open(), input),
  "protectedShares.list": (input: Parameters<typeof listProtectedShares>[1], { open }) =>
    listProtectedShares(open(), input),
  "protectedShares.revoke": (input: Parameters<typeof revokeProtectedShareGrant>[1], { open }) =>
    revokeProtectedShareGrant(open(), input),
  "protectedShares.storageUsage": (
    input: { profileId: string; entryOverheadBytes: number },
    { open },
  ) => readProtectedSharesStorageUsage(open(), input.profileId, input.entryOverheadBytes),
} satisfies WorkerOperationHandlers;

export type ProtectedShareWorkerOperations = WorkerOperations<typeof protectedShareOperations>;
