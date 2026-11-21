import { AsyncLocalStorage } from "node:async_hooks";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";

type ChildConstraints = Pick<
  RunEmbeddedAgentInternalParams,
  | "requestModelCredential"
  | "userFileScope"
  | "toolsAllow"
  | "toolExecutionAllow"
  | "extraSystemPrompt"
>;

export type RequestScopedChildExecution = {
  provider: string;
  model: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  resolveChild: (identity: {
    runId: string;
    sessionKey?: string;
    sessionId: string;
    lifecycleRevision: string;
  }) => ChildConstraints | undefined;
};

const requestScope = new AsyncLocalStorage<RequestScopedChildExecution>();

export function withRequestScopedChildExecution<T>(
  scope: RequestScopedChildExecution,
  run: () => T,
): T {
  scope.assertCurrent();
  return requestScope.run(scope, run);
}

export function getRequestScopedChildExecution() {
  const scope = requestScope.getStore();
  scope?.assertCurrent();
  return scope;
}

export async function resolveRequestScopedChild(
  scope: RequestScopedChildExecution,
  identity: {
    runId: string;
    sessionKey?: string;
    sessionId: string;
    lifecycleRevision: string;
  },
) {
  await scope.revalidate();
  scope.assertCurrent();
  const constraints = scope.resolveChild(identity);
  if (!constraints?.requestModelCredential || !constraints.userFileScope) {
    throw new Error("Request-scoped child execution is no longer authorized.");
  }
  return constraints;
}
