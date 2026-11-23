import {
  claimProtectedChatShare,
  createProtectedChatShare,
  deleteProtectedChatShare,
  listProtectedSharedChats,
  readProtectedChatAccess,
  readProtectedChatShare,
  readProtectedSharingStorageUsage,
  removeProtectedChatShareRecipient,
  resolveProtectedChatShare,
} from "./protected-sharing.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

export const protectedSharingOperations = {
  "protectedSharing.read": (input: Parameters<typeof readProtectedChatShare>[1], { open }) =>
    readProtectedChatShare(open(), input),
  "protectedSharing.create": (input: Parameters<typeof createProtectedChatShare>[1], { open }) =>
    createProtectedChatShare(open(), input),
  "protectedSharing.delete": (input: Parameters<typeof deleteProtectedChatShare>[1], { open }) =>
    deleteProtectedChatShare(open(), input),
  "protectedSharing.removeRecipient": (
    input: Parameters<typeof removeProtectedChatShareRecipient>[1],
    { open },
  ) => removeProtectedChatShareRecipient(open(), input),
  "protectedSharing.resolve": (input: Parameters<typeof resolveProtectedChatShare>[1], { open }) =>
    resolveProtectedChatShare(open(), input),
  "protectedSharing.claim": (input: Parameters<typeof claimProtectedChatShare>[1], { open }) =>
    claimProtectedChatShare(open(), input),
  "protectedSharing.sharedChats": (
    input: Parameters<typeof listProtectedSharedChats>[1],
    { open },
  ) => listProtectedSharedChats(open(), input),
  "protectedSharing.chatAccess": (input: Parameters<typeof readProtectedChatAccess>[1], { open }) =>
    readProtectedChatAccess(open(), input),
  "protectedSharing.storageUsage": (overheadBytes: number, { open }) =>
    readProtectedSharingStorageUsage(open(), overheadBytes),
} satisfies WorkerOperationHandlers;

export type ProtectedSharingWorkerOperations = WorkerOperations<typeof protectedSharingOperations>;
