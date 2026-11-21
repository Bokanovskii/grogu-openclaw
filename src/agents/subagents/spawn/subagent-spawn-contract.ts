import type { SessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import type { SpawnedToolContext } from "../../spawned-context.js";
import type {
  SubagentBeforeDeleteCleanupHook,
  SubagentDeleteCleanupSettledHook,
} from "../registry/subagent-registry-child-result-hook.js";
import type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  taskName?: string;
  thinking?: string;
  fastMode?: FastMode;
  collect?: boolean;
  outputSchema?: Record<string, unknown>;
  groupId?: string;
  /** Host bridge identity used to recover a replay-safe collector launch. */
  swarmLaunchReplayKey?: string;
  /** Canonical request hash checked before reusing a host-reserved collector. */
  swarmLaunchRequestFingerprint?: string;
  cwd?: string;
  projectId?: string;
  worktree?: boolean;
  worktreeName?: string;
  worktreeBaseRef?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  context?: SpawnSubagentContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSubagentContext = SpawnedToolContext & {
  onSpawnEffectsStart?: () => void;
  agentSessionKey?: string;
  /** Trusted parent tool construction facts; never read from model arguments. */
  senderIsOwner?: boolean;
  expectedParentSessionId?: string;
  /** Trusted host-owned config for this spawn; never a model-facing parameter. */
  config?: OpenClawConfig;
  /** Explicit request owner for in-process dispatch, when a host establishes one. */
  gatewayContextResolver?: GatewayContextResolver;
  /**
   * Trusted request-scoped opt-in; never read from model arguments. The child commits with a
   * cleanup-only transient classification bound to this parent generation and profile.
   */
  transientLifetime?: { parentSessionKey: string; parentSessionId: string; profileId: string };
  /** Trusted host hook: persist the child result before delete cleanup removes the transcript. */
  beforeChildDeleteCleanup?: SubagentBeforeDeleteCleanupHook;
  childDeleteCleanupSettled?: SubagentDeleteCleanupSettledHook;
  /**
   * Trusted host fence run after child creation and immediately before each native launch dispatch.
   * Throwing prevents dispatch; the spawn pipeline then cleans up the provisional child.
   */
  beforeChildDispatch?: (child: {
    sessionKey: string;
    sessionId: string;
    lifecycleRevision: string;
    runId: string;
  }) => void | Promise<void>;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
  /** Active requester sandbox classification, preserved separately from the durable lineage key.
   * Hidden native spawn derives sandbox admission from this when set, mirroring visible/ACP paths. */
  sandboxed?: boolean;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  requesterAgentIdOverride?: string;
  requesterRunId?: string;
  /** Private invocation fence, consumed only before registration transfers ownership. */
  assertActive?: SessionSourceAssertion;
};

export type SpawnSubagentResult = {
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  taskName?: string;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  note?: string;
  /** Fully resolved model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
} & (
  | { status: "accepted"; context: SpawnSubagentContextMode }
  | { status: "forbidden" | "error"; context?: never }
);

export function rejectSubagentSpawnRequest(status: "error" | "forbidden", error: string) {
  return { ok: false as const, result: { status, error } satisfies SpawnSubagentResult };
}
