import { assertExclusiveServiceStateOwner } from "../../infra/gateway-state-owner.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.js";
import {
  readSessionEntriesFromStoreInWorker,
  readSessionEntryReadOnlyInWorker,
  readSessionEntrySummariesInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionTransientLifetime } from "./session-transient-lifetime.js";
import type { SessionEntry, TransientSessionLifetime } from "./types.js";

export type TransientSessionRecoveryScope = {
  agentId: string;
  env: NodeJS.ProcessEnv;
  storePath: string;
};

export type TransientSessionRecoveryResult = { deleted: number; skipped: number };

type RecoveryChild = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  parentSessionKey: string;
  assertCurrent: () => void;
};

type RecoveryScope = TransientSessionRecoveryScope & {
  /** Verify caller ownership using the fresh entries, including the orphan's own stamp. */
  owns: (child: {
    sessionKey: string;
    entry: SessionEntry;
    lifetime: TransientSessionLifetime;
    parent: SessionEntry | undefined;
  }) => boolean;
  assertCurrent?: () => void;
};

type RecoveryEffects = {
  retireRegistry: (child: RecoveryChild) => Promise<boolean>;
  beforeDelete?: (child: {
    sessionKey: string;
    sessionId: string;
    lifetime: TransientSessionLifetime;
    assertCurrent: () => void;
  }) => Promise<void>;
};

/** Classify stopped-service children without retiring runs, files, or sessions. */
export async function inspectTransientSessionEntries(
  scope: RecoveryScope & { inspectRegistry: (child: RecoveryChild) => Promise<boolean> },
): Promise<{ recoverable: number; skipped: number }> {
  const { inspectRegistry, ...store } = scope;
  const result = await visitTransientSessionEntries(store, { inspectRegistry });
  return { recoverable: result.processed, skipped: result.skipped };
}

/**
 * Deletes request-scoped children left by a stopped process, without archiving.
 * The parent lifecycle fence encloses the authoritative parent and child rereads;
 * the child's exact generation is then enforced at its deletion commit. Only
 * the caller can recognize its orphan when the same-store parent is absent.
 */
export async function recoverTransientSessionEntries(
  scope: RecoveryScope & RecoveryEffects,
): Promise<TransientSessionRecoveryResult> {
  const { retireRegistry, beforeDelete, ...store } = scope;
  const result = await visitTransientSessionEntries(store, { retireRegistry, beforeDelete });
  return { deleted: result.processed, skipped: result.skipped };
}

async function visitTransientSessionEntries(
  scope: RecoveryScope,
  effects: RecoveryEffects | { inspectRegistry: (child: RecoveryChild) => Promise<boolean> },
): Promise<{ processed: number; skipped: number }> {
  const { owns, assertCurrent: assertCallerCurrent, ...store } = scope;
  const assertCurrent = () => {
    assertExclusiveServiceStateOwner(resolveOpenClawStateSqlitePath(store.env));
    assertCallerCurrent?.();
  };
  assertCurrent();
  let skipped = 0;
  const candidates = (await readSessionEntrySummariesInWorker(store)).flatMap(
    ({ sessionKey, entry }) => {
      const lifetime = readSessionTransientLifetime(entry);
      if (!lifetime || !entry.lifecycleRevision) {
        if (entry.transientLifetime !== undefined) {
          skipped += 1;
        }
        return [];
      }
      return [
        {
          sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          lifetime,
        },
      ];
    },
  );
  let processed = 0;
  for (const { sessionKey, sessionId, lifecycleRevision, lifetime } of candidates) {
    assertCurrent();
    const sameStoreParent =
      parseAgentSessionKey(lifetime.parentSessionKey)?.agentId === store.agentId;
    if (!sameStoreParent || sessionKey === lifetime.parentSessionKey) {
      skipped += 1;
      continue;
    }
    const accepted = await runExclusiveSessionLifecycleMutation("recover", {
      scope: store.storePath,
      identities: [lifetime.parentSessionKey, lifetime.parentSessionId],
      run: async () => {
        assertCurrent();
        // An entry-only deletion can leave an occupied key with no readable parent.
        const parentRead = await readSessionEntriesFromStoreInWorker({
          ...store,
          sessionKeys: [lifetime.parentSessionKey],
          projection: "sharing",
        });
        assertCurrent();
        if (!parentRead.sharing || parentRead.sharing.placeholders.length) {
          return false;
        }
        const parent = parentRead.entries[0]?.entry;
        const entry = await readSessionEntryReadOnlyInWorker(
          { ...store, sessionKey, projection: "full" },
          assertCurrent,
        );
        const current = readSessionTransientLifetime(entry);
        const hasParentReceipt =
          entry?.spawnedBySessionId !== undefined ||
          entry?.parentSessionLifecycleRevision !== undefined;
        if (
          (parent !== undefined && parent.sessionId !== lifetime.parentSessionId) ||
          !entry ||
          !current ||
          entry.sessionId !== sessionId ||
          entry.lifecycleRevision !== lifecycleRevision ||
          current.parentSessionKey !== lifetime.parentSessionKey ||
          current.parentSessionId !== lifetime.parentSessionId ||
          current.profileId !== lifetime.profileId ||
          entry.createdVia !== "spawn" ||
          entry.parentSessionKey !== lifetime.parentSessionKey ||
          entry.spawnedBy !== lifetime.parentSessionKey ||
          ((!parent || hasParentReceipt) &&
            entry.spawnedBySessionId !== lifetime.parentSessionId) ||
          (parent &&
            hasParentReceipt &&
            entry.parentSessionLifecycleRevision !== parent.lifecycleRevision) ||
          !entry.lifecycleRevision ||
          !owns({ sessionKey, entry, lifetime: current, parent })
        ) {
          return false;
        }
        assertCurrent();
        const registryChild = {
          sessionKey,
          sessionId,
          lifecycleRevision,
          parentSessionKey: lifetime.parentSessionKey,
          assertCurrent,
        };
        if ("inspectRegistry" in effects) {
          const safe = await effects.inspectRegistry(registryChild);
          assertCurrent();
          return safe;
        }
        if (!(await effects.retireRegistry(registryChild))) {
          return false;
        }
        assertCurrent();
        await effects.beforeDelete?.({ sessionKey, sessionId, lifetime: current, assertCurrent });
        assertCurrent();
        const result = await deleteSessionEntryLifecycle({
          ...store,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          deleteDeliveryArtifacts: true,
          expectedEntry: entry,
          expectedSessionId: entry.sessionId,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedUpdatedAt: entry.updatedAt,
          commitGuard: assertCurrent,
          requireWriteSuccess: true,
        });
        return Boolean(result.deletedEntry);
      },
    });
    if (accepted) {
      processed += 1;
    } else {
      skipped += 1;
    }
  }
  return { processed, skipped };
}
