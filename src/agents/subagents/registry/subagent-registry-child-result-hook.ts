import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

export type SubagentChildCleanupIdentity = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  outcome: SubagentRunRecord["execution"]["outcome"];
  resultText: string | null | undefined;
};

export type SubagentBeforeDeleteCleanupHook = (
  child: SubagentChildCleanupIdentity,
) => void | Promise<void>;

export type SubagentDeleteCleanupSettledHook = (
  outcome: "deleted" | "changed" | "failed",
  error?: unknown,
) => void;

// Process memory only, owned by the admitting request's registration: it is never
// persisted, so a restarted registry has no hook and the row's owner must recover it.
const hooks = new WeakMap<
  object,
  {
    beforeDelete?: SubagentBeforeDeleteCleanupHook;
    settled?: SubagentDeleteCleanupSettledHook;
    outcome?: "deleted" | "changed" | "failed";
    error?: unknown;
  }
>();

export function bindSubagentBeforeDeleteCleanupHook(
  entry: SubagentRunRecord,
  hook: SubagentBeforeDeleteCleanupHook | undefined,
  settled?: SubagentDeleteCleanupSettledHook,
): void {
  if (hook || settled) {
    hooks.set(getSubagentRunRuntimeKey(entry), { beforeDelete: hook, settled });
  }
}

/** Rejects, so cleanup deletes nothing, unless the bound hook accepts the exact child generation. */
export async function runSubagentBeforeDeleteCleanupHook(
  entry: SubagentRunRecord,
  cleanupIdentity?: { sessionId: string; lifecycleRevision: string },
): Promise<void> {
  const hook = hooks.get(getSubagentRunRuntimeKey(entry))?.beforeDelete;
  if (!hook) {
    return;
  }
  const identity = entry.childSessionIdentity;
  if (!identity?.sessionId || !identity.lifecycleRevision) {
    throw new Error("Child session identity is unavailable before cleanup");
  }
  if (
    !cleanupIdentity ||
    identity.sessionId !== cleanupIdentity.sessionId ||
    identity.lifecycleRevision !== cleanupIdentity.lifecycleRevision
  ) {
    throw new Error("Child session generation changed before cleanup");
  }
  await hook({
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    sessionId: identity.sessionId,
    lifecycleRevision: identity.lifecycleRevision,
    outcome: entry.execution.outcome,
    resultText: entry.completion?.resultText,
  });
}

export function settleSubagentDeleteCleanup(
  entry: SubagentRunRecord,
  outcome: "deleted" | "changed" | "failed",
  error?: unknown,
): void {
  const hook = hooks.get(getSubagentRunRuntimeKey(entry));
  if (hook) {
    hook.outcome = outcome;
    hook.error = error;
  }
}

export function publishSubagentDeleteCleanupSettlement(
  entry: SubagentRunRecord,
  failure?: unknown,
): void {
  const hook = hooks.get(getSubagentRunRuntimeKey(entry));
  if (!hook?.settled || (!hook.outcome && failure === undefined)) {
    return;
  }
  const outcome = failure === undefined ? hook.outcome : "failed";
  if (outcome) {
    const settled = hook.settled;
    const error = failure ?? hook.error;
    if (outcome !== "failed") {
      hook.settled = undefined;
    } else if (hook.outcome === "failed") {
      hook.outcome = undefined;
      hook.error = undefined;
    }
    settled(outcome, error);
  }
}
