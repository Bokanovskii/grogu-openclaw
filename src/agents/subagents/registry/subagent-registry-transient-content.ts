import type { RequestScopedChildExecution } from "../../request-scoped-child-execution.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  copySubagentRunRuntimeOwner,
  getSubagentRunRuntimeKey,
  isSameSubagentRun,
} from "./subagent-run-generation.js";

const requestOwnedRuns = new WeakSet<object>();
const requestOwnedExecutions = new Map<string, RequestScopedChildExecution>();

export function bindRequestOwnedSubagentExecution(params: {
  runId: string;
  scope: RequestScopedChildExecution;
}): () => void {
  if (requestOwnedExecutions.has(params.runId)) {
    throw new Error("Request-owned child execution identity is already bound.");
  }
  requestOwnedExecutions.set(params.runId, params.scope);
  return () => {
    if (requestOwnedExecutions.get(params.runId) === params.scope) {
      requestOwnedExecutions.delete(params.runId);
    }
  };
}

export function readRequestOwnedSubagentExecution(
  runId: string,
): RequestScopedChildExecution | undefined {
  const scope = requestOwnedExecutions.get(runId);
  scope?.assertCurrent();
  return scope;
}

export function bindRequestOwnedSubagentRun(entry: SubagentRunRecord): void {
  requestOwnedRuns.add(getSubagentRunRuntimeKey(entry));
}

export function isRequestOwnedSubagentRun(entry: SubagentRunRecord): boolean {
  return requestOwnedRuns.has(getSubagentRunRuntimeKey(entry));
}

export function projectRequestOwnedSubagentRun(entry: SubagentRunRecord): SubagentRunRecord {
  if (!isRequestOwnedSubagentRun(entry)) {
    return entry;
  }
  if (entry.killIntent && entry.killIntent.reason !== "killed") {
    throw new Error("Request-owned child has an unsupported cancellation claim");
  }
  const outcome = entry.execution.outcome;
  return {
    runId: entry.runId,
    taskRunId: entry.taskRunId,
    requesterTurnRunId: entry.requesterTurnRunId,
    childSessionKey: entry.childSessionKey,
    childSessionIdentity: entry.childSessionIdentity,
    childAgentId: entry.childAgentId,
    controllerSessionKey: entry.controllerSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    requesterAgentId: entry.requesterAgentId,
    requesterStorePath: entry.requesterStorePath,
    controllerStorePath: entry.controllerStorePath,
    requesterDisplayKey: entry.requesterSessionKey,
    task: "",
    cleanup: "delete",
    expectsCompletionMessage: false,
    spawnMode: "run",
    generation: entry.generation,
    createdAt: entry.createdAt,
    sessionStartedAt: entry.sessionStartedAt,
    accumulatedRuntimeMs: entry.accumulatedRuntimeMs,
    runTimeoutSeconds: entry.runTimeoutSeconds,
    endedReason: entry.endedReason,
    killIntent: entry.killIntent
      ? {
          requestedAt: entry.killIntent.requestedAt,
          reason: "killed",
          lifecycleGeneration: entry.killIntent.lifecycleGeneration,
          sessionId: entry.killIntent.sessionId,
          sessionLifecycleRevision: entry.killIntent.sessionLifecycleRevision,
          suppressTaskDelivery: entry.killIntent.suppressTaskDelivery,
        }
      : undefined,
    killReconciliation: entry.killReconciliation
      ? {
          killedAt: entry.killReconciliation.killedAt,
          taskCancellationAccepted: entry.killReconciliation.taskCancellationAccepted,
          suppressTaskDelivery: entry.killReconciliation.suppressTaskDelivery,
          supersededAt: entry.killReconciliation.supersededAt,
        }
      : undefined,
    execution: {
      status: entry.execution.status,
      startedAt: entry.execution.startedAt,
      endedAt: entry.execution.endedAt,
      lifecycleGeneration: entry.execution.lifecycleGeneration,
      suppressSessionEffects: true,
      outcome: outcome
        ? {
            status: outcome.status,
            startedAt: outcome.startedAt,
            endedAt: outcome.endedAt,
            elapsedMs: outcome.elapsedMs,
          }
        : undefined,
    },
    completion: { required: false, capturedAt: entry.completion?.capturedAt },
    delivery: { status: "not_required" },
    cleanupHandled: true,
    cleanupCompletedAt: entry.cleanupCompletedAt,
    deleteCleanupDispatchedAt: entry.deleteCleanupDispatchedAt,
  };
}

export function retainRequestOwnedSubagentContent(
  current: SubagentRunRecord | undefined,
  restored: SubagentRunRecord,
): SubagentRunRecord {
  if (!current || !isSameSubagentRun(current, restored) || !isRequestOwnedSubagentRun(current)) {
    return restored;
  }
  const result = copySubagentRunRuntimeOwner(restored, structuredClone(restored));
  result.task = current.task;
  result.taskName = current.taskName;
  result.label = current.label;
  result.cleanupHandled = current.cleanupHandled;
  result.execution.suppressSessionEffects = current.execution.suppressSessionEffects;
  if (
    result.execution.outcome?.status === current.execution.outcome?.status &&
    result.execution.outcome?.endedAt === current.execution.outcome?.endedAt &&
    result.execution.outcome
  ) {
    result.execution.outcome.error = current.execution.outcome?.error;
  }
  if (
    result.completion &&
    current.completion &&
    result.completion.capturedAt === current.completion.capturedAt
  ) {
    result.completion.resultText = current.completion.resultText;
    result.completion.fallbackResultText = current.completion.fallbackResultText;
    result.completion.fallbackCapturedAt = current.completion.fallbackCapturedAt;
    result.completion.terminalReply = current.completion.terminalReply;
  }
  return result;
}
