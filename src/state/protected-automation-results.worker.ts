import {
  listProtectedAutomationRuns,
  readProtectedAutomationResultStorageUsage,
} from "./protected-automation-results-read.js";
import {
  commitProtectedAutomationResult,
  prepareProtectedAutomationResult,
} from "./protected-automation-results.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

export const protectedAutomationResultOperations = {
  "protectedAutomationResults.prepare": (
    input: Parameters<typeof prepareProtectedAutomationResult>[1],
    { open },
  ) => prepareProtectedAutomationResult(open(), input),
  "protectedAutomationResults.commit": (
    input: Parameters<typeof commitProtectedAutomationResult>[1],
    { open },
  ) => commitProtectedAutomationResult(open(), input),
  "protectedAutomationResults.runs": (
    input: Parameters<typeof listProtectedAutomationRuns>[1],
    { open },
  ) => listProtectedAutomationRuns(open(), input),
  "protectedAutomationResults.storageUsage": (_input: undefined, { open }) =>
    readProtectedAutomationResultStorageUsage(open()),
} satisfies WorkerOperationHandlers;

export type ProtectedAutomationResultWorkerOperations = WorkerOperations<
  typeof protectedAutomationResultOperations
>;
