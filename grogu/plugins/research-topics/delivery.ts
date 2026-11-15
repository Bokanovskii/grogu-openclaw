import { createHash } from "node:crypto";
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

  function receipt(
    params: Record<string, unknown>,
    result: unknown,
    caller: Session,
    toolCallId: string,
    completedAtMs: number,
  ): CompletionReceipt | undefined {
    const details = record(record(result)?.details);
    const delivery = record(details?.messageDelivery);
    if (
      !isMain(caller) ||
      params.action !== "send" ||
      params.channel !== channel ||
      params.target !== target ||
      (accountId !== undefined && params.accountId !== accountId) ||
      params.dryRun === true ||
      record(result)?.isError === true ||
      delivery?.status !== "settled" ||
      delivery.partialDelivery !== false ||
      typeof delivery.primaryPlatformMessageId !== "string" ||
      !delivery.primaryPlatformMessageId.trim()
    ) {
      return undefined;
    }
    return {
      ...caller,
      kind: "owner_text",
      messageId: delivery.primaryPlatformMessageId,
      toolCallId,
      completedAtMs,
    };
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
      toolCallId: string,
      assertCurrent: () => void,
    ) {
      if (!caller || !isMain(caller)) {
        throw new Error("Only Main can reconcile its completion text.");
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
      let params: Record<string, unknown> | undefined;
      let prepared = false;
      for (const value of messages) {
        const message = record(value);
        const preparation = record(record(message?.details)?.topic);
        if (
          message?.role === "toolResult" &&
          message.toolName === "research_topics" &&
          message.isError !== true &&
          preparation?.id === topic.id &&
          preparation.completionId === topic.completionId &&
          preparation.revision === topic.revision &&
          preparation.ownerText === topic.ownerText
        ) {
          prepared = true;
        }
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          for (const content of message.content) {
            const call = record(content);
            if (call?.type === "toolCall" && call.name === "message" && call.id === toolCallId) {
              params = prepared ? record(call.arguments) : undefined;
            }
          }
        }
        if (
          params?.message === topic.ownerText &&
          message?.role === "toolResult" &&
          message.toolName === "message" &&
          message.toolCallId === toolCallId &&
          typeof message.timestamp === "number" &&
          message.timestamp >= (topic.completedAtMs ?? Infinity)
        ) {
          const verified = receipt(params, message, caller, toolCallId, message.timestamp);
          if (verified) {
            return verified;
          }
        }
      }
      throw new Error(
        "No matching successful native text receipt is available in Main's recent history. Keep completion pending; do not resend blindly.",
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
      const result = await api.runtime.subagent.run({
        sessionKey: main.sessionKey,
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
