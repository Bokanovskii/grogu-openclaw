import {
  readProtectedAutomationLifecycle,
  readProtectedAutomationLifecycleStorageUsage,
  readProtectedAutomationOwnerInbox,
  readProtectedAutomationLastScheduledAttempt,
  readProtectedAutomationRunChat,
  readProtectedAutomationInterruptedRun,
} from "./protected-automation-lifecycle-read.js";
import {
  commitProtectedAutomationLifecycle,
  prepareProtectedAutomationLifecycle,
} from "./protected-automation-lifecycle.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

export const protectedAutomationLifecycleOperations = {
  "protectedAutomationLifecycle.prepare": (
    input: Parameters<typeof prepareProtectedAutomationLifecycle>[1],
    { open },
  ) => prepareProtectedAutomationLifecycle(open(), input),
  "protectedAutomationLifecycle.commit": (
    input: Parameters<typeof commitProtectedAutomationLifecycle>[1],
    { open },
  ) => commitProtectedAutomationLifecycle(open(), input),
  "protectedAutomationLifecycle.runs": (
    input: Parameters<typeof readProtectedAutomationLifecycle>[1],
    { open },
  ) => readProtectedAutomationLifecycle(open(), input),
  "protectedAutomationLifecycle.inbox": (
    input: Parameters<typeof readProtectedAutomationOwnerInbox>[1],
    { open },
  ) => readProtectedAutomationOwnerInbox(open(), input),
  "protectedAutomationLifecycle.lastScheduledAttempt": (
    input: Parameters<typeof readProtectedAutomationLastScheduledAttempt>[1],
    { open },
  ) => readProtectedAutomationLastScheduledAttempt(open(), input),
  "protectedAutomationLifecycle.runChat": (
    input: Parameters<typeof readProtectedAutomationRunChat>[1],
    { open },
  ) => readProtectedAutomationRunChat(open(), input),
  "protectedAutomationLifecycle.storageUsage": (_input: undefined, { open }) =>
    readProtectedAutomationLifecycleStorageUsage(open()),
  "protectedAutomationLifecycle.interruptedRun": (
    input: Parameters<typeof readProtectedAutomationInterruptedRun>[1],
    { open },
  ) => readProtectedAutomationInterruptedRun(open(), input),
} satisfies WorkerOperationHandlers;

export type ProtectedAutomationLifecycleWorkerOperations = WorkerOperations<
  typeof protectedAutomationLifecycleOperations
>;
