import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { chargeTranscriptWrite } from "../../agents/sessions/transcript-write-budget.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

export type AssistantBeforeMessageWrite = (params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

export function applyBeforeMessageWriteToAssistant(params: {
  message: Parameters<SessionManager["appendMessage"]>[0];
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  explicitIdempotencyKey?: string;
  agentId?: string;
  sessionKey: string;
  chargeWrite?: boolean;
}): Parameters<SessionManager["appendMessage"]>[0] | undefined {
  if (params.chargeWrite && !params.beforeMessageWrite) {
    // Quota-only preparation preserves the exact message already admitted by the caller.
    chargeTranscriptWrite(params.message);
    return params.message;
  }
  const nextMessage = params.beforeMessageWrite
    ? params.beforeMessageWrite({
        message: params.message as AgentMessage,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        sessionKey: params.sessionKey,
      })
    : params.message;
  if (nextMessage?.role !== "assistant") {
    return undefined;
  }
  const prepared = Object.assign(
    applyAssistantDeliveryDirectives(nextMessage),
    params.explicitIdempotencyKey ? { idempotencyKey: params.explicitIdempotencyKey } : {},
  ) as Parameters<SessionManager["appendMessage"]>[0];
  if (params.chargeWrite) {
    chargeTranscriptWrite(prepared);
  }
  return prepared;
}
