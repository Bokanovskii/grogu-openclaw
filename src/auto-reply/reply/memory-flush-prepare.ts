import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import type { MemoryFlushToolRunContext } from "../../agents/agent-tools.memory-flush.types.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  resolveRequestModelCredential,
  type RequestModelCredential,
} from "../../agents/request-model-credential.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  delegateMemoryAudience,
  type MemoryAudienceGrant,
  resolveMemoryAudienceFromEntry,
} from "../../plugins/memory-audience.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import { getMemoryProviderRuntime } from "../../plugins/memory-state.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { resolveModelFallbackOptions } from "./agent-runner-utils.js";
import { isToolsMemoryFlushPlan, resolveMemoryFlushPlanForRun } from "./memory-flush-plan.js";
import {
  deriveMemoryFlushId,
  ensureMemoryFlushTargetFile,
  prepareMemoryFlushSession,
} from "./memory-flush-session.js";
import type { FollowupRun } from "./queue.js";

const log = createSubsystemLogger("auto-reply/memory-flush");

export type MemberMemoryFlushAuthority = {
  audience: Extract<MemoryAudience, { kind: "member-private" }>;
  assertCurrent: () => void;
  requestModelCredential: RequestModelCredential;
  userFileScope: NonNullable<RunEmbeddedAgentParams["userFileScope"]>;
  bindDelegated: (audience: MemoryAudience) => unknown;
};

// A flush-specific model is exact: it never inherits the source fallback chain.
function resolveMemoryFlushModelFallbackOptions(
  run: FollowupRun["run"],
  model: string | undefined,
  config: FollowupRun["run"]["config"],
) {
  const options = resolveModelFallbackOptions(run, config);
  const override = normalizeOptionalString(model);
  if (!override) {
    return options;
  }
  const slashIdx = override.indexOf("/");
  const overrideProvider = override.slice(0, slashIdx).trim();
  const overrideModel = override.slice(slashIdx + 1).trim();
  return {
    ...options,
    ...(slashIdx > 0 && overrideProvider && overrideModel
      ? { provider: overrideProvider, model: overrideModel }
      : { model: override }),
    requestedRouteResolution: "raw" as const,
    fallbacksOverride: [],
  };
}

export async function prepareMemoryFlushAttempt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  preflightAdmission?: UserTurnTranscriptAdmissionReceipt;
  flushRunId: string;
  contextWindowTokens: number;
  memoryFlushWritable: boolean;
  memberMemory?: MemberMemoryFlushAuthority;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  recordPersistenceToolSuccess: () => void;
  recordPersistenceToolFailure?: () => void;
}) {
  params.assertCurrent();
  const resolution = resolveMemoryFlushPlanForRun({
    cfg: params.cfg,
    nowMs: Date.now(),
    contextWindowTokens: params.contextWindowTokens,
    memoryAudience: params.memberMemory?.audience,
  });
  if (!resolution) {
    return null;
  }
  const plan = resolution.plan;
  if (!isToolsMemoryFlushPlan(plan) && !params.memoryFlushWritable) {
    return null;
  }
  const { sessionKey, sessionEntry, followupRun } = params;
  if (!sessionKey || !sessionEntry) {
    throw new Error("Memory flush has no current transcript target.");
  }
  const agentId = followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg);
  if (params.memberMemory) {
    params.memberMemory.assertCurrent();
    assertMemoryAudienceCurrent(params.memberMemory.audience);
    assertMemoryAudienceSession(params.memberMemory.audience, sessionKey);
    if (
      params.memberMemory.audience.agentId !== agentId ||
      !isToolsMemoryFlushPlan(plan) ||
      resolution.pluginId !== "memory-core"
    ) {
      throw new Error("Member memory flush requires its selected Memory Core tool owner.");
    }
  }
  const sourceStorePath = resolveSessionStorePathForScope(
    { agentId, sessionKey, storePath: params.storePath },
    params.cfg,
  );
  // Only a native provider consumes audiences; other tool-plan owners resolve none.
  const sourceAudience = params.memberMemory
    ? { status: "granted" as const, audience: params.memberMemory.audience, release: () => {} }
    : isToolsMemoryFlushPlan(plan) && getMemoryProviderRuntime()
      ? await resolveMemoryAudienceFromEntry(
          {
            agentId,
            sessionKey,
            sessionId: sessionEntry.sessionId,
            // Maintenance copies carry the source turn's owner status apart from their own grant.
            senderIsOwner: followupRun.memoryAudienceSenderIsOwner ?? followupRun.run.senderIsOwner,
            storePath: sourceStorePath,
            assertCallerCurrent: params.assertCurrent,
          },
          sessionEntry,
        )
      : undefined;
  // The source turn's own attempt resolves the same lineage and owns the operator warning.
  if (sourceAudience?.status === "denied") {
    log.debug("memory flush skipped: source turn has no memory audience", {
      event: "memory_flush_no_audience",
      sourceSessionKey: sessionKey,
      sourceSessionId: sessionEntry.sessionId,
      pluginId: resolution.pluginId,
      kind: sourceAudience.kind,
      reason: sourceAudience.reason,
    });
    return null;
  }
  // The caller releases both grants once the flush run settles; a preparation
  // failure before that hand-off releases them here.
  let delegated: MemoryAudienceGrant | undefined;
  const release = () => {
    delegated?.release();
    sourceAudience?.release();
  };
  try {
    // The detached transcript keeps maintenance messages out of the source session.
    params.assertCurrent();
    const memorySession = await prepareMemoryFlushSession({
      admission: params.preflightAdmission,
      source: {
        agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath: sourceStorePath,
      },
      runId: params.flushRunId,
      workspaceDir: followupRun.run.workspaceDir,
      signal: params.abortSignal,
    });
    if (!isToolsMemoryFlushPlan(plan)) {
      await ensureMemoryFlushTargetFile({
        workspaceDir: followupRun.run.workspaceDir,
        relativePath: plan.relativePath,
        assertCurrent: params.assertCurrent,
      });
    }
    const systemPrompt = [followupRun.run.extraSystemPrompt, plan.systemPrompt]
      .filter(Boolean)
      .join("\n\n");
    const selection = resolveMemoryFlushModelFallbackOptions(
      followupRun.run,
      plan.model,
      params.cfg,
    );
    if (params.memberMemory) {
      resolveRequestModelCredential(
        params.memberMemory.requestModelCredential,
        selection.provider,
        selection.model,
      );
      selection.fallbacksOverride = [];
    }
    // Delegation shares source revocation while binding tool use to the detached session.
    params.assertCurrent();
    delegated = sourceAudience
      ? await delegateMemoryAudience(sourceAudience.audience, {
          sessionKey: memorySession.sessionKey,
          storePath: memorySession.sessionTarget.storePath,
          detached: true,
          assertCallerCurrent: params.assertCurrent,
        })
      : undefined;
    const memoryFlushTools: MemoryFlushToolRunContext | undefined = isToolsMemoryFlushPlan(plan)
      ? {
          flushId: deriveMemoryFlushId({
            sourceSessionId: sessionEntry.sessionId,
            sourceLifecycleRevision: sessionEntry.lifecycleRevision,
            compactionCount: sessionEntry.compactionCount ?? 0,
          }),
          ownerPluginId: resolution.pluginId,
          persistenceToolNames: plan.persistenceToolNames,
          lookupToolNames: plan.lookupToolNames,
          recordPersistenceToolSuccess: params.recordPersistenceToolSuccess,
          recordPersistenceToolFailure: params.recordPersistenceToolFailure,
        }
      : undefined;
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      params.cfg,
      params.flushRunId,
      followupRun.run.agentId,
      "auto-reply.memory-flush",
      undefined,
      followupRun.operatorAuthority,
    );
    return {
      plan,
      writePath: isToolsMemoryFlushPlan(plan) ? undefined : plan.relativePath,
      systemPrompt,
      selection,
      preparedRunAdmission,
      memorySession,
      memoryAudience: delegated?.audience,
      memberMemoryBinding:
        params.memberMemory && delegated
          ? params.memberMemory.bindDelegated(delegated.audience)
          : undefined,
      memoryFlushTools,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
