import type { SessionTranscriptOwnership } from "../sessions/session-lifecycle-identity.js";
import { getAgentRunRegistryState } from "./agent-run-registry-state.js";
import { hasAgentRunContextExecutionOwner } from "./agent-run-registry.js";

/** Held physical work, independent of display visibility or projection flags. */
export function readAgentRunTranscriptOwnership(): readonly SessionTranscriptOwnership[] {
  const result: SessionTranscriptOwnership[] = [];
  for (const [runId, context] of getAgentRunRegistryState().contexts) {
    if (!hasAgentRunContextExecutionOwner(runId)) {
      continue;
    }
    result.push({
      ownerId: runId,
      agentId: context.agentId,
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      state: !context.storePath
        ? "unknown"
        : context.sessionKey && context.sessionId
          ? "bound"
          : "pending",
    });
  }
  return result;
}
