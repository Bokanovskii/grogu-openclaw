import { createHash } from "node:crypto";
import type {
  ProtectedAgentMention,
  ProtectedModel,
  ProtectedActivity,
  ProtectedTurnEvent,
  ProtectedTurnRequest,
} from "@openclaw/gateway-protocol/protected";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import type { ClientToolDefinition } from "../../src/agents/command/shared-types.js";
import { runEmbeddedAgent } from "../../src/agents/embedded-agent-runner/run.js";
import { queueGuardedEmbeddedAgentMessageWithOutcomeAsync } from "../../src/agents/embedded-agent-runner/runs.js";
import {
  withoutModelRequestTelemetry,
  type TerminalModelRequestMetadata,
} from "../../src/agents/model-request-telemetry.js";
import { createRequestModelCredential } from "../../src/agents/request-model-credential.js";
import { withRequestScopedChildExecution } from "../../src/agents/request-scoped-child-execution.js";
import { bindRequestOwnedSubagentExecution } from "../../src/agents/subagents/registry/subagent-registry-transient-content.js";
import { spawnSubagentDirect } from "../../src/agents/subagents/spawn/subagent-spawn.js";
import {
  withHostSessionAccess,
  type HostSessionAccess,
} from "../../src/agents/tools/scoped-session-access.js";
import { makeZeroUsageSnapshot, type NormalizedUsage } from "../../src/agents/usage.js";
import { createDefaultDeps } from "../../src/cli/deps.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/legacy-sqlite-marker.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
} from "../../src/config/sessions/transcript.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../../src/gateway/local-request-context.js";
import { captureGatewayOperatorRunAuthority } from "../../src/gateway/operator-run-authority.js";
import { SESSION_WRITE_SCOPE } from "../../src/gateway/operator-scopes.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
} from "../../src/gateway/server-plugin-runtime-client.js";
import { onAgentEventForRun } from "../../src/infra/agent-events.js";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { GatewayScheduler } from "../../src/infra/gateway-scheduler.js";
import { computeUsageTokenTotals } from "../../src/infra/session-cost-usage-pricing.js";
import { LegacyPluginSdkResourceHost } from "../../src/plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../src/plugins/runtime/gateway-request-scope.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../src/shared/transcript-only-openclaw-assistant.js";
import { readWidgetDraftMetadata, WIDGET_DRAFT_MAX_CHARS } from "../../src/shared/widget-draft.js";
import type { ProtectedAgentDefinition } from "./agents.js";
import { chatFilesDirectory } from "./chat-files.js";
import { ProtectedError, providerTimeout } from "./errors.js";
import type { fetchProtectedCopilotModels } from "./models.js";
import { protectedTurnTimeoutMs } from "./settings.js";
import { projectActivity, projectToolResult, type Source, type Widget } from "./tool-events.js";

export type { ProtectedModel };
export type TurnInput = {
  text: string;
  mentions?: ProtectedAgentMention[];
  provider: ProtectedModel["provider"];
  model: string;
  credential?: { accessToken: string; expiresAt?: number };
  thinking?: ProtectedTurnRequest["thinking"];
  copilotModel?: Awaited<ReturnType<typeof fetchProtectedCopilotModels>>[number];
};
export type ProtectedTurn = {
  id: string;
  runId: string;
  profileId: string;
  target: {
    agentId: string;
    sessionKey: string;
    storePath: string;
    nativeSessionId: string;
    lifecycleRevision: string | null;
  };
  input: TurnInput;
  mentionedAgents: readonly Readonly<ProtectedAgentDefinition>[];
  agent: Readonly<ProtectedAgentDefinition>;
  /** The chat agent may hand the request to one other selectable agent. */
  routing: {
    tool: ClientToolDefinition;
    briefMaxChars: number;
    resolve: (agentId: string) => Readonly<ProtectedAgentDefinition> | undefined;
  };
  sessionAccess: HostSessionAccess;
  files: AuthorizedUserFiles;
  signal: AbortSignal;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  markTiming: (phase: "providerRequestStartMs" | "firstProviderOutputMs") => void;
  saveChildResult: (result: {
    runId: string;
    agentId: string;
    text: string;
    timestamp: number;
  }) => Promise<void>;
  cleanupChildFiles: (sessionId: string) => Promise<void>;
  chargeChildCreation: () => void;
  registerChildSession: (sessionKey: string) => () => void;
  childResult: (result: { runId: string; agentId: string; text: string }) => void;
  usage: (tokens: number | null) => void;
  modelRequest: (record: TerminalModelRequestMetadata) => void;
  reasoningLength: (length: number) => void;
  delta: (text: string) => Promise<void>;
  reasoning: (text: string) => Promise<void>;
  activity: (item: ProtectedActivity) => Promise<void>;
  sources: (sources: Source[]) => Promise<void>;
  widget: (widget: Widget) => Promise<void>;
  widgetDraft: (draft: Extract<ProtectedTurnEvent, { type: "widget-draft" }>) => Promise<void>;
};

async function runMentionedAgent(
  config: OpenClawConfig,
  turn: ProtectedTurn,
  agent: Readonly<ProtectedAgentDefinition>,
  credential: ReturnType<typeof createRequestModelCredential>,
  recordUsage: (usage: NormalizedUsage | undefined) => void,
  recordModelRequest: (record: TerminalModelRequestMetadata) => void,
  task = turn.input.text,
) {
  const children = new Map<
    string,
    {
      sessionKey: string;
      sessionId: string;
      lifecycleRevision: string;
      releaseSessionAccess: () => void;
      releaseExecution: () => void;
    }
  >();
  let savedResult = false;
  let usageReported = false;
  let settle!: (outcome: "deleted" | "changed") => void;
  const settled = new Promise<"deleted" | "changed">((resolve) => {
    settle = resolve;
  });
  let spawnedRunId: string | undefined;
  const scope = {
    provider: turn.input.provider,
    model: turn.input.model,
    signal: turn.signal,
    assertCurrent: turn.assertCurrent,
    revalidate: turn.revalidate,
    resolveChild: ({
      runId,
      sessionKey,
      sessionId,
      lifecycleRevision,
    }: {
      runId: string;
      sessionKey?: string;
      sessionId: string;
      lifecycleRevision: string;
    }) => {
      const child = children.get(runId);
      if (
        !child ||
        child.sessionId !== sessionId ||
        child.sessionKey !== sessionKey ||
        child.lifecycleRevision !== lifecycleRevision ||
        turn.signal.aborted
      ) {
        return undefined;
      }
      return {
        onResultUsage: (usage: NormalizedUsage | undefined) => {
          usageReported = true;
          recordUsage(usage);
        },
        requestModelCredential: credential.handle,
        userFileScope: {
          files: turn.files,
          directory: chatFilesDirectory(sessionId),
          cacheKey: createHash("sha256")
            .update(`${turn.profileId}:${sessionId}:${runId}`)
            .digest("hex"),
        },
        toolsAllow: [...agent.tools],
        toolExecutionAllow: agent.tools,
        extraSystemPrompt: agent.systemPrompt,
        skillsSnapshot: agent.skillsSnapshot,
        clientCaps: ["inline-widgets"],
      };
    },
  };
  await withProtectedGatewayAuthority(config, turn, async () => {
    const gatewayContextResolver = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
    if (!gatewayContextResolver) {
      throw new Error("Protected child requires its isolated local Gateway context.");
    }
    turn.chargeChildCreation();
    const result = await withRequestScopedChildExecution(scope, () =>
      spawnSubagentDirect(
        {
          task,
          label: `protected-${agent.id}`,
          agentId: turn.target.agentId,
          mode: "run",
          cleanup: "delete",
          expectsCompletionMessage: false,
          context: "isolated",
          lightContext: true,
          thinking: turn.input.thinking,
        },
        {
          config,
          gatewayContextResolver,
          agentSessionKey: turn.target.sessionKey,
          requesterAgentIdOverride: turn.target.agentId,
          requesterRunId: turn.runId,
          expectedParentSessionId: turn.target.nativeSessionId,
          transientLifetime: {
            parentSessionKey: turn.target.sessionKey,
            parentSessionId: turn.target.nativeSessionId,
            profileId: turn.profileId,
          },
          assertActive: turn.assertCurrent,
          beforeChildDispatch: (child) => {
            turn.assertCurrent();
            if (
              !child.lifecycleRevision ||
              child.sessionKey === turn.target.sessionKey ||
              children.has(child.runId)
            ) {
              throw new Error("Protected child identity is ambiguous.");
            }
            const releaseSessionAccess = turn.registerChildSession(child.sessionKey);
            let releaseExecution: (() => void) | undefined;
            try {
              releaseExecution = bindRequestOwnedSubagentExecution({
                runId: child.runId,
                scope,
              });
            } catch (error) {
              releaseSessionAccess();
              throw error;
            }
            children.set(child.runId, {
              ...child,
              releaseSessionAccess,
              releaseExecution,
            });
            spawnedRunId = child.runId;
          },
          beforeChildDeleteCleanup: async (child) => {
            const owned = children.get(child.runId);
            if (
              !owned ||
              owned.sessionKey !== child.sessionKey ||
              owned.sessionId !== child.sessionId ||
              owned.lifecycleRevision !== child.lifecycleRevision
            ) {
              throw new Error("Protected child generation changed before cleanup.");
            }
            try {
              if (child.outcome?.status === "ok" && child.resultText?.trim()) {
                try {
                  turn.assertCurrent();
                  await turn.saveChildResult({
                    runId: child.runId,
                    agentId: agent.id,
                    text: child.resultText,
                    timestamp: Date.now(),
                  });
                  savedResult = true;
                  turn.childResult({
                    runId: child.runId,
                    agentId: agent.id,
                    text: child.resultText,
                  });
                } catch (error) {
                  try {
                    turn.assertCurrent();
                  } catch {
                    return;
                  }
                  throw error;
                }
              }
            } finally {
              await turn.cleanupChildFiles(child.sessionId);
            }
          },
          childDeleteCleanupSettled: (outcome) => {
            const child = spawnedRunId ? children.get(spawnedRunId) : undefined;
            if (outcome === "failed") {
              return;
            }
            child?.releaseSessionAccess();
            child?.releaseExecution();
            settle(outcome);
          },
          requesterThinkingLevel: turn.input.provider === "sparky" ? "ultra" : undefined,
        },
      ),
    );
    if (result.status !== "accepted" || !result.runId || result.runId !== spawnedRunId) {
      throw new ProtectedError(
        502,
        "agent_failed",
        "The mentioned agent could not complete its work.",
      );
    }
    turn.assertCurrent();
    const outcome = await settled;
    turn.assertCurrent();
    if (outcome !== "deleted" || !savedResult) {
      throw new ProtectedError(
        502,
        "agent_failed",
        "The mentioned agent could not complete its work.",
      );
    }
  }).finally(() => {
    for (const child of children.values()) {
      child.releaseSessionAccess();
      child.releaseExecution();
    }
    if (spawnedRunId && !usageReported) {
      recordUsage(undefined);
    }
  });
}

function readRoute(
  turn: ProtectedTurn,
  calls: readonly { name: string; arguments: string }[] | undefined,
) {
  if (!calls?.length) {
    return undefined;
  }
  const call = calls.length === 1 ? calls[0] : undefined;
  const params =
    call?.name === turn.routing.tool.function.name && safeParseJsonRecord(call.arguments);
  const agent =
    params && typeof params.agentId === "string" ? turn.routing.resolve(params.agentId) : undefined;
  const brief = params && typeof params.brief === "string" ? params.brief.trim() : "";
  if (!agent || agent.id === turn.agent.id || !brief || brief.length > turn.routing.briefMaxChars) {
    throw new ProtectedError(
      502,
      "agent_failed",
      `${turn.agent.name} could not hand this request to another agent.`,
    );
  }
  if (turn.mentionedAgents.some((mentioned) => mentioned.id === agent.id)) {
    return undefined;
  }
  return {
    agent,
    task: `The member asked ${turn.agent.name}:\n${turn.input.text}\n\n${turn.agent.name} handed it to you with this brief:\n${brief}`,
  };
}

async function withProtectedGatewayAuthority<T>(
  config: OpenClawConfig,
  turn: ProtectedTurn,
  run: () => Promise<T>,
): Promise<T> {
  const resources = new LegacyPluginSdkResourceHost();
  const scheduler = new GatewayScheduler();
  resources.bindScheduler(scheduler);
  const closeScheduler = () => scheduler.beginClose();
  turn.signal.addEventListener("abort", closeScheduler, { once: true });
  if (turn.signal.aborted) {
    closeScheduler();
  }
  return await resources
    .run(() =>
      withLocalGatewayRequestScope(
        {
          deps: createDefaultDeps(),
          getRuntimeConfig: () => config,
          requireNewContext: true,
        },
        async () => {
          const scope = getPluginRuntimeGatewayRequestScope();
          const context = scope?.context;
          if (!scope || !context) {
            throw new Error("Protected child requires its local Gateway owner.");
          }
          const client = createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "operator", profileId: turn.profileId },
            scopes: [SESSION_WRITE_SCOPE],
          });
          const captured = await captureGatewayOperatorRunAuthority({
            client,
            context,
            invocationAuthority: {
              assertCurrent: turn.assertCurrent,
              signal: turn.signal,
            },
          });
          if (!captured) {
            throw new Error("Protected profile could not admit a local child run.");
          }
          try {
            const scopedClient = mergePluginRuntimeClientInternal(client, {
              operatorRunAuthority: captured.authority,
            });
            return await withPluginRuntimeGatewayRequestScope(
              { ...scope, client: scopedClient },
              run,
            );
          } finally {
            captured.release();
          }
        },
      ),
    )
    .finally(async () => {
      turn.signal.removeEventListener("abort", closeScheduler);
      const failures: unknown[] = [];
      try {
        await resources.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await scheduler.stop();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Protected Gateway resources could not be closed.");
      }
    });
}

export function createCanonicalProtectedTurns(options: {
  config: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  models: readonly ProtectedModel[];
  resolveSparkyKey: () => Promise<string>;
}) {
  return {
    models: options.models,
    async run(turn: ProtectedTurn) {
      const { provider, model } = turn.input;
      const accessToken =
        provider === "sparky"
          ? await options.resolveSparkyKey()
          : turn.input.credential?.accessToken;
      await turn.revalidate();
      if (!accessToken) {
        throw new ProtectedError(
          401,
          "provider_credential_required",
          "Connect this provider first.",
        );
      }
      const config = turn.input.copilotModel
        ? {
            ...options.config,
            models: {
              ...options.config.models,
              providers: {
                ...options.config.models?.providers,
                "github-copilot": {
                  baseUrl: turn.input.copilotModel.baseUrl,
                  models: [turn.input.copilotModel.definition],
                },
              },
            },
          }
        : options.config;
      const admission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(turn.runId),
        assertSourceCurrent: turn.assertCurrent,
        facts: {
          runId: turn.runId,
          agentId: turn.target.agentId,
          ingress: { kind: "system", boundary: "grogu-protected", state: "present" },
        },
      });
      let updates = Promise.resolve();
      let updateError: unknown;
      let lastReasoning = "";
      const draftBytes = new Map<string, number>();
      const unsubscribe = onAgentEventForRun(turn.runId, ({ stream, data }) => {
        if (stream === "tool" && (data.phase === "start" || data.phase === "result")) {
          const activity = projectActivity(
            data.name,
            data.toolCallId,
            data.phase === "start" ? "running" : data.isError === true ? "failed" : "done",
          );
          if (activity) {
            updates = updates
              .then(() => turn.activity(activity))
              .catch((error: unknown) => {
                updateError ??= error;
              });
          }
        }
        if (
          stream !== "tool" ||
          data.phase !== "input_delta" ||
          data.name !== "show_widget" ||
          typeof data.toolCallId !== "string" ||
          !isRecord(data.widgetDraft)
        ) {
          return;
        }
        const draft = readWidgetDraftMetadata(data.widgetDraft);
        if (!draft) {
          return;
        }
        const { html, offset } = data.widgetDraft;
        const id = data.toolCallId;
        const previous = draftBytes.get(id) ?? 0;
        if (previous > WIDGET_DRAFT_MAX_CHARS || (!draftBytes.has(id) && draftBytes.size >= 32)) {
          return;
        }
        const used = previous + (typeof html === "string" ? Buffer.byteLength(html) : 0);
        draftBytes.set(id, used);
        if (used > WIDGET_DRAFT_MAX_CHARS) {
          draft.unavailable = "limit";
        }
        const chunk =
          !draft.unavailable &&
          typeof html === "string" &&
          typeof offset === "number" &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          offset + html.length <= WIDGET_DRAFT_MAX_CHARS &&
          Buffer.byteLength(html) <= WIDGET_DRAFT_MAX_CHARS
            ? { html, offset }
            : {};
        updates = updates
          .then(() =>
            turn.widgetDraft({
              type: "widget-draft",
              id,
              ...draft,
              ...chunk,
            }),
          )
          .catch((error: unknown) => {
            updateError ??= error;
          });
      });
      const onAgentToolResult = ({
        toolName,
        result: raw,
        isError,
      }: {
        toolName: string;
        result: unknown;
        isError: boolean;
      }) => {
        if (isError || !isRecord(raw)) {
          return;
        }
        const result = projectToolResult(toolName, raw.details);
        if (result.sources.length || result.widgets.length) {
          updates = updates
            .then(async () => {
              if (result.sources.length) {
                await turn.sources(result.sources);
              }
              for (const item of result.widgets) {
                await turn.widget(item);
              }
            })
            .catch((error: unknown) => {
              updateError ??= error;
            });
        }
      };
      let credential: ReturnType<typeof createRequestModelCredential> | undefined;
      let tokenTotal: number | null = 0;
      const recordUsage = (usage: NormalizedUsage | undefined) => {
        const tokens =
          usage &&
          [usage.total, usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
            (value) => value !== undefined,
          )
            ? computeUsageTokenTotals(usage).totalTokens
            : null;
        tokenTotal =
          tokenTotal !== null && tokens !== null && Number.isSafeInteger(tokens) && tokens >= 0
            ? tokenTotal + tokens
            : null;
        if (tokenTotal !== null && (!Number.isSafeInteger(tokenTotal) || tokenTotal < 0)) {
          tokenTotal = null;
        }
        turn.usage(tokenTotal);
      };
      const recordModelRequest = turn.modelRequest;
      try {
        const requestCredential = createRequestModelCredential({
          provider,
          model,
          accessToken,
          expiresAt: turn.input.credential?.expiresAt,
          assertCurrent: turn.assertCurrent,
        });
        credential = requestCredential;
        const result = await withProtectedGatewayAuthority(config, turn, () =>
          withoutModelRequestTelemetry(
            () =>
              withHostSessionAccess(turn.sessionAccess, () =>
                runEmbeddedAgent({
                  ...turn.target,
                  sessionId: turn.id,
                  sessionTarget: { ...turn.target, sessionId: turn.id },
                  sessionFile: formatSqliteSessionFileMarker({
                    ...turn.target,
                    sessionId: turn.id,
                  }),
                  runId: turn.runId,
                  timeoutMs: protectedTurnTimeoutMs,
                  abortSignal: turn.signal,
                  config,
                  workspaceDir: options.workspaceDir,
                  agentDir: options.agentDir,
                  prompt: turn.input.text,
                  transcriptPrompt: turn.input.text,
                  extraSystemPrompt: turn.agent.systemPrompt,
                  skillsSnapshot: turn.agent.skillsSnapshot,
                  trigger: "user",
                  provider,
                  model,
                  thinkLevel: turn.input.thinking,
                  reasoningLevel: "stream",
                  agentHarnessRuntimeOverride: "openclaw",
                  preparedRunAdmission: admission,
                  requestModelCredential: requestCredential.handle,
                  onExecutionPhase: ({ phase }) => {
                    if (phase === "model_call_started") {
                      turn.markTiming("providerRequestStartMs");
                    }
                  },
                  bootstrapContextMode: "lightweight",
                  disableMessageTool: true,
                  disableToolSearch: true,
                  disableTrajectory: true,
                  codeModeOverride: false,
                  toolsAllow: [...turn.agent.tools, turn.routing.tool.function.name],
                  toolExecutionAllow: turn.agent.tools,
                  clientTools: [turn.routing.tool],
                  clientCaps: ["inline-widgets"],
                  userFileScope: {
                    files: turn.files,
                    directory: chatFilesDirectory(turn.id),
                    cacheKey: createHash("sha256")
                      .update(`${turn.profileId}:${turn.id}:${turn.runId}`)
                      .digest("hex"),
                  },
                  onAgentToolResult,
                  onAssistantMessageStart: () => {
                    lastReasoning = "";
                  },
                  onReasoningStream: ({ text }) => {
                    if (!text || text === lastReasoning) {
                      return;
                    }
                    const delta = text.startsWith(lastReasoning)
                      ? text.slice(lastReasoning.length)
                      : text;
                    lastReasoning = text;
                    turn.reasoningLength(delta.length);
                    updates = updates
                      .then(() => turn.reasoning(delta))
                      .catch((error: unknown) => {
                        updateError ??= error;
                      });
                  },
                  onPartialReply: async ({ delta }) => {
                    if (delta) {
                      await turn.delta(delta);
                    }
                  },
                }),
              ),
            () => turn.markTiming("firstProviderOutputMs"),
            turn.modelRequest,
          ),
        );
        recordUsage(result.meta.agentMeta?.usage);
        await updates;
        if (updateError !== undefined) {
          throw updateError instanceof Error
            ? updateError
            : new Error("Could not publish the turn update.", { cause: updateError });
        }
        await turn.revalidate();
        if (result.meta.timeoutPhase !== undefined) {
          throw providerTimeout();
        }
        if (result.payloads?.some((payload) => payload.isError) || result.meta.aborted) {
          throw new ProtectedError(502, "provider_failed", "The model did not complete the reply.");
        }
        if (result.meta.intentionalTerminalCompletion === "tool-batch") {
          // Only the native owner can confirm that a settled tool batch ended the reply.
          const message = {
            role: "assistant",
            content: [],
            api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
            provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
            model: OPENCLAW_DELIVERY_MIRROR_MODEL,
            usage: makeZeroUsageSnapshot(),
            stopReason: "stop",
            timestamp: Date.now(),
            protectedTerminalCompletion: "tool-batch",
          } satisfies SessionTranscriptAssistantMessage & {
            protectedTerminalCompletion: "tool-batch";
          };
          const saved = await appendExactAssistantMessageToSessionTranscript({
            ...turn.target,
            expectedSessionId: turn.target.nativeSessionId,
            expectedLifecycleRevision: turn.target.lifecycleRevision,
            idempotencyKey: `protected-terminal:${turn.runId}`,
            assertCurrent: turn.assertCurrent,
            message,
          });
          turn.assertCurrent();
          if (!saved.ok) {
            throw new ProtectedError(
              500,
              "save_failed",
              "The reply completion could not be saved.",
            );
          }
        }
        const route = readRoute(turn, result.meta.pendingToolCalls);
        if (turn.mentionedAgents.length || route) {
          await withoutModelRequestTelemetry(
            () =>
              withHostSessionAccess(turn.sessionAccess, async () => {
                for (const agent of turn.mentionedAgents) {
                  turn.assertCurrent();
                  await runMentionedAgent(
                    config,
                    turn,
                    agent,
                    requestCredential,
                    recordUsage,
                    recordModelRequest,
                  );
                }
                if (route) {
                  turn.assertCurrent();
                  await runMentionedAgent(
                    config,
                    turn,
                    route.agent,
                    requestCredential,
                    recordUsage,
                    recordModelRequest,
                    route.task,
                  );
                }
              }),
            undefined,
            recordModelRequest,
          );
        }
      } finally {
        try {
          unsubscribe();
          admission.close();
        } finally {
          credential?.close();
        }
      }
    },
    async steer(input: {
      id: string;
      steeringId: string;
      text: string;
      signal: AbortSignal;
      assertCurrent: () => void;
      onSettled: () => void;
      isCurrent: () => boolean;
    }) {
      return queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
        input.id,
        input.text,
        {
          queueIdentity: input.steeringId,
          abortSignal: input.signal,
          assertCurrent: input.assertCurrent,
          allowPendingUserInputAnswer: false,
          onQueueAccepted: () => undefined,
          onQueueSettled: input.onSettled,
        },
        input.isCurrent,
      );
    },
  };
}

export type ProtectedTurns = ReturnType<typeof createCanonicalProtectedTurns>;
