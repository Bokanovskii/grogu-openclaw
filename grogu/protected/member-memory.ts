import { createHash } from "node:crypto";
import type { MemberMemoryBinding } from "../../extensions/memory-core/api.js";
import { resolveMemorySearchIndexConfig } from "../../src/agents/memory-search.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceDelegation,
  mintMemberMemoryAudience,
} from "../../src/plugins/memory-audience.js";
import type { MemoryAudience } from "../../src/plugins/memory-provider-types.js";
import {
  onUserProfilesChanged,
  readUserProfileAliasRevision,
} from "../../src/state/user-profile-events.js";
import type { StorageFiles } from "./capacity.js";
import { createMemberMemoryFiles } from "./memory-files.js";

const log = createSubsystemLogger("protected/member-memory");
const loadMemoryCore = () => import("../../extensions/memory-core/api.js");
const workspaceGeneration = (profileId: string, revision: number) =>
  createHash("sha256").update(profileId).update("\0").update(String(revision)).digest("hex");

/** Owns member grants and retires derived plaintext when profile authority changes. */
export function createProtectedMemberMemory() {
  const active = new Map<string, number>();
  const retiring = new Set<Promise<void>>();
  let closed = false;
  let aliasRevision = readUserProfileAliasRevision();
  const retire = (profileId: string) => {
    const operation = loadMemoryCore().then((memory) => memory.retireMemberMemory(profileId));
    retiring.add(operation);
    void operation.then(
      () => retiring.delete(operation),
      (error: unknown) => {
        retiring.delete(operation);
        log.error(`Member memory retirement failed: ${String(error)}`);
      },
    );
    return operation;
  };
  const unsubscribe = onUserProfilesChanged(() => {
    const next = readUserProfileAliasRevision();
    if (next !== aliasRevision) {
      aliasRevision = next;
      for (const profileId of active.keys()) {
        void retire(profileId).catch(() => {});
      }
    }
  });
  return {
    async open(params: {
      cfg: OpenClawConfig;
      profileId: string;
      agentId: string;
      sessionKey: string;
      sessionId: string;
      lifecycleRevision?: string;
      storePath: string;
      files: StorageFiles;
      assertCurrent: () => void;
    }) {
      const revision = readUserProfileAliasRevision();
      const assertCurrent = () => {
        params.assertCurrent();
        if (closed || readUserProfileAliasRevision() !== revision) {
          throw new Error("Member memory profile authority is no longer current.");
        }
      };
      assertCurrent();
      const generation = workspaceGeneration(params.profileId, revision);
      const grant = await mintMemberMemoryAudience({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        storePath: params.storePath,
        workspaceKey: generation,
        assertOwnerCurrent: assertCurrent,
      });
      try {
        if (grant.audience.kind !== "member-private") {
          throw new Error("Member memory audience is unavailable.");
        }
        const binding: MemberMemoryBinding = {
          audience: grant.audience,
          memberKey: params.profileId,
          workspaceGeneration: generation,
          files: createMemberMemoryFiles(params.files),
        };
        const settings = resolveMemorySearchIndexConfig(params.cfg, params.agentId, {
          includeDisabled: true,
        });
        if (!settings) {
          throw new Error("Member memory settings are unavailable.");
        }
        const memory = await loadMemoryCore();
        const lease = await memory.openMemberMemory(
          binding,
          grant.audience,
          () => {
            assertCurrent();
            assertMemoryAudienceCurrent(grant.audience);
          },
          settings.chunking,
        );
        active.set(params.profileId, (active.get(params.profileId) ?? 0) + 1);
        let released = false;
        return {
          binding,
          bindDelegated(audience: MemoryAudience): MemberMemoryBinding {
            assertCurrent();
            assertMemoryAudienceDelegation(binding.audience, audience);
            if (audience.kind !== "member-private") {
              throw new Error("Delegated member memory audience is unavailable.");
            }
            return { ...binding, audience };
          },
          async release() {
            if (released) {
              return;
            }
            released = true;
            grant.release();
            try {
              await lease.release();
            } finally {
              const remaining = (active.get(params.profileId) ?? 1) - 1;
              if (remaining === 0) {
                active.delete(params.profileId);
              } else {
                active.set(params.profileId, remaining);
              }
            }
          },
        };
      } catch (error) {
        grant.release();
        throw error;
      }
    },
    async mutate<T>(
      profileId: string,
      assertOwnerCurrent: () => void,
      operation: () => Promise<T>,
    ) {
      const revision = readUserProfileAliasRevision();
      const assertCurrent = () => {
        assertOwnerCurrent();
        if (closed || readUserProfileAliasRevision() !== revision) {
          throw new Error("Member memory profile authority is no longer current.");
        }
      };
      const memory = await loadMemoryCore();
      return await memory.mutateMemberMemory(
        {
          memberKey: profileId,
          workspaceGeneration: workspaceGeneration(profileId, revision),
          assertCurrent,
        },
        operation,
      );
    },
    retire,
    async close() {
      closed = true;
      unsubscribe();
      const memory = await loadMemoryCore();
      await Promise.all([...retiring, memory.closeMemberMemory()]);
    },
  };
}
