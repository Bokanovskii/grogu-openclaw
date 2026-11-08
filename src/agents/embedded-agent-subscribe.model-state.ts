import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import {
  emitAgentEvent,
  emitAgentEventForRunContext,
  emitAgentRunOutputTokens,
} from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { AssistantMessage, Usage } from "../llm/types.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./embedded-agent-runner/usage-accumulator.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { isSubscribeTranscriptOnlyOpenClawAssistantMessage } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  hasObservedModelUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type NormalizedUsage,
} from "./usage.js";

function preserveAssistantUsage(message: AssistantMessage, pending: NormalizedUsage | undefined) {
  if (!pending) {
    return;
  }
  const final = normalizeUsage(message.usage);
  if (hasNonzeroUsage(final)) {
    if (
      pending.cost?.totalOrigin === "provider-billed" &&
      final.cost?.totalOrigin !== "provider-billed"
    ) {
      message.usage.cost = {
        ...makeZeroUsageSnapshot().cost,
        ...message.usage.cost,
        ...pending.cost,
      };
    }
    return;
  }

  // Only missing/zero final counters inherit this call's stream; provider totals win.
  const input = pending.input ?? 0;
  const output = pending.output ?? 0;
  const cacheRead = pending.cacheRead ?? 0;
  const cacheWrite = pending.cacheWrite ?? 0;
  message.usage = {
    ...makeZeroUsageSnapshot(),
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(pending.cacheWrite1h !== undefined ? { cacheWrite1h: pending.cacheWrite1h } : {}),
    ...(pending.contextUsage ? { contextUsage: { ...pending.contextUsage } } : {}),
    totalTokens: pending.total ?? input + output + cacheRead + cacheWrite,
    ...(pending.reasoningTokens !== undefined ? { reasoningTokens: pending.reasoningTokens } : {}),
  };
  Object.assign(message.usage.cost, pending.cost);
}

function readObservedOutputTokens(usage: NormalizedUsage | undefined): number | undefined {
  // Transport zeros and billed cost alone do not establish an output-token receipt.
  return usage?.output !== undefined &&
    (usage.output > 0 ||
      (usage.contextUsage?.state === "available" &&
        usage.contextUsage.totalTokens === usage.contextUsage.promptTokens))
    ? usage.output
    : undefined;
}

/** Owns model facts at event ingress, independently of queued reply delivery. */
export function createEmbeddedModelState(
  params: SubscribeEmbeddedAgentSessionParams,
  log: Parameters<typeof runBestEffortCallback>[0]["log"],
) {
  const totals = createUsageAccumulator();
  let pending: NormalizedUsage | undefined;
  let lastUsage: NormalizedUsage | undefined;
  let retryUsage: NormalizedUsage | undefined;
  let completed: AssistantMessage | undefined;
  let successfulModelResponse = false;
  let publishedMessageModel: string | undefined;
  let response: { id: symbol; chars: number } | undefined;
  const runContext = getAgentRunContext(params.runId);

  const publishMessageModel = (message: AssistantMessage, reset: boolean) => {
    if (reset) {
      publishedMessageModel = undefined;
    }
    const provider = message.provider?.trim();
    const model = message.responseModel?.trim() || message.model?.trim();
    const identity = provider && model ? `${provider}\0${model}` : undefined;
    if (!identity || identity === publishedMessageModel) {
      return;
    }
    const event = {
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      lifecycleGeneration: params.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "model", provider, model },
    } as const;
    if (runContext) {
      emitAgentEventForRunContext(event, runContext);
    } else {
      emitAgentEvent(event);
    }
    publishedMessageModel = identity;
  };

  const recordPendingUsage = (raw: Usage) => {
    const usage = normalizeUsage(raw);
    if (
      !usage ||
      (!hasObservedModelUsage(usage) && readObservedOutputTokens(usage) === undefined)
    ) {
      return;
    }
    const cost = usage.cost;
    const next = pending && !hasNonzeroUsage(usage) ? { ...pending, cost } : usage;
    // A provider-billed price remains authoritative over a later catalog estimate.
    if (
      pending?.cost?.totalOrigin === "provider-billed" &&
      cost?.totalOrigin !== "provider-billed"
    ) {
      next.cost = pending.cost;
    }
    pending = next;
  };

  const publishUsage = (
    outputTokens: number,
    update?: Parameters<typeof emitAgentRunOutputTokens>[0]["update"],
  ) => {
    if (!params.lifecycleGeneration) {
      return;
    }
    const data = emitAgentRunOutputTokens({
      runId: params.runId,
      lifecycleGeneration: params.lifecycleGeneration,
      outputTokens,
      update,
      runContext,
    });
    if (data && params.onAgentEvent) {
      runBestEffortCallback({
        label: "usage agent event",
        log,
        callback: () => params.onAgentEvent?.({ stream: "usage", data }),
      });
    }
  };
  const recordModelUsage = (usage: NormalizedUsage | undefined, responseId?: symbol) => {
    if (!usage) {
      return;
    }
    if (hasObservedModelUsage(usage)) {
      mergeUsageIntoAccumulator(totals, usage);
    }
    const outputTokens = readObservedOutputTokens(usage);
    if (outputTokens !== undefined && (outputTokens > 0 || responseId)) {
      publishUsage(outputTokens, responseId ? { type: "complete", responseId } : undefined);
    }
  };
  const recordContextAccounting = (message: AssistantMessage, successful: boolean) =>
    params.onContextAccountingEvent?.({
      kind: "model",
      contextTokens: deriveSessionTotalTokens({ lastCallUsage: normalizeUsage(message.usage) }),
      successful,
    });

  return {
    captureModelEvent: (evt: AgentSessionEvent): void => {
      if (evt.type === "turn_start") {
        response = undefined;
        return;
      }
      if (evt.type === "compaction_end") {
        if (evt.outcome.status === "completed" && evt.outcome.willRetry) {
          // Retain the prior call only until the retry completes or reports its own usage.
          completed = undefined;
          retryUsage = lastUsage ?? retryUsage;
          lastUsage = undefined;
          response = undefined;
        }
        return;
      }
      if (
        evt.type !== "message_start" &&
        evt.type !== "message_update" &&
        evt.type !== "message_end" &&
        evt.type !== "turn_end"
      ) {
        return;
      }
      const message = evt.message;
      if (
        message.role !== "assistant" ||
        isSubscribeTranscriptOnlyOpenClawAssistantMessage(message)
      ) {
        return;
      }
      publishMessageModel(message, evt.type === "message_start");
      switch (evt.type) {
        case "turn_end":
          response = undefined;
          // message_end may describe an async tool fragment, not a completed provider response.
          if (
            !successfulModelResponse &&
            (message.stopReason === "stop" || message.stopReason === "toolUse") &&
            !isProviderRefusalAssistantError(message)
          ) {
            successfulModelResponse = true;
            recordContextAccounting(message, true);
          }
          return;
        case "message_start":
          pending = undefined;
          response ??= { id: Symbol("provider-response"), chars: 0 };
          return;
        case "message_update":
          if (
            evt.assistantMessageEvent.type === "thinking_delta" ||
            evt.assistantMessageEvent.type === "text_delta" ||
            evt.assistantMessageEvent.type === "toolcall_delta"
          ) {
            const delta = evt.assistantMessageEvent.delta;
            if (delta) {
              response ??= { id: Symbol("provider-response"), chars: 0 };
              response.chars += estimateStringChars(delta);
              publishUsage(0, {
                type: "estimate",
                responseId: response.id,
                outputTokens: estimateTokensFromChars(response.chars),
              });
            }
          }
          // Capture the prepared message; core consumes done/error before message_end.
          if (evt.assistantMessageEvent.type === "text_end") {
            recordPendingUsage(message.usage);
          }
          return;
        case "message_end":
          recordPendingUsage(message.usage);
          preserveAssistantUsage(message, pending);
          if (hasNonzeroUsage(pending)) {
            lastUsage = { ...pending };
          }
          recordModelUsage(pending, response && response.chars > 0 ? response.id : undefined);
          if (hasObservedModelUsage(pending) || message.stopReason !== "toolUse") {
            response = undefined;
          }
          runBestEffortCallback({
            label: "model usage observation",
            log,
            callback: () => params.onModelUsage?.(pending),
          });
          pending = undefined;
          // Context-engine projection can later mutate transcript objects; retain this run's result.
          completed = applyAssistantDeliveryDirectives(structuredClone(message));
          lastUsage ??= message.stopReason === "error" ? retryUsage : undefined;
          retryUsage = undefined;
          recordContextAccounting(message, false);
      }
    },
    recordAuxiliaryUsage: (usage: Usage) => recordModelUsage(normalizeUsage(usage)),
    getUsageTotals: () => toNormalizedUsage(totals),
    getLastAssistantUsage: () => normalizeUsage(lastUsage),
    getCurrentAttemptAssistant: () => (completed ? structuredClone(completed) : undefined),
    hasSuccessfulModelResponse: () => successfulModelResponse,
  };
}
