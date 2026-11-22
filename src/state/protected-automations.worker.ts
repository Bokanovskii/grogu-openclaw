import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import {
  bindProtectedAutomationJob,
  createProtectedAutomation,
  listProtectedAutomations,
  patchProtectedAutomation,
  readProtectedAutomation,
  readProtectedAutomationJobBinding,
} from "./protected-automations.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

export const protectedAutomationOperations = {
  "protectedAutomations.create": (
    input: { profileId: string; definition: ProtectedAutomationDraft; now: number },
    { open },
  ) => createProtectedAutomation(open(), input),
  "protectedAutomations.list": (input: { profileId: string }, { open }) =>
    listProtectedAutomations(open(), input.profileId),
  "protectedAutomations.read": (input: { profileId: string; automationId: string }, { open }) =>
    readProtectedAutomation(open(), input),
  "protectedAutomations.patch": (input: Parameters<typeof patchProtectedAutomation>[1], { open }) =>
    patchProtectedAutomation(open(), input),
  "protectedAutomations.bindJob": (
    input: Parameters<typeof bindProtectedAutomationJob>[1],
    { open },
  ) => bindProtectedAutomationJob(open(), input),
  "protectedAutomations.readJobBinding": (input: { jobId: string }, { open }) =>
    readProtectedAutomationJobBinding(open(), input.jobId),
} satisfies WorkerOperationHandlers;

export type ProtectedAutomationWorkerOperations = WorkerOperations<
  typeof protectedAutomationOperations
>;
