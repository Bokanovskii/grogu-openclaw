import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ProtectedChat,
  ProtectedChatSummary,
  ProtectedActivity,
  ProtectedMessage,
  ProtectedChatResponse,
} from "@openclaw/gateway-protocol/protected";
import {
  isProtectedAuthoringDraft,
  type ProtectedAuthoringDraft,
} from "@openclaw/gateway-protocol/protected-authoring";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyFailoverReason } from "../../src/agents/failover/classify.js";
import { FailoverError } from "../../src/agents/failover/error.js";
import { retireTransientSubagentRun } from "../../src/agents/subagents/registry/subagent-registry-transient-recovery.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/legacy-sqlite-marker.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
} from "../../src/config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "../../src/config/sessions/session-accessor.sqlite-parent-fork.js";
import {
  readSessionEntrySummariesInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../src/config/sessions/session-entry-read-runtime.js";
import { readTranscriptStatsAsync } from "../../src/config/sessions/session-transcript-stats.js";
import { readSessionTransientLifetime } from "../../src/config/sessions/session-transient-lifetime.js";
import { recoverTransientSessionEntries } from "../../src/config/sessions/session-transient-recovery.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
} from "../../src/config/sessions/transcript.js";
import type { InternalSessionEntry, SessionEntry } from "../../src/config/sessions/types.js";
import {
  aggregateSessionTranscriptUsage,
  createSessionTranscriptUsageAccumulator,
} from "../../src/gateway/session-transcript-derived-readers.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import {
  isTranscriptOnlyOpenClawAssistantMessage,
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../src/shared/transcript-only-openclaw-assistant.js";
import { PROTECTED_STORAGE_KEY_FILE_ENV } from "../../src/storage/sqlite-encryption.js";
import { legacyDefaultProtectedAgentId, type ProtectedAgentCatalog } from "./agents.js";
import { AUTOMATIONS_CHAT_PLUGIN_ID } from "./automations-chat/contract.js";
import { removeChatFilesDirectory } from "./chat-files.js";
import { ProtectedError, publicError } from "./errors.js";
import { composeSideReturnText } from "./side-return.js";
import {
  createWidgetChain,
  projectActivity,
  projectToolResult,
  widgetIdPattern,
  type Widget,
} from "./tool-events.js";

export type ProtectedChatAuthority = { profileId: string; assertCurrent: () => void };

function missing(): never {
  throw new ProtectedError(404, "not_found", "Chat not found.");
}

function validId(id: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id);
}

function transcriptText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => isRecord(block) && block.type === "text")
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .join("\n")
      : "";
}

export function readAuthoringDraft(entry: SessionEntry): ProtectedAuthoringDraft | undefined {
  const value = entry.pluginExtensions?.[AUTOMATIONS_CHAT_PLUGIN_ID]?.draft;
  if (value === undefined) {
    return undefined;
  }
  if (!isProtectedAuthoringDraft(value)) {
    throw new ProtectedError(500, "invalid_draft", "The stored automation draft cannot be read.");
  }
  return value;
}

function draftBytes(snapshot: ProtectedAuthoringDraft | undefined) {
  return snapshot ? Buffer.byteLength(JSON.stringify(snapshot)) : 0;
}

function draftExtension(
  extensions: SessionEntry["pluginExtensions"],
  draft?: ProtectedAuthoringDraft,
) {
  const state = { ...extensions?.[AUTOMATIONS_CHAT_PLUGIN_ID] };
  if (draft) {
    state.draft = draft;
  } else {
    delete state.draft;
  }
  return { ...extensions, [AUTOMATIONS_CHAT_PLUGIN_ID]: state };
}

export function draftMismatch() {
  return new ProtectedError(
    412,
    "draft_mismatch",
    "The draft changed. Reopen it before continuing.",
  );
}

function sideOf(entry: SessionEntry) {
  return entry.protectedSideParentId && entry.protectedSideForkedAt
    ? {
        parentId: entry.protectedSideParentId,
        forkedAt: {
          messageId: entry.protectedSideForkedAt.messageId,
          messageCount: entry.protectedSideForkedAt.messageCount,
        },
      }
    : undefined;
}

const sideReturnModel = "protected-side-return";

/** A parent-chat message that a member sent back from one of its side chats. */
function sideReturnOf(message: Record<string, unknown>) {
  const note = message.protectedSideNote;
  return message.role === "assistant" &&
    message.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === sideReturnModel &&
    isRecord(note) &&
    typeof note.chatId === "string" &&
    validId(note.chatId) &&
    typeof note.title === "string"
    ? { chatId: note.chatId, title: note.title }
    : undefined;
}

function summary(entry: SessionEntry): ProtectedChatSummary {
  const side = sideOf(entry);
  return {
    id: entry.sessionId,
    title: entry.displayName ?? "New chat",
    version: String(entry.updatedAt),
    updatedAt: entry.updatedAt,
    selectedAgentId:
      typeof entry.protectedAgentId === "string" &&
      /^[a-z][a-z0-9-]{0,47}$/u.test(entry.protectedAgentId)
        ? entry.protectedAgentId
        : legacyDefaultProtectedAgentId,
    ...(entry.protectedAutomationRunId
      ? { automationRun: { automationId: entry.protectedAutomationRunId } }
      : {}),
    ...(entry.protectedAuthoringKind === "automation"
      ? {
          authoring: {
            kind: "automation" as const,
            ...(entry.protectedAutomationId ? { automationId: entry.protectedAutomationId } : {}),
          },
        }
      : {}),
    ...(side ? { side } : {}),
  };
}

/** Storage remains the canonical session/transcript owner, not a Family chat store. */
export function createProtectedChats(options: {
  stateDir: string;
  maxChatsPerUser: number;
  agentCatalog: ProtectedAgentCatalog;
  usersRoot: Parameters<typeof createAuthorizedUserFiles>[0]["usersRoot"];
  maxFileBytes: number;
}) {
  if (!path.isAbsolute(options.stateDir) || options.maxChatsPerUser < 1) {
    throw new TypeError("Protected chats require an isolated absolute state directory and budget.");
  }
  const agentId = "protected";
  const env = Object.freeze({
    OPENCLAW_STATE_DIR: options.stateDir,
    [PROTECTED_STORAGE_KEY_FILE_ENV]: process.env[PROTECTED_STORAGE_KEY_FILE_ENV],
  });
  const storePath = path.join(
    options.stateDir,
    "agents",
    agentId,
    "agent",
    "openclaw-agent.sqlite",
  );
  const prefix = (profileId: string) => `agent:${agentId}:family:${profileId}:`;
  const scope = (authority: ProtectedChatAuthority, id: string) => ({
    agentId,
    env,
    storePath,
    sessionKey: `${prefix(authority.profileId)}${id}`,
  });
  const removeFiles = async (profileId: string, sessionId: string, assertCurrent: () => void) => {
    const files = await createAuthorizedUserFiles({
      usersRoot: options.usersRoot,
      profileId,
      assertCurrent,
      maxBytes: options.maxFileBytes,
    });
    try {
      assertCurrent();
      await removeChatFilesDirectory(files, sessionId);
      assertCurrent();
    } finally {
      files.dispose();
    }
  };
  const check = (authority: ProtectedChatAuthority, id: string, entry?: SessionEntry) => {
    authority.assertCurrent();
    if (
      !entry ||
      entry.sessionId !== id ||
      entry.createdVia !== "plugin" ||
      entry.createdActor?.type !== "human" ||
      entry.createdActor.source !== "profile" ||
      entry.createdActor.id !== authority.profileId
    ) {
      return missing();
    }
    return entry;
  };
  const readEntry = async (authority: ProtectedChatAuthority, id: string) => {
    authority.assertCurrent();
    if (!validId(id)) {
      return missing();
    }
    return withSessionEntryReadOnlyInWorker(
      scope(authority, id),
      authority.assertCurrent,
      async (result, owner) => {
        if (!result.ok) {
          throw result.error;
        }
        owner.assertCurrent();
        return check(authority, id, result.value);
      },
    );
  };
  const updateMetadata = async (
    authority: ProtectedChatAuthority,
    id: string,
    version: string,
    patch: Partial<
      Pick<
        SessionEntry,
        "displayName" | "protectedAgentId" | "protectedAutomationId" | "pluginExtensions"
      >
    >,
    conflict: ProtectedError,
  ): Promise<ProtectedChatSummary> => {
    const current = await readEntry(authority, id);
    if (String(current.updatedAt) !== version) {
      throw conflict;
    }
    if (current.protectedAuthoringKind && patch.protectedAgentId !== undefined) {
      throw new ProtectedError(409, "authoring_chat", "Authoring chats always use Grogu.");
    }
    if (
      patch.protectedAutomationId !== undefined &&
      (current.protectedAuthoringKind !== "automation" ||
        (current.protectedAutomationId !== undefined &&
          current.protectedAutomationId !== patch.protectedAutomationId))
    ) {
      throw new ProtectedError(
        409,
        "authoring_bound",
        "This chat already belongs to another automation.",
      );
    }
    let committed = false;
    const entry = await applySessionEntryOperation(
      scope(authority, id),
      {
        kind: "fields",
        expected: {
          sessionId: id,
          createdVia: "plugin",
          createdActorProfileId: authority.profileId,
          updatedAt: current.updatedAt,
        },
        patch: { ...patch, updatedAt: Math.max(Date.now(), current.updatedAt + 1) },
      },
      {
        workerGuard: { assertCurrent: authority.assertCurrent },
        requireWriteSuccess: true,
        onCommitted: () => {
          committed = true;
        },
      },
    );
    authority.assertCurrent();
    if (!entry) {
      return missing();
    }
    check(authority, id, entry);
    if (!committed) {
      throw conflict;
    }
    return summary(entry);
  };
  const ownedEntries = async (authority: ProtectedChatAuthority) => {
    authority.assertCurrent();
    const entries = await readSessionEntrySummariesInWorker({ agentId, env, storePath });
    authority.assertCurrent();
    return entries.flatMap(({ sessionKey, entry }) =>
      sessionKey !== `${prefix(authority.profileId)}${entry.sessionId}` ||
      !validId(entry.sessionId) ||
      entry.createdVia !== "plugin" ||
      entry.createdActor?.type !== "human" ||
      entry.createdActor.source !== "profile" ||
      entry.createdActor.id !== authority.profileId
        ? []
        : [entry],
    );
  };
  const list = async (authority: ProtectedChatAuthority) =>
    (await ownedEntries(authority)).map(summary);
  const capacityEntries = async () => {
    const entries = await readSessionEntrySummariesInWorker({ agentId, env, storePath });
    return entries.flatMap<{
      profileId: string;
      id: string;
      sessionKey: string;
      updatedAt: number;
      transient: boolean;
      title?: string;
      authoringDraftBytes?: number;
    }>(({ sessionKey, entry }) => {
      const internal: InternalSessionEntry = entry;
      if (internal.transientLifetime !== undefined) {
        const lifetime = readSessionTransientLifetime(internal);
        if (
          !lifetime ||
          !/^[a-zA-Z0-9_-]{1,128}$/u.test(lifetime.profileId) ||
          !validId(lifetime.parentSessionId) ||
          lifetime.parentSessionKey !==
            `${prefix(lifetime.profileId)}${lifetime.parentSessionId}` ||
          !validId(entry.sessionId) ||
          !sessionKey.startsWith(`agent:${agentId}:subagent:`) ||
          entry.createdVia !== "spawn" ||
          entry.parentSessionKey !== lifetime.parentSessionKey ||
          entry.spawnedBy !== lifetime.parentSessionKey
        ) {
          throw new Error("Cannot account for an ambiguous transient Family session.");
        }
        return [
          {
            profileId: lifetime.profileId,
            id: entry.sessionId,
            sessionKey,
            updatedAt: entry.updatedAt,
            transient: true,
          },
        ];
      }
      const actor = entry.createdActor;
      if (
        entry.createdVia !== "plugin" ||
        actor?.type !== "human" ||
        actor.source !== "profile" ||
        !actor.id ||
        !validId(entry.sessionId) ||
        sessionKey !== `${prefix(actor.id)}${entry.sessionId}`
      ) {
        return [];
      }
      return [
        {
          profileId: actor.id,
          id: entry.sessionId,
          sessionKey,
          updatedAt: entry.updatedAt,
          transient: false,
          title: entry.displayName,
          ...(entry.protectedAuthoringKind
            ? { authoringDraftBytes: draftBytes(readAuthoringDraft(entry)) }
            : {}),
        },
      ];
    });
  };
  const maxTranscriptEventBytes = 2 * 1024 * 1024;
  const readTranscriptSource = async (authority: ProtectedChatAuthority, id: string) => {
    const entry = await readEntry(authority, id);
    const events = await loadTranscriptEvents({
      ...scope(authority, id),
      sessionId: entry.sessionId,
      maxEventBytes: maxTranscriptEventBytes,
    });
    authority.assertCurrent();
    return { entry, events };
  };
  const projectTranscriptSource = (
    entry: SessionEntry,
    events: Awaited<ReturnType<typeof loadTranscriptEvents>>,
  ) => {
    const id = entry.sessionId;
    const messages: ProtectedMessage[] = [];
    let projections = projectToolResult(undefined, undefined);
    let reply: ProtectedMessage | undefined;
    let replyMessage: Record<string, unknown> | undefined;
    const toolReplies: ProtectedMessage[] = [];
    let reasoning: string[] = [];
    let activity = new Map<string, ProtectedActivity>();
    let turnStartedAt: number | undefined;
    let usage: ProtectedChatResponse["usage"];
    let runUsage = createSessionTranscriptUsageAccumulator();
    const widgetChain = createWidgetChain();
    // A side chat's chain starts after the parent prefix; it never points at the parent's widgets.
    const inheritedEvents = entry.protectedSideForkedAt?.eventCount ?? 0;
    for (const [eventIndex, event] of events.entries()) {
      if (!isRecord(event) || !isRecord(event.message)) {
        continue;
      }
      const chainWidget = eventIndex < inheritedEvents ? (widget: Widget) => widget : widgetChain;
      const budgetReceipt = event.message.protectedContextBudget;
      if (
        event.message.role === "assistant" &&
        event.message.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
        event.message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
        event.message.model === OPENCLAW_DELIVERY_MIRROR_MODEL &&
        isRecord(budgetReceipt)
      ) {
        if (
          usage &&
          reply?.id === budgetReceipt.responseId &&
          typeof budgetReceipt.contextSize === "number" &&
          Number.isSafeInteger(budgetReceipt.contextSize) &&
          budgetReceipt.contextSize > 0
        ) {
          usage.contextSize = budgetReceipt.contextSize;
        }
        continue;
      }
      const terminalReceipt =
        event.message.role === "assistant" &&
        event.message.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
        event.message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
        event.message.model === OPENCLAW_DELIVERY_MIRROR_MODEL &&
        (event.message.protectedTerminalCompletion === "tool-batch" ||
          event.message.protectedTerminalCompletion === "source-reply");
      const completedReply =
        terminalReceipt && replyMessage?.stopReason === "toolUse" ? reply : undefined;
      if (terminalReceipt && !completedReply) {
        continue;
      }
      // A host receipt completes the existing reply; it is not another model message.
      const message: Record<string, unknown> = completedReply
        ? { ...replyMessage, stopReason: "stop" }
        : event.message;
      if (message.role === "toolResult") {
        const prior = typeof message.toolCallId === "string" && activity.get(message.toolCallId);
        if (prior) {
          activity.set(prior.id, { ...prior, status: message.isError ? "failed" : "done" });
        }
        if (!message.isError) {
          const projected = projectToolResult(message.toolName, message.details);
          projections.sources = [...projections.sources, ...projected.sources].slice(0, 20);
          projections.widgets = [
            ...projections.widgets,
            ...projected.widgets.map(chainWidget),
          ].slice(0, 20);
          if (reply) {
            reply.sources = projections.sources;
            reply.widgets = projections.widgets;
          }
        }
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const content = transcriptText(message.content);
      const provider = typeof message.provider === "string" ? message.provider : undefined;
      const sideReturn = sideReturnOf(message);
      if (sideReturn) {
        // A returned reply stands alone: it is not the turn's reply and carries no usage or timing.
        messages.push({
          id: typeof event.id === "string" ? event.id : `${id}:${messages.length}`,
          role: "assistant",
          text: content,
          status: "complete",
          sideNote: sideReturn,
          // These are references to the side chat's widgets, so they never join this chat's chain.
          widgets: Array.isArray(message.protectedSideWidgets)
            ? message.protectedSideWidgets.flatMap((widget) =>
                isRecord(widget) &&
                typeof widget.id === "string" &&
                widgetIdPattern.test(widget.id) &&
                typeof widget.title === "string"
                  ? [{ id: widget.id, title: widget.title }]
                  : [],
              )
            : [],
        });
        continue;
      }
      const childMessage =
        provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
        message.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
        message.model === "protected-child";
      if (message.role === "user") {
        runUsage = createSessionTranscriptUsageAccumulator();
      } else if (
        !completedReply &&
        (provider === "sparky" ||
          provider === "github-copilot" ||
          provider === "anthropic" ||
          provider === "openai")
      ) {
        runUsage.add(message);
      }
      const errorText = typeof message.errorMessage === "string" ? message.errorMessage : "";
      const text =
        message.role === "assistant" && message.stopReason === "error"
          ? publicError(
              new FailoverError("Saved assistant failure", {
                reason: classifyFailoverReason(errorText, { provider }) ?? "unknown",
                provider,
              }),
            ).message
          : content;
      const status =
        message.role === "assistant"
          ? childMessage && message.protectedChildStatus === "failed"
            ? "failed"
            : message.stopReason === "aborted"
              ? "interrupted"
              : message.stopReason === "error" || message.stopReason === "toolUse"
                ? "failed"
                : "complete"
          : undefined;
      if (message.role === "assistant" && status === "complete") {
        const snapshot = aggregateSessionTranscriptUsage([message]);
        const tokens = runUsage.finish();
        const usageProvider = snapshot?.modelProvider;
        usage =
          typeof snapshot?.totalTokens === "number" &&
          typeof snapshot.model === "string" &&
          (usageProvider === "sparky" ||
            usageProvider === "github-copilot" ||
            usageProvider === "anthropic" ||
            usageProvider === "openai")
            ? {
                contextTokens: snapshot.totalTokens,
                // Native run usage omits zero counters, which can be adapter defaults.
                ...(tokens?.inputTokens !== undefined &&
                Number.isSafeInteger(tokens.inputTokens) &&
                tokens.inputTokens > 0
                  ? { inputTokens: tokens.inputTokens }
                  : {}),
                ...(tokens?.outputTokens !== undefined &&
                Number.isSafeInteger(tokens.outputTokens) &&
                tokens.outputTokens > 0
                  ? { outputTokens: tokens.outputTokens }
                  : {}),
                provider: usageProvider,
                model: snapshot.model,
              }
            : undefined;
      }
      if (message.role === "user") {
        projections = projectToolResult(undefined, undefined);
        reply = undefined;
        replyMessage = undefined;
        toolReplies.length = 0;
        reasoning = [];
        activity = new Map();
        const timestamp =
          typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
        turnStartedAt = Number.isFinite(timestamp) ? timestamp : undefined;
      } else if (!completedReply && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block)) {
            continue;
          }
          if (block.type === "thinking" && typeof block.thinking === "string") {
            reasoning.push(block.thinking.trim());
          }
          if (block.type === "toolCall") {
            const item = projectActivity(block.name, block.id, "running");
            if (item) {
              activity.set(item.id, item);
            }
          }
        }
      }
      const completedAt =
        typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
      const projected: ProtectedMessage = {
        id:
          completedReply?.id ??
          (typeof event.id === "string" ? event.id : `${id}:${messages.length}`),
        role: message.role,
        text,
        ...(message.role === "assistant" &&
        typeof message.protectedAgentId === "string" &&
        /^[a-z][a-z0-9-]{0,47}$/u.test(message.protectedAgentId)
          ? { agentId: message.protectedAgentId }
          : {}),
        ...(childMessage &&
        typeof message.protectedChildRunId === "string" &&
        validId(message.protectedChildRunId)
          ? { runId: message.protectedChildRunId }
          : {}),
        ...(status ? { status } : {}),
        ...(message.role === "assistant"
          ? childMessage
            ? {
                widgets: Array.isArray(message.protectedChildWidgets)
                  ? message.protectedChildWidgets
                      .filter(
                        (widget): widget is Widget =>
                          isRecord(widget) &&
                          typeof widget.id === "string" &&
                          widgetIdPattern.test(widget.id) &&
                          typeof widget.title === "string",
                      )
                      .map((widget) => chainWidget({ id: widget.id, title: widget.title }))
                  : [],
              }
            : projections
          : {}),
        ...(message.role === "assistant" && !childMessage && status !== "failed" && reasoning.length
          ? { reasoning: reasoning.join("\n") }
          : {}),
        ...(message.role === "assistant" && !childMessage && status !== "failed" && activity.size
          ? { activity: [...activity.values()] }
          : {}),
        ...(message.role === "assistant" &&
        status === "complete" &&
        turnStartedAt !== undefined &&
        Number.isFinite(completedAt) &&
        completedAt >= turnStartedAt
          ? { durationMs: completedAt - turnStartedAt }
          : {}),
      };
      if (completedReply) {
        messages[messages.length - 1] = projected;
      } else {
        messages.push(projected);
      }
      if (message.role === "assistant") {
        if (message.stopReason === "toolUse" && text.trim()) {
          toolReplies.push(projected);
        } else if (
          completedReply ||
          (message.stopReason === "stop" &&
            typeof provider === "string" &&
            provider !== OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
            message.api !== OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
            !isTranscriptOnlyOpenClawAssistantMessage(message))
        ) {
          // A completed turn also settles its earlier visible tool-call fragments.
          for (const toolReply of toolReplies) {
            toolReply.status = "complete";
          }
          toolReplies.length = 0;
        }
        if (reply && !childMessage && replyMessage?.model !== "protected-child") {
          delete reply.sources;
          delete reply.widgets;
        }
        reply = projected;
        replyMessage = message;
        if (completedReply && event.message.protectedTerminalCompletion === "source-reply") {
          // The widget stays with the model's preamble; the host delivered the note after it.
          reply = {
            id: typeof event.id === "string" ? event.id : `${id}:${messages.length}`,
            role: "assistant",
            text: transcriptText(event.message.content),
            status: "complete",
          };
          messages.push(reply);
          replyMessage = event.message;
        }
      }
    }
    const visible = messages.filter(
      (message) =>
        message.role === "user" ||
        message.text.trim() ||
        message.widgets?.length ||
        message.status !== "failed",
    );
    const chat: ProtectedChat = {
      ...summary(entry),
      // The forked prefix stays in the transcript for the model and is never re-sent to the client.
      messages: entry.protectedSideForkedAt
        ? visible.slice(entry.protectedSideForkedAt.messageCount)
        : visible,
    };
    return { chat, usage };
  };
  const readWithUsage = async (authority: ProtectedChatAuthority, id: string) => {
    const { entry, events } = await readTranscriptSource(authority, id);
    return { ...projectTranscriptSource(entry, events), entry };
  };
  return {
    env,
    agentId,
    storePath,
    scope,
    readEntry,
    list,
    async sideChatsOf(authority: ProtectedChatAuthority, parentId: string) {
      return (await list(authority)).filter((chat) => chat.side?.parentId === parentId);
    },
    read: async (authority: ProtectedChatAuthority, id: string) =>
      (await readWithUsage(authority, id)).chat,
    readWithUsage,
    async readReportChatSource(authority: ProtectedChatAuthority, id: string, eventCount?: number) {
      const { entry, events } = await readTranscriptSource(authority, id);
      // Report evidence for a side chat is its own events; the parent's prefix is not part of it.
      const inherited = entry.protectedSideForkedAt?.eventCount ?? 0;
      const own = events.slice(inherited);
      return {
        ...projectTranscriptSource(
          entry,
          eventCount === undefined ? events : events.slice(0, inherited + eventCount),
        ),
        events: own,
      };
    },
    capacityEntries,
    async saveContextBudget(
      authority: ProtectedChatAuthority,
      id: string,
      result: {
        runId: string;
        responseId: string;
        contextSize: number;
        lifecycleRevision: string | null;
      },
    ) {
      const message = {
        role: "assistant",
        content: [],
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: OPENCLAW_DELIVERY_MIRROR_MODEL,
        usage: makeZeroUsageSnapshot(),
        stopReason: "stop",
        timestamp: Date.now(),
        protectedContextBudget: { responseId: result.responseId, contextSize: result.contextSize },
      } satisfies SessionTranscriptAssistantMessage & {
        protectedContextBudget: { responseId: string; contextSize: number };
      };
      const saved = await appendExactAssistantMessageToSessionTranscript({
        ...scope(authority, id),
        expectedSessionId: id,
        expectedLifecycleRevision: result.lifecycleRevision,
        idempotencyKey: `protected-context-budget:${result.runId}`,
        message,
        assertCurrent: authority.assertCurrent,
      });
      authority.assertCurrent();
      if (!saved.ok) {
        throw new ProtectedError(500, "save_failed", "The context budget could not be saved.");
      }
    },
    removeTransientFiles(authority: ProtectedChatAuthority, sessionId: string) {
      authority.assertCurrent();
      if (!validId(sessionId)) {
        return missing();
      }
      return removeFiles(authority.profileId, sessionId, authority.assertCurrent);
    },
    async saveChildResult(
      authority: ProtectedChatAuthority,
      id: string,
      result: {
        runId: string;
        agentId: string;
        text: string;
        timestamp: number;
        parentLifecycleRevision: string | null;
        widgets?: Widget[];
        status?: "complete" | "failed";
      },
    ) {
      await readEntry(authority, id);
      if (
        !options.agentCatalog.get(result.agentId) ||
        (!result.text.trim() && !result.widgets?.length)
      ) {
        throw new ProtectedError(500, "save_failed", "The agent result could not be saved.");
      }
      const message = {
        role: "assistant",
        content: [{ type: "text", text: result.text }],
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: "protected-child",
        usage: makeZeroUsageSnapshot(),
        stopReason: "stop",
        timestamp: result.timestamp,
        protectedAgentId: result.agentId,
        protectedChildRunId: result.runId,
        protectedChildStatus: result.status ?? "complete",
        protectedChildWidgets: result.widgets ?? [],
      } satisfies SessionTranscriptAssistantMessage & {
        protectedAgentId: string;
        protectedChildRunId: string;
        protectedChildStatus: "complete" | "failed";
        protectedChildWidgets: Widget[];
      };
      const saved = await appendExactAssistantMessageToSessionTranscript({
        ...scope(authority, id),
        expectedSessionId: id,
        expectedLifecycleRevision: result.parentLifecycleRevision,
        idempotencyKey: `protected-child:${result.runId}`,
        message,
        assertCurrent: authority.assertCurrent,
      });
      authority.assertCurrent();
      if (!saved.ok) {
        throw new ProtectedError(500, "save_failed", "The agent result could not be saved.");
      }
    },
    recoverTransient(assertCurrent: () => void) {
      return recoverTransientSessionEntries({
        agentId,
        env,
        storePath,
        assertCurrent,
        retireRegistry: ({
          sessionKey,
          sessionId,
          lifecycleRevision,
          parentSessionKey,
          assertCurrent: assertRecoveryCurrent,
        }) =>
          retireTransientSubagentRun({
            env,
            assertCurrent: assertRecoveryCurrent,
            childSessionKey: sessionKey,
            childSessionId: sessionId,
            childLifecycleRevision: lifecycleRevision,
            parentSessionKey,
          }),
        beforeDelete: ({ sessionId, lifetime, assertCurrent: assertRecoveryCurrent }) =>
          removeFiles(lifetime.profileId, sessionId, assertRecoveryCurrent),
        owns: ({ sessionKey, sessionId, lifetime, parent }) =>
          /^[a-zA-Z0-9_-]{1,128}$/u.test(lifetime.profileId) &&
          validId(lifetime.parentSessionId) &&
          validId(sessionId) &&
          lifetime.parentSessionKey ===
            `${prefix(lifetime.profileId)}${lifetime.parentSessionId}` &&
          sessionKey.startsWith(`agent:${agentId}:subagent:`) &&
          parent.createdVia === "plugin" &&
          parent.createdActor?.type === "human" &&
          parent.createdActor.source === "profile" &&
          parent.createdActor.id === lifetime.profileId,
      });
    },
    async transcriptBytes(sessionId: string, sessionKey: string) {
      const stats = await readTranscriptStatsAsync({
        agentId,
        env,
        storePath,
        sessionId,
        sessionKey,
      });
      return stats.sizeBytes;
    },
    async create(
      authority: ProtectedChatAuthority,
      title = "New chat",
      selectedAgentId = options.agentCatalog.defaultAgentId,
      authoring?: { kind: "automation"; automationId?: string; snapshot?: ProtectedAuthoringDraft },
      automationRun?: { chatId: string; automationId: string },
    ): Promise<ProtectedChat> {
      authority.assertCurrent();
      if (automationRun && (authoring || !validId(automationRun.automationId))) {
        throw new ProtectedError(400, "invalid_request", "The automation identity is invalid.");
      }
      if ((await list(authority)).length >= options.maxChatsPerUser) {
        throw new ProtectedError(
          413,
          "quota_exceeded",
          "Your chat budget is full. Export or delete a chat.",
        );
      }
      const id = automationRun?.chatId ?? randomUUID();
      if (!validId(id)) {
        throw new ProtectedError(400, "invalid_request", "The chat identity is invalid.");
      }
      const now = Date.now();
      const result = await createSessionEntryWithTranscript(
        scope(authority, id),
        ({ existingEntry }) => {
          authority.assertCurrent();
          if (existingEntry) {
            return { ok: false, error: "Chat identity collision" };
          }
          return {
            ok: true,
            entry: {
              sessionId: id,
              updatedAt: now,
              createdAt: now,
              displayName: title,
              protectedAgentId: selectedAgentId,
              ...(automationRun ? { protectedAutomationRunId: automationRun.automationId } : {}),
              ...(authoring
                ? {
                    protectedAuthoringKind: authoring.kind,
                    ...(authoring.snapshot
                      ? {
                          pluginExtensions: draftExtension(undefined, authoring.snapshot),
                        }
                      : {}),
                    ...(authoring.automationId
                      ? { protectedAutomationId: authoring.automationId }
                      : {}),
                  }
                : {}),
              createdVia: "plugin",
              createdActor: { type: "human", source: "profile", id: authority.profileId },
            },
          };
        },
        { requireWriteSuccess: true, commitGuard: authority.assertCurrent },
      );
      authority.assertCurrent();
      if (!result.ok) {
        throw new ProtectedError(500, "save_failed", "The chat could not be saved.");
      }
      return { ...summary(result.entry), messages: [] };
    },
    /**
     * Forks the owner's chat transcript up to its last completed reply into a new chat. The model
     * sees that prefix, byte for byte, followed by the side chat's own messages.
     */
    async createSide(
      authority: ProtectedChatAuthority,
      parentId: string,
      input: { requestId: string; title?: string; selectedAgentId?: string },
    ): Promise<{ chat: ProtectedChatSummary; created: boolean }> {
      authority.assertCurrent();
      const requested = await readEntry(authority, parentId);
      // One level only: a side chat branches from the chat it was forked from.
      const parent = requested.protectedSideParentId
        ? await readEntry(authority, requested.protectedSideParentId)
        : requested;
      if (parent.protectedAutomationRunId || parent.protectedAuthoringKind) {
        throw new ProtectedError(422, "side_unavailable", "This chat cannot have side chats.");
      }
      const owned = await ownedEntries(authority);
      const replay = owned.find((entry) => entry.protectedSideRequestId === input.requestId);
      if (replay) {
        if (replay.protectedSideParentId !== parent.sessionId) {
          throw new ProtectedError(
            409,
            "request_conflict",
            "This request already created a side chat for another chat.",
          );
        }
        return { chat: summary(replay), created: false };
      }
      if (owned.length >= options.maxChatsPerUser) {
        throw new ProtectedError(
          413,
          "quota_exceeded",
          "Your chat budget is full. Export or delete a chat.",
        );
      }
      const parentAgentId = summary(parent).selectedAgentId;
      const selectedAgentId =
        input.selectedAgentId ??
        (parentAgentId && options.agentCatalog.getSelectable(parentAgentId)
          ? parentAgentId
          : options.agentCatalog.defaultAgentId);
      if (!options.agentCatalog.getSelectable(selectedAgentId)) {
        throw new ProtectedError(422, "agent_unavailable", "This agent is not available.");
      }
      const parentEvents = await loadTranscriptEvents({
        ...scope(authority, parent.sessionId),
        sessionId: parent.sessionId,
        maxEventBytes: maxTranscriptEventBytes,
      });
      authority.assertCurrent();
      const source = resolveParentForkSourceTranscript(parentEvents, "last-completed");
      const id = randomUUID();
      const now = Date.now();
      const entry: SessionEntry = {
        sessionId: id,
        updatedAt: now,
        createdAt: now,
        displayName: input.title ?? "Side chat",
        protectedAgentId: selectedAgentId,
        protectedSideParentId: parent.sessionId,
        protectedSideRequestId: input.requestId,
        createdVia: "plugin",
        createdActor: { type: "human", source: "profile", id: authority.profileId },
      };
      const forkEvents = source
        ? buildForkedChildTranscriptEvents({
            parentSessionFile: formatSqliteSessionFileMarker({
              agentId,
              sessionId: parent.sessionId,
              storePath,
            }),
            source,
            targetSessionId: id,
          })
        : [];
      const inherited = projectTranscriptSource(entry, forkEvents).chat.messages;
      const last = inherited.at(-1);
      if (!last) {
        throw new ProtectedError(
          422,
          "side_unavailable",
          "Send a message in this chat before starting a side chat.",
        );
      }
      entry.protectedSideForkedAt = {
        messageId: last.id,
        messageCount: inherited.length,
        eventCount: forkEvents.length,
      };
      const result = await createSessionEntryWithTranscript(
        scope(authority, id),
        ({ existingEntry }) => {
          authority.assertCurrent();
          return existingEntry
            ? { ok: false, error: "Chat identity collision" }
            : { ok: true, entry, transcriptEvents: forkEvents };
        },
        { requireWriteSuccess: true, commitGuard: authority.assertCurrent },
      );
      authority.assertCurrent();
      if (!result.ok) {
        throw new ProtectedError(500, "save_failed", "The chat could not be saved.");
      }
      return { chat: summary(result.entry), created: true };
    },
    /** Copies chosen side replies into the parent as one message; no model call. */
    async returnSide(
      authority: ProtectedChatAuthority,
      sideId: string,
      input: { requestId: string; messageIds: string[]; note?: string },
      // Wraps only a new append, so a replay never needs storage admission.
      withStorage: <T>(append: () => Promise<T>) => Promise<T> = (append) => append(),
    ): Promise<{ parent: { id: string; version: string }; message: ProtectedMessage }> {
      authority.assertCurrent();
      const side = await readEntry(authority, sideId);
      if (!side.protectedSideParentId) {
        throw new ProtectedError(422, "side_unavailable", "This chat is not a side chat.");
      }
      const parentId = side.protectedSideParentId;
      const source = await readTranscriptSource(authority, parentId);
      const settle = (parent: SessionEntry, events: typeof source.events, messageId: string) => {
        const message = projectTranscriptSource(parent, events).chat.messages.find(
          (candidate) => candidate.id === messageId,
        );
        if (!message?.sideNote || message.sideNote.chatId !== sideId) {
          throw new ProtectedError(
            409,
            "request_conflict",
            "This request already sent a reply from another chat.",
          );
        }
        return { parent: { id: parentId, version: String(parent.updatedAt) }, message };
      };
      const idempotencyKey = `protected-side-return:${input.requestId}`;
      const prior = source.events.find(
        (event) =>
          isRecord(event) &&
          isRecord(event.message) &&
          event.message.idempotencyKey === idempotencyKey,
      );
      if (prior && isRecord(prior) && typeof prior.id === "string") {
        return settle(source.entry, source.events, prior.id);
      }
      const own = (await readWithUsage(authority, sideId)).chat.messages;
      const chosen = new Set(input.messageIds);
      const replies = own.filter((message) => chosen.has(message.id));
      if (
        replies.length !== chosen.size ||
        replies.some(
          (reply) =>
            reply.role !== "assistant" ||
            reply.status !== "complete" ||
            (!reply.text.trim() && !reply.widgets?.length),
        )
      ) {
        throw new ProtectedError(
          422,
          "invalid_message",
          "Choose finished replies from this side chat.",
        );
      }
      const widgets = [
        ...new Map(
          replies.flatMap((reply) => reply.widgets ?? []).map((widget) => [widget.id, widget]),
        ).values(),
      ]
        .slice(0, 20)
        .map((widget) => ({ id: widget.id, title: widget.title }));
      const title = side.displayName ?? "Side chat";
      const message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: composeSideReturnText(
              replies.map((reply) => reply.text),
              input.note,
              widgets.map((widget) => widget.title),
            ),
          },
        ],
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: sideReturnModel,
        usage: makeZeroUsageSnapshot(),
        stopReason: "stop",
        timestamp: Date.now(),
        protectedSideNote: { chatId: sideId, title },
        protectedSideWidgets: widgets,
      } satisfies SessionTranscriptAssistantMessage & {
        protectedSideNote: { chatId: string; title: string };
        protectedSideWidgets: Widget[];
      };
      const saved = await withStorage(() =>
        appendExactAssistantMessageToSessionTranscript({
          ...scope(authority, parentId),
          expectedSessionId: parentId,
          expectedLifecycleRevision: source.entry.lifecycleRevision ?? null,
          idempotencyKey,
          message,
          assertCurrent: authority.assertCurrent,
        }),
      );
      authority.assertCurrent();
      if (!saved.ok) {
        throw new ProtectedError(500, "save_failed", "The reply could not be sent.");
      }
      const after = await readTranscriptSource(authority, parentId);
      return settle(after.entry, after.events, saved.messageId);
    },
    async selectAgent(
      authority: ProtectedChatAuthority,
      id: string,
      version: string,
      selectedAgentId: string,
    ): Promise<ProtectedChatSummary> {
      return updateMetadata(
        authority,
        id,
        version,
        { protectedAgentId: selectedAgentId },
        new ProtectedError(
          409,
          "version_conflict",
          "This chat changed. Reload before changing its agent.",
        ),
      );
    },
    async checkpointDraft(
      authority: ProtectedChatAuthority,
      id: string,
      baseDraftRevision: string | null,
      draft: ProtectedAuthoringDraft["draft"],
      charge: (bytes: number) => void,
    ): Promise<ProtectedAuthoringDraft> {
      const current = await readEntry(authority, id);
      if (current.protectedAuthoringKind !== "automation" || current.protectedAutomationId) {
        return missing();
      }
      const previous = readAuthoringDraft(current);
      if ((previous?.draftRevision ?? null) !== baseDraftRevision) {
        throw draftMismatch();
      }
      const draftRevision = String(BigInt(baseDraftRevision ?? "0") + 1n);
      if (draftRevision.length > 16) {
        throw new ProtectedError(409, "revision_limit", "This draft reached its revision limit.");
      }
      const snapshot = { draft, draftRevision };
      charge(Math.max(0, draftBytes(snapshot) - draftBytes(previous)));
      await updateMetadata(
        authority,
        id,
        String(current.updatedAt),
        {
          ...(current.displayName === (previous?.draft.name ?? "New automation")
            ? { displayName: draft.name }
            : {}),
          pluginExtensions: draftExtension(current.pluginExtensions, snapshot),
        },
        draftMismatch(),
      );
      return snapshot;
    },
    /** Binds an unsaved authoring chat to its first saved automation; idempotent, never rebinds. */
    async bindAutomation(
      authority: ProtectedChatAuthority,
      id: string,
      automationId: string,
      savedDraftMatches: (draft: ProtectedAuthoringDraft["draft"]) => boolean,
    ): Promise<ProtectedChatSummary> {
      // A running turn may advance the entry between the read and the guarded write.
      for (let attempt = 0; ; attempt++) {
        const current = await readEntry(authority, id);
        if (current.protectedAutomationId === automationId) {
          return summary(current);
        }
        const snapshot = readAuthoringDraft(current);
        if (snapshot && !savedDraftMatches(snapshot.draft)) {
          // A keyed create can find an earlier save. Do not consume a newer checkpoint.
          return summary(current);
        }
        try {
          return await updateMetadata(
            authority,
            id,
            String(current.updatedAt),
            {
              protectedAutomationId: automationId,
              ...(snapshot ? { pluginExtensions: draftExtension(current.pluginExtensions) } : {}),
            },
            new ProtectedError(
              409,
              "version_conflict",
              "This chat changed. Reload it and try again.",
            ),
          );
        } catch (error) {
          if (
            attempt >= 2 ||
            !(error instanceof ProtectedError) ||
            error.code !== "version_conflict"
          ) {
            throw error;
          }
        }
      }
    },
    async rename(
      authority: ProtectedChatAuthority,
      id: string,
      version: string,
      title: string,
    ): Promise<ProtectedChatSummary> {
      return updateMetadata(
        authority,
        id,
        version,
        { displayName: title },
        new ProtectedError(412, "version_conflict", "This chat changed. Reload before renaming."),
      );
    },
    async delete(
      authority: ProtectedChatAuthority,
      id: string,
      version: string,
      removeChatFiles: () => Promise<void>,
    ) {
      const entry = await readEntry(authority, id);
      if (version !== String(entry.updatedAt)) {
        throw new ProtectedError(
          409,
          "version_conflict",
          "This chat changed. Reload before deleting.",
        );
      }
      await removeChatFiles();
      authority.assertCurrent();
      const target = scope(authority, id);
      const result = await deleteSessionEntryLifecycle({
        ...target,
        target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        deleteDeliveryArtifacts: true,
        expectedEntry: entry,
        expectedSessionId: id,
        expectedUpdatedAt: entry.updatedAt,
        commitGuard: authority.assertCurrent,
        requireWriteSuccess: true,
      });
      authority.assertCurrent();
      if (!result.deletedEntry) {
        throw new ProtectedError(
          409,
          "version_conflict",
          "This chat changed. Reload before deleting.",
        );
      }
    },
  };
}

export type ProtectedChats = ReturnType<typeof createProtectedChats>;
