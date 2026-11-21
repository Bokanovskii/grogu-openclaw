import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ProtectedChat,
  ProtectedChatSummary,
  ProtectedMessage,
} from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { retireTransientSubagentRun } from "../../src/agents/subagents/registry/subagent-registry-transient-recovery.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
} from "../../src/config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
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
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../src/shared/transcript-only-openclaw-assistant.js";
import { defaultProtectedAgentId, type ProtectedAgentCatalog } from "./agents.js";
import { removeChatFilesDirectory } from "./chat-files.js";
import { ProtectedError } from "./errors.js";
import { projectToolResult } from "./tool-events.js";

export type ProtectedChatAuthority = { profileId: string; assertCurrent: () => void };

function missing(): never {
  throw new ProtectedError(404, "not_found", "Chat not found.");
}

function validId(id: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id);
}

function summary(entry: SessionEntry): ProtectedChatSummary {
  return {
    id: entry.sessionId,
    title: entry.displayName ?? "New chat",
    version: String(entry.updatedAt),
    updatedAt: entry.updatedAt,
    selectedAgentId:
      typeof entry.protectedAgentId === "string" &&
      /^[a-z][a-z0-9-]{0,47}$/u.test(entry.protectedAgentId)
        ? entry.protectedAgentId
        : defaultProtectedAgentId,
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
  const env = Object.freeze({ OPENCLAW_STATE_DIR: options.stateDir });
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
  const list = async (authority: ProtectedChatAuthority) => {
    authority.assertCurrent();
    const entries = await readSessionEntrySummariesInWorker({ agentId, env, storePath });
    authority.assertCurrent();
    return entries.flatMap(({ sessionKey, entry }) => {
      if (
        sessionKey !== `${prefix(authority.profileId)}${entry.sessionId}` ||
        !validId(entry.sessionId) ||
        entry.createdVia !== "plugin" ||
        entry.createdActor?.type !== "human" ||
        entry.createdActor.source !== "profile" ||
        entry.createdActor.id !== authority.profileId
      ) {
        return [];
      }
      return [summary(entry)];
    });
  };
  const capacityEntries = async () => {
    const entries = await readSessionEntrySummariesInWorker({ agentId, env, storePath });
    return entries.flatMap(({ sessionKey, entry }) => {
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
          { profileId: lifetime.profileId, id: entry.sessionId, sessionKey, chargeFiles: true },
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
      return [{ profileId: actor.id, id: entry.sessionId, sessionKey, chargeFiles: true }];
    });
  };
  const read = async (authority: ProtectedChatAuthority, id: string): Promise<ProtectedChat> => {
    const entry = await readEntry(authority, id);
    const events = await loadTranscriptEvents({
      ...scope(authority, id),
      sessionId: entry.sessionId,
      maxEventBytes: 2 * 1024 * 1024,
    });
    authority.assertCurrent();
    const messages: ProtectedMessage[] = [];
    let projections = projectToolResult(undefined, undefined);
    let reply: ProtectedMessage | undefined;
    for (const event of events) {
      if (!isRecord(event) || !isRecord(event.message)) {
        continue;
      }
      const message = event.message;
      if (message.role === "toolResult" && !message.isError) {
        const projected = projectToolResult(message.toolName, message.details);
        projections.sources = [...projections.sources, ...projected.sources].slice(0, 20);
        projections.widgets = [...projections.widgets, ...projected.widgets].slice(0, 20);
        if (reply) {
          reply.sources = projections.sources;
          reply.widgets = projections.widgets;
        }
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((block) => isRecord(block) && block.type === "text")
                .map((block) => (typeof block.text === "string" ? block.text : ""))
                .join("\n")
            : "";
      const status =
        message.role === "assistant"
          ? message.stopReason === "aborted"
            ? "interrupted"
            : message.stopReason === "error" || message.stopReason === "toolUse"
              ? "failed"
              : "complete"
          : undefined;
      if (message.role === "user") {
        projections = projectToolResult(undefined, undefined);
        reply = undefined;
      }
      const projected: ProtectedMessage = {
        id: typeof event.id === "string" ? event.id : `${id}:${messages.length}`,
        role: message.role,
        text,
        ...(message.role === "assistant" &&
        typeof message.protectedAgentId === "string" &&
        /^[a-z][a-z0-9-]{0,47}$/u.test(message.protectedAgentId)
          ? { agentId: message.protectedAgentId }
          : {}),
        ...(status ? { status } : {}),
        ...(message.role === "assistant" ? projections : {}),
      };
      messages.push(projected);
      if (message.role === "assistant") {
        if (reply) {
          delete reply.sources;
          delete reply.widgets;
        }
        reply = projected;
      }
    }
    return {
      ...summary(entry),
      messages: messages.filter(
        (message) =>
          message.role === "user" ||
          message.text.trim() ||
          message.widgets?.length ||
          message.status !== "failed",
      ),
    };
  };
  return {
    env,
    agentId,
    storePath,
    scope,
    readEntry,
    list,
    read,
    capacityEntries,
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
      },
    ) {
      await readEntry(authority, id);
      if (!options.agentCatalog.get(result.agentId) || !result.text.trim()) {
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
      } satisfies SessionTranscriptAssistantMessage & { protectedAgentId: string };
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
    ): Promise<ProtectedChat> {
      authority.assertCurrent();
      if ((await list(authority)).length >= options.maxChatsPerUser) {
        throw new ProtectedError(
          413,
          "quota_exceeded",
          "Your chat budget is full. Export or delete a chat.",
        );
      }
      const id = randomUUID();
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
    async selectAgent(
      authority: ProtectedChatAuthority,
      id: string,
      version: string,
      selectedAgentId: string,
    ): Promise<ProtectedChatSummary> {
      const current = await readEntry(authority, id);
      if (String(current.updatedAt) !== version) {
        throw new ProtectedError(
          409,
          "version_conflict",
          "This chat changed. Reload before changing its agent.",
        );
      }
      const expectedUpdatedAt = current.updatedAt;
      let committed = false;
      const entry = await applySessionEntryOperation(
        scope(authority, id),
        {
          kind: "fields",
          expected: {
            sessionId: id,
            createdVia: "plugin",
            createdActorProfileId: authority.profileId,
            updatedAt: expectedUpdatedAt,
          },
          patch: {
            protectedAgentId: selectedAgentId,
            updatedAt: Math.max(Date.now(), expectedUpdatedAt + 1),
          },
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
        throw new ProtectedError(
          409,
          "version_conflict",
          "This chat changed. Reload before changing its agent.",
        );
      }
      return summary(entry);
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
