import { createHash } from "node:crypto";
import {
  projectPluginMessageDeliveryFact,
  readEmbeddedMessageDeliveryFact,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CompletionReceipt, Request, SessionRef, TopicRecord } from "./schema.js";

type Session = Pick<SessionRef, "sessionKey" | "sessionId">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Research Topics delivery requires ${field}.`);
  }
  return value;
}

export function createDelivery(api: OpenClawPluginApi) {
  const config = record(api.pluginConfig?.delivery);
  if (!config) {
    return undefined;
  }
  const agentId = requiredString(config.agentId, "agentId");
  const channel = requiredString(config.channel, "channel");
  const target = requiredString(config.target, "target");
  const accountId =
    config.accountId === undefined ? undefined : requiredString(config.accountId, "accountId");
  const mainKey =
    api.config.session?.scope === "global"
      ? "global"
      : buildAgentMainSessionKey({
          agentId,
          mainKey: api.config.session?.mainKey,
        });

  const authorize = (caller: Session | undefined) => {
    if (
      !caller ||
      (caller.sessionKey !== mainKey && resolveAgentIdFromSessionKey(caller.sessionKey) !== agentId)
    ) {
      throw new Error("Research delivery requires a current session of its configured agent.");
    }
  };
  const isMain = (caller: Session | undefined) => caller?.sessionKey === mainKey;
  const mainSession = async (assertCurrent: () => void): Promise<Session> => {
    assertCurrent();
    const entry = await api.runtime.agent.session.getSessionEntryAsync({
      agentId,
      sessionKey: mainKey,
      readConsistency: "latest",
    });
    assertCurrent();
    if (!entry?.sessionId) {
      throw new Error(
        "The configured Main session is unavailable. Open Main before handing off research.",
      );
    }
    return { sessionKey: mainKey, sessionId: entry.sessionId };
  };

  // The message tool resolves an omitted channel or account itself, so Main may leave them out.
  // An omitted channel is trusted only when the target names it; explicit values must match.
  const routeMatches = (params: Record<string, unknown>) =>
    params.target === target &&
    (params.channel === channel ||
      (params.channel === undefined && target.startsWith(`${channel}:`))) &&
    (accountId === undefined || params.accountId === undefined || params.accountId === accountId);

  function receipt(
    params: Record<string, unknown>,
    result: unknown,
    caller: Session,
    toolCallId: string,
    completedAtMs: number,
  ): CompletionReceipt | undefined {
    const outcome = record(result);
    // Core attaches `messageDelivery` only to replies to the current source. Plugin-handled sends
    // from other runs, such as Main's cron review, return only the channel's own success envelope.
    const recorded = record(outcome?.details)?.messageDelivery;
    const delivery =
      recorded === undefined
        ? projectPluginMessageDeliveryFact(result)
        : readEmbeddedMessageDeliveryFact(recorded);
    const messageId = delivery?.primaryPlatformMessageId;
    if (
      !isMain(caller) ||
      params.action !== "send" ||
      !routeMatches(params) ||
      params.dryRun === true ||
      outcome?.isError === true ||
      delivery?.status !== "settled" ||
      delivery.partialDelivery ||
      !messageId?.trim()
    ) {
      return undefined;
    }
    return { ...caller, kind: "owner_text", messageId, toolCallId, completedAtMs };
  }

  return {
    authorize,
    isMain,
    mainSession,
    receipt,
    route: { channel, target, ...(accountId ? { accountId } : {}) },
    async recoverReceipt(
      caller: Session | undefined,
      topic: TopicRecord,
      toolCallId: string | undefined,
      assertCurrent: () => void,
    ) {
      if (!caller || !isMain(caller)) {
        throw new Error("Only Main can reconcile its completion text.");
      }
      const ownerText = topic.ownerText;
      if (!ownerText) {
        throw new Error(
          "No completion text is prepared for this topic. Reread it and use prepare_text for a pending completion.",
        );
      }
      const current = await mainSession(assertCurrent);
      if (current.sessionId !== caller.sessionId) {
        throw new Error("Main changed. Reconcile the completion in its current session.");
      }
      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey: mainKey,
        limit: 200,
      });
      assertCurrent();
      // Serving layers generate tool-call IDs, so the model cannot be expected to quote one:
      // find the send by the prepared wording unless an exact call was named. Core keeps no topic
      // in a persisted result over 8 KiB, so the preparation is read from its call arguments.
      const preparations = new Set<string>();
      const sends = new Map<string, Record<string, unknown>>();
      let prepared = false;
      for (const value of messages) {
        const message = record(value);
        const calls =
          message?.role === "assistant" && Array.isArray(message.content) ? message.content : [];
        for (const content of calls) {
          const call = record(content);
          const params = record(call?.arguments);
          if (call?.type !== "toolCall" || typeof call.id !== "string") {
            continue;
          }
          if (
            call.name === "research_topics" &&
            params?.action === "prepare_text" &&
            params.id === topic.id &&
            params.completionId === topic.completionId &&
            params.ownerText === ownerText
          ) {
            preparations.add(call.id);
          } else if (
            prepared &&
            call.name === "message" &&
            (toolCallId === undefined || call.id === toolCallId) &&
            params?.message === ownerText
          ) {
            sends.set(call.id, params);
          }
        }
        if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") {
          continue;
        }
        if (
          message.toolName === "research_topics" &&
          message.isError !== true &&
          preparations.has(message.toolCallId)
        ) {
          prepared = true;
        }
        const params = message.toolName === "message" ? sends.get(message.toolCallId) : undefined;
        if (
          params &&
          typeof message.timestamp === "number" &&
          message.timestamp >= (topic.completedAtMs ?? Infinity)
        ) {
          const verified = receipt(params, message, caller, message.toolCallId, message.timestamp);
          if (verified) {
            return verified;
          }
        }
      }
      throw new Error(
        "No successful native text for the prepared wording is in Main's recent history. If this wording may already have been sent, keep completion pending. If it was never sent, send it once through message to the returned route; the plugin records the receipt.",
      );
    },
    async post(
      request: Extract<Request, { action: "post_update" }>,
      topic: TopicRecord,
      assertCurrent: () => void,
    ): Promise<CompletionReceipt> {
      const destination = topic.sessionRefs.find(
        (ref) => ref.sessionKey === request.sessionKey && ref.sessionId === request.sessionId,
      );
      if (
        !destination ||
        (destination.sessionKey !== mainKey &&
          resolveAgentIdFromSessionKey(destination.sessionKey) !== agentId)
      ) {
        throw new Error(
          "The update destination must be a recorded source conversation of this agent.",
        );
      }
      if (topic.status === "completion_pending" && request.completionId !== topic.completionId) {
        throw new Error("Use the current completionId for a closing thread update.");
      }
      if (topic.status === "active" && request.completionId !== undefined) {
        throw new Error("The topic is active. Reread before sending an old closing update.");
      }
      assertCurrent();
      const idempotencyKey = `research:${createHash("sha256")
        .update(
          JSON.stringify([
            topic.id,
            topic.createdAtMs,
            request.operationId,
            destination.sessionKey,
            destination.sessionId,
          ]),
        )
        .digest("hex")}`;
      const result = await appendSessionTranscriptMessageByIdentityStrict({
        agentId,
        ...destination,
        config: api.config,
        message: {
          role: "assistant",
          content: [{ type: "text", text: request.message }],
          api: "openai-responses",
          provider: "openclaw",
          model: "research-topics",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          idempotencyKey,
        },
        idempotencyLookup: "scan",
        preparation: { source: assertCurrent },
        updateMode: "inline",
      });
      assertCurrent();
      if (result.kind !== "result") {
        throw new Error(
          `Research thread update was not stored: ${result.kind}. Keep its completion pending.`,
        );
      }
      return {
        kind: "session_message",
        ...destination,
        messageId: result.result.messageId,
        completedAtMs: Date.now(),
      };
    },
    async notify(
      request: Extract<Request, { action: "notify_main" }>,
      topic: TopicRecord,
      assertCurrent: () => void,
    ) {
      const main = await mainSession(assertCurrent);
      const currentConfig = api.runtime.config.current();
      const agentModel = currentConfig.agents?.entries?.[agentId]?.model;
      const defaultModel = currentConfig.agents?.defaults?.model;
      const model =
        (typeof agentModel === "string" ? agentModel : agentModel?.primary)?.trim() ||
        (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary)?.trim();
      if (!model) {
        throw new Error("Research handoffs require a configured primary model for Main.");
      }
      const result = await api.runtime.subagent.run({
        sessionKey: main.sessionKey,
        model,
        message:
          `Research text candidate for ${topic.title} (${topic.id}, revision ${topic.revision}).\n` +
          (topic.completionId
            ? `Completion ${topic.completionId} needs an owner acknowledgment.\n`
            : "") +
          `${request.message}\nDecide using your recent owner conversation and text policy. ` +
          "Use research_topics get for the current brief before acting.",
        deliver: false,
        idempotencyKey: `research:${createHash("sha256")
          .update(
            JSON.stringify([topic.id, topic.createdAtMs, request.operationId, main.sessionKey]),
          )
          .digest("hex")}`,
        assertCurrent,
      });
      return { ...result, status: "accepted", delivery: "Main decides whether to text" };
    },
  };
}
