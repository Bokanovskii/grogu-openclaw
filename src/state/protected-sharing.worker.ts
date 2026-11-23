import {
  followProtectedAutomation,
  listProtectedAutomationPublications,
  listProtectedAutomationRecipients,
  publishProtectedAutomation,
  readProtectedAutomationAccess,
  readProtectedAutomationRunAccess,
  readProtectedAutomationSharingStorageUsage,
  setProtectedAutomationSubscription,
  unfollowProtectedAutomation,
  unpublishProtectedAutomation,
} from "./protected-automation-sharing.js";
import { listProtectedPublicAutomations } from "./protected-public-automations.js";
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
  "protectedSharing.publishAutomation": (
    input: Parameters<typeof publishProtectedAutomation>[1],
    { open },
  ) => publishProtectedAutomation(open(), input),
  "protectedSharing.unpublishAutomation": (
    input: Parameters<typeof unpublishProtectedAutomation>[1],
    { open },
  ) => unpublishProtectedAutomation(open(), input),
  "protectedSharing.followAutomation": (
    input: Parameters<typeof followProtectedAutomation>[1],
    { open },
  ) => followProtectedAutomation(open(), input),
  "protectedSharing.unfollowAutomation": (
    input: Parameters<typeof unfollowProtectedAutomation>[1],
    { open },
  ) => unfollowProtectedAutomation(open(), input),
  "protectedSharing.automationSubscription": (
    input: Parameters<typeof setProtectedAutomationSubscription>[1],
    { open },
  ) => setProtectedAutomationSubscription(open(), input),
  "protectedSharing.publicAutomations": (
    input: Parameters<typeof listProtectedPublicAutomations>[1],
    { open },
  ) => listProtectedPublicAutomations(open(), input),
  "protectedSharing.automationPublications": (
    input: Parameters<typeof listProtectedAutomationPublications>[1],
    { open },
  ) => listProtectedAutomationPublications(open(), input),
  "protectedSharing.automationAccess": (
    input: Parameters<typeof readProtectedAutomationAccess>[1],
    { open },
  ) => readProtectedAutomationAccess(open(), input),
  "protectedSharing.automationRunAccess": (
    input: Parameters<typeof readProtectedAutomationRunAccess>[1],
    { open },
  ) => readProtectedAutomationRunAccess(open(), input),
  "protectedSharing.automationRecipients": (
    input: Parameters<typeof listProtectedAutomationRecipients>[1],
    { open },
  ) => listProtectedAutomationRecipients(open(), input),
  // One ledger view for every sharing entry, so HTTP write recovery finds chat and automation ids.
  "protectedSharing.storageUsage": (overheadBytes: number, { open }) => {
    const database = open();
    return [
      ...readProtectedSharingStorageUsage(database, overheadBytes),
      ...readProtectedAutomationSharingStorageUsage(database, overheadBytes),
    ];
  },
} satisfies WorkerOperationHandlers;

export type ProtectedSharingWorkerOperations = WorkerOperations<typeof protectedSharingOperations>;
