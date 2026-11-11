import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateChatMessageGetParams } from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readSessionPendingInput } from "../../config/sessions/session-accessor.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { prepareForwardedMessageCronJobNameResolver } from "../chat-display-projection.history.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { projectOperatorModelRead } from "../operator-model-presentation.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { resolveSessionModelRef } from "../session-utils.js";
import { readChatHistoryMessageById } from "./chat-history-pages.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { projectPendingInputMessage } from "./chat-pending-inputs.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function handleChatMessageGetRequest({
  params,
  respond,
  context,
  client,
  sessionMutationAuthorization,
  signal,
  retainedTranscript,
}: GatewayRequestHandlerOptions & {
  retainedTranscript?: {
    sessionId: string;
    verifyRetainedState: () => Promise<boolean>;
  };
}) {
  if (!assertValidParams(params, validateChatMessageGetParams, "chat.message.get", respond)) {
    return;
  }
  const { sessionKey, messageId, maxChars } = params;
  const requestedSessionId = retainedTranscript?.sessionId ?? params.sessionId;
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const selection = await prepareChatHistorySessionRead({
    context,
    client,
    respond,
    sessionMutationAuthorization,
    signal,
    method: "chat.message.get",
    sessionKey,
    agentIdOverride,
    requestedSessionId,
    retainedSessionId: retainedTranscript?.sessionId,
  });
  if (!selection) {
    return;
  }
  try {
    const { selectedSession, entry, queries, readCurrentSharing, rowProjection } = selection;
    const { cfg, agentId: sessionAgentId, storePath, canonicalKey } = selectedSession;
    const sessionId = requestedSessionId ?? entry?.sessionId;
    const historyEntry =
      requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
    const withCurrentSession = <T>(consume: () => T) =>
      withReadySessionRows(rowProjection, queries, (read) => {
        signal?.throwIfAborted();
        return readCurrentSharing(read) ? consume() : undefined;
      });
    const publish = async (consume: () => void) => {
      const publishRetained = await withReadySessionRows(rowProjection, queries, (read) => {
        signal?.throwIfAborted();
        const sharing = readCurrentSharing(read);
        if (!sharing) {
          return undefined;
        }
        if (!retainedTranscript) {
          consume();
          return undefined;
        }
        return () =>
          selection.publishRetainedTranscript({
            verify: async () =>
              (await retainedTranscript.verifyRetainedState()) &&
              (await selection.readTranscriptOwner()),
            requireCurrentSession: false,
            sharing,
            publish: consume,
          });
      });
      await publishRetained?.();
    };
    const respondNotFound = () => respond(true, { ok: false, unavailableReason: "not_found" });
    const respondMessage = (message: unknown, applyModelPolicy = false) => {
      if (!message) {
        respond(true, { ok: false, unavailableReason: "not_visible" });
        return;
      }
      // maxChars bounds individual fields; structured content must also fit the transport.
      respond(
        true,
        jsonUtf8Bytes(message) > MAX_PAYLOAD_BYTES - 1024
          ? { ok: false, unavailableReason: "oversized" }
          : applyModelPolicy
            ? projectOperatorModelRead(
                { context, client, agentId: sessionAgentId },
                { ok: true, message },
              )
            : { ok: true, message },
      );
    };
    if (!sessionId) {
      await publish(respondNotFound);
      return;
    }
    const effectiveMaxChars = maxChars ?? Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    if (messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
      // Pending IDs have their own owner. A transcript miss must never widen
      // into pending custody or an archived physical session.
      if (retainedTranscript || sessionId !== entry?.sessionId) {
        await publish(respondNotFound);
        return;
      }
      const pending = await readSessionPendingInput(
        {
          agentId: sessionAgentId,
          sessionKey: canonicalKey,
          sessionId,
          storePath,
        },
        messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length),
      );
      if (!(await withCurrentSession(() => true))) {
        return;
      }
      if (!pending) {
        await publish(respondNotFound);
        return;
      }
      const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
        [pending.message],
        context.cronStorePath,
      );
      await publish(() => {
        const message = projectPendingInputMessage(
          pending,
          effectiveMaxChars,
          undefined,
          resolveCronJobName,
        );
        respondMessage(message);
      });
      return;
    }
    const resolved = await readChatHistoryMessageById({
      entry: historyEntry,
      provider: getCliSessionBinding(historyEntry, "claude-cli")?.sessionId
        ? resolveSessionModelRef(cfg, historyEntry, sessionAgentId, {
            allowPluginNormalization: false,
          }).provider
        : undefined,
      sessionAgentId,
      sessionId,
      canonicalKey,
      storePath,
      messageId,
      max: 1,
      maxHistoryBytes: MAX_PAYLOAD_BYTES,
      effectiveMaxChars,
      offset: undefined,
    });
    // Async transcript/archive reads cannot publish under a stale sharing or
    // physical-session snapshot.
    if (!(await withCurrentSession(() => true))) {
      return;
    }
    if (!resolved.found) {
      await publish(respondNotFound);
      return;
    }
    if (resolved.oversized) {
      await publish(() => respond(true, { ok: false, unavailableReason: "oversized" }));
      return;
    }
    const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
      [resolved.message],
      context.cronStorePath,
    );
    await publish(() => {
      const projectedMessage = resolved.message
        ? projectChatDisplayMessage(resolved.message, {
            includeCommentaryFallbacks: true,
            maxChars: effectiveMaxChars,
            resolveCurrentUserProfileDisplay,
            resolveCronJobName,
          })
        : undefined;
      const projected = projectedMessage
        ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
        : undefined;
      respondMessage(projected, true);
    });
  } finally {
    selection.release();
  }
}

export const chatMessageGetHandlers: GatewayRequestHandlers = {
  "chat.message.get": (opts) => handleChatMessageGetRequest(opts),
};
