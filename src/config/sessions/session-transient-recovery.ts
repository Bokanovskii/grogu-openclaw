import { assertExclusiveServiceStateOwner } from "../../infra/gateway-state-owner.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.js";
import {
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

/**
 * Deletes request-scoped children left by a stopped process, without archiving.
 * The parent lifecycle fence encloses the authoritative parent and child rereads;
 * the child's exact generation is then enforced at its deletion commit. A missing,
 * reset, different-profile, or caller-rejected parent leaves the child intact.
 */
export async function recoverTransientSessionEntries(
  scope: TransientSessionRecoveryScope & {
    /** Extra caller ownership check against the freshly read parent entry. */
    owns: (child: {
      sessionKey: string;
      sessionId: string;
      lifetime: TransientSessionLifetime;
      parent: SessionEntry;
    }) => boolean;
    retireRegistry: (child: {
      sessionKey: string;
      sessionId: string;
      lifecycleRevision: string;
      parentSessionKey: string;
      assertCurrent: () => void;
    }) => Promise<boolean>;
    beforeDelete?: (child: {
      sessionKey: string;
      sessionId: string;
      lifetime: TransientSessionLifetime;
      assertCurrent: () => void;
    }) => Promise<void>;
    assertCurrent?: () => void;
  },
): Promise<TransientSessionRecoveryResult> {
  const {
    owns,
    retireRegistry,
    beforeDelete,
    assertCurrent: assertCallerCurrent,
    ...store
  } = scope;
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
  let deleted = 0;
  for (const { sessionKey, sessionId, lifecycleRevision, lifetime } of candidates) {
    assertCurrent();
    const sameStoreParent =
      parseAgentSessionKey(lifetime.parentSessionKey)?.agentId === store.agentId;
    if (!sameStoreParent || sessionKey === lifetime.parentSessionKey) {
      skipped += 1;
      continue;
    }
    const removed = await runExclusiveSessionLifecycleMutation("recover", {
      scope: store.storePath,
      identities: [lifetime.parentSessionKey, lifetime.parentSessionId],
      run: async () => {
        assertCurrent();
        const parent = await readSessionEntryReadOnlyInWorker(
          { ...store, sessionKey: lifetime.parentSessionKey, projection: "full" },
          assertCurrent,
        );
        const entry = await readSessionEntryReadOnlyInWorker(
          { ...store, sessionKey, projection: "full" },
          assertCurrent,
        );
        const current = readSessionTransientLifetime(entry);
        if (
          !parent ||
          parent.sessionId !== lifetime.parentSessionId ||
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
          !entry.lifecycleRevision ||
          !owns({ sessionKey, sessionId, lifetime: current, parent })
        ) {
          return false;
        }
        assertCurrent();
        if (
          !(await retireRegistry({
            sessionKey,
            sessionId,
            lifecycleRevision,
            parentSessionKey: lifetime.parentSessionKey,
            assertCurrent,
          }))
        ) {
          return false;
        }
        assertCurrent();
        await beforeDelete?.({ sessionKey, sessionId, lifetime: current, assertCurrent });
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
    if (removed) {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }
  return { deleted, skipped };
}
