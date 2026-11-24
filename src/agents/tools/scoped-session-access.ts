import { AsyncLocalStorage } from "node:async_hooks";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { resolveSessionAgentIds } from "../agent-scope.js";

type HostSessionAccessAction = "list" | "history" | "send" | "status" | "search";

export type HostSessionAccess = {
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  signal?: AbortSignal;
  creatorProfileId: string;
  /** Set only when the resolver enforces same-owner isolated-run visibility. */
  readonly isolatedAutomationRunReads?: true;
  resolve: (request: {
    action: HostSessionAccessAction;
    requesterSessionKey: string;
    reference: string;
  }) => Promise<{ sessionKey: string; sessionId: string; agentId: string } | undefined>;
};

const hostSessionAccess = new AsyncLocalStorage<HostSessionAccess>();

/** Installs a host-owned ceiling for one admitted invocation and its child work. */
export function withHostSessionAccess<T>(scope: HostSessionAccess, run: () => T): T {
  scope.assertCurrent();
  return hostSessionAccess.run(scope, run);
}

export function getHostSessionAccess(): HostSessionAccess | undefined {
  const scope = hostSessionAccess.getStore();
  scope?.assertCurrent();
  return scope;
}

export async function resolveHostSessionAccess(
  scope: HostSessionAccess,
  request: Parameters<HostSessionAccess["resolve"]>[0],
) {
  scope.assertCurrent();
  const result = await scope.resolve(request);
  scope.assertCurrent();
  return result;
}

/** Resolves a target key without letting requester scope override a durable fixed-store owner. */
export function resolveSessionToolTargetAgentId(params: {
  cfg: OpenClawConfig;
  targetSessionKey: string;
  resolvedAgentId?: string;
  requesterAgentId?: string;
}): string {
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(
    params.cfg,
    params.targetSessionKey,
  );
  const canUseRequesterScope =
    !params.resolvedAgentId &&
    !parseAgentSessionKey(params.targetSessionKey)?.agentId &&
    persistedOwner.kind === "none" &&
    isPerAgentSessionStoreConfig(params.cfg.session?.store);
  return resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.targetSessionKey,
    agentId: params.resolvedAgentId ?? (canUseRequesterScope ? params.requesterAgentId : undefined),
  }).sessionAgentId;
}

/** Linearizes a host-scoped grant against reset/delete of its expected incarnation. */
export async function runWithScopedSessionAccess<T>(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath?: string;
  expectedSessionId?: string;
  signal?: AbortSignal;
  targetSessionKey: string;
  run: () => Promise<T>;
}): Promise<T> {
  const hostScope = getHostSessionAccess();
  await hostScope?.revalidate();
  const signal =
    hostScope?.signal && params.signal
      ? AbortSignal.any([hostScope.signal, params.signal])
      : (hostScope?.signal ?? params.signal);
  const expectedSessionId = params.expectedSessionId?.trim();
  if (!expectedSessionId) {
    const result = await params.run();
    await hostScope?.revalidate();
    return result;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.targetSessionKey,
    agentId: params.agentId,
  });
  const storePath =
    params.storePath ?? resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const assertExpectedIncarnation = () =>
    withSessionEntryReadOnlyInWorker(
      { agentId, storePath, sessionKey: params.targetSessionKey },
      () => signal?.throwIfAborted(),
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        if (read.value?.sessionId !== expectedSessionId || read.value.archivedAt !== undefined) {
          throw new Error(`Session "${params.targetSessionKey}" changed after access was granted.`);
        }
        await hostScope?.revalidate();
      },
    );
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [params.targetSessionKey, expectedSessionId],
    assertAllowed: assertExpectedIncarnation,
    revalidateAllowed: assertExpectedIncarnation,
    ...(signal ? { signal } : {}),
  });
  try {
    const result = await admission.run(params.run);
    await hostScope?.revalidate();
    return result;
  } finally {
    admission.release();
  }
}
