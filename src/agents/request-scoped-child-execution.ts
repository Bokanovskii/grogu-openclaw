import { AsyncLocalStorage } from "node:async_hooks";
import { readSessionTransientLifetime } from "../config/sessions/session-transient-lifetime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import { readRequestOwnedSubagentExecution } from "./subagents/registry/subagent-registry-transient-content.js";
import type { NormalizedUsage } from "./usage.js";

type ChildSessionIdentity = {
  runId: string;
  sessionKey?: string;
  sessionId: string;
  lifecycleRevision: string;
};

type ChildConstraints = Pick<
  RunEmbeddedAgentInternalParams,
  | "requestModelCredential"
  | "thinkLevel"
  | "memoryAudience"
  | "contextIsolation"
  | "toolRuntimeBindings"
  | "assertInvocationCurrent"
  | "userFileScope"
  | "toolsAllow"
  | "toolExecutionAllow"
  | "extraSystemPrompt"
  | "clientCaps"
  | "skillsSnapshot"
> & {
  onResultUsage?: (usage: NormalizedUsage | undefined) => void;
};

export type RequestScopedChildExecution = {
  provider: string;
  model: string;
  contextIsolation?: "isolated";
  signal: AbortSignal;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  resolveChild: (identity: ChildSessionIdentity) => ChildConstraints | undefined;
};

const requestScope = new AsyncLocalStorage<RequestScopedChildExecution>();

export function withRequestScopedChildExecution<T>(
  scope: RequestScopedChildExecution,
  run: () => T,
): T {
  scope.assertCurrent();
  return requestScope.run(scope, run);
}

export function getRequestScopedChildExecution(runId?: string) {
  const scope = requestScope.getStore();
  if (scope) {
    scope.assertCurrent();
    return scope;
  }
  return runId ? readRequestOwnedSubagentExecution(runId) : undefined;
}

export async function resolveRequestScopedChild(
  scope: RequestScopedChildExecution,
  identity: ChildSessionIdentity,
) {
  await scope.revalidate();
  scope.assertCurrent();
  const constraints = scope.resolveChild(identity);
  if (!constraints?.requestModelCredential || !constraints.userFileScope) {
    throw new Error("Request-scoped child execution is no longer authorized.");
  }
  return constraints;
}

export async function prepareRequestScopedChildExecution(
  identity: Omit<ChildSessionIdentity, "lifecycleRevision">,
  entry: SessionEntry | undefined,
) {
  const scope = getRequestScopedChildExecution(identity.runId);
  if (readSessionTransientLifetime(entry) && !scope) {
    throw new Error("Request-scoped child execution is no longer authorized.");
  }
  if (!scope) {
    return undefined;
  }
  if (!entry?.lifecycleRevision) {
    throw new Error("Request-scoped child session generation is unavailable.");
  }
  await resolveRequestScopedChild(scope, {
    ...identity,
    lifecycleRevision: entry.lifecycleRevision,
  });
  return scope;
}

export async function runRequestScopedChild(
  identity: ChildSessionIdentity,
  params: RunEmbeddedAgentInternalParams,
  run: (params: RunEmbeddedAgentInternalParams) => Promise<EmbeddedAgentRunResult>,
) {
  const scope = getRequestScopedChildExecution(identity.runId);
  if (!scope) {
    throw new Error("Request-scoped child execution is no longer authorized.");
  }
  const { onResultUsage, ...constraints } = await resolveRequestScopedChild(scope, identity);
  const result = await run({
    ...params,
    ...constraints,
    extraSystemPrompt: [params.extraSystemPrompt, constraints.extraSystemPrompt]
      .filter(Boolean)
      .join("\n\n"),
    provider: scope.provider,
    model: scope.model,
    abortSignal: AbortSignal.any(
      [params.abortSignal, scope.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    ),
    agentHarnessRuntimeOverride: "openclaw",
    modelSelectionLocked: true,
    modelFallbacksOverride: [],
    disableMessageTool: true,
    disableToolSearch: true,
    disableTrajectory: true,
    codeModeOverride: false,
    forceMessageTool: false,
    allowGatewaySubagentBinding: false,
  });
  // Account for completed provider work even when the request was cancelled.
  onResultUsage?.(result.meta.agentMeta?.usage);
  return result;
}
