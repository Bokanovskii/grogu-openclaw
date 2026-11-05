import { compareChatQueueOrder, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { requestChatAbort } from "./chat-abort-request.ts";
import { setChatError } from "./chat-history-state.ts";
import { getChatPendingInputs, markRecalledPendingInput } from "./chat-pending-inputs.ts";
import { readChatQueueForScope, removeQueuedMessage } from "./chat-queue.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";

function isRecallableLocalItem(item: ChatQueueItem): boolean {
  return (
    isMovableChatQueueItem(item) &&
    !item.localCommandName &&
    !item.attachmentStorageError &&
    !item.attachments?.some((attachment) => !getChatAttachmentDataUrl(attachment))
  );
}

function isWithdrawableSteer(item: ChatQueueItem): boolean {
  return (
    item.queueMode === "steer" &&
    Boolean(item.sendRunId) &&
    item.sendState !== "failed" &&
    item.sendState !== "held" &&
    item.sendState !== "unconfirmed" &&
    item.sendState !== "waiting-reconnect"
  );
}

type SteerWithdrawal = {
  runId: string;
  text: string;
  mentions?: ChatQueueItem["mentions"];
  sessionKey?: string;
  agentId?: string;
};

// A dispatched steer owns its own chat.send run; aborting that exact run withdraws it
// from the agent's steering queue unless the model already consumed it.
function withdrawDispatchedSteer(
  host: ChatPageHost,
  item: SteerWithdrawal,
  invalidate: () => void,
) {
  const client = host.client;
  if (!client || !host.connected) {
    return false;
  }
  const sessionKey = host.sessionKey;
  void requestChatAbort(client, {
    sessionKey: item.sessionKey ?? sessionKey,
    ...(item.agentId ? { agentId: item.agentId } : {}),
    runId: item.runId,
  }).then((result) => {
    if (!result.ok) {
      setChatError(host, formatUiError(result.error));
    } else if (!result.noActiveRun && host.sessionKey === sessionKey && !host.chatMessage.trim()) {
      markRecalledPendingInput(host, item.runId);
      host.handleChatDraftChange(item.text, item.mentions ? [...item.mentions] : []);
    }
    invalidate();
  });
  return true;
}

function newestServerQueuedText(host: ChatPageHost): {
  id: string;
  runId: string;
  steer: boolean;
  text: string;
  sessionKey: string;
  agentId?: string;
} | null {
  const view = getChatPendingInputs(host);
  const input = (view?.queuedInputs ?? [])
    .filter((item) => item.state === "queued" && item.runId)
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
    .at(-1);
  if (!view || !input?.runId) {
    return null;
  }
  // Server-held attachments cannot be rebuilt in the composer; leave those rows in place.
  const hasMedia = normalizeMessage(input.message).content.some(
    (part) =>
      part.type === "image" || part.type === "attachment" || part.type === "attachment_error",
  );
  const text = extractText(input.message) ?? "";
  return hasMedia || !text.trim()
    ? null
    : {
        id: `pending-input:${input.id}`,
        runId: input.runId,
        // Unflagged accepted input is an awaiting steer rather than a queued follow-up.
        steer: !input.queued,
        text,
        sessionKey: view.sessionKey,
        ...(view.agentId ? { agentId: view.agentId } : {}),
      };
}

/**
 * ArrowUp in an empty composer pulls the newest withdrawable queued message back
 * into the draft. Dispatched steers are withdrawn from the server first.
 */
export function recallNewestQueuedMessage(
  host: ChatPageHost,
  input: ChatInputHistoryKeyInput,
  cancelServerQueued: (id: string) => boolean,
  invalidate: () => void,
): ChatInputHistoryKeyResult | null {
  if (
    input.key !== "ArrowUp" ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    input.shiftKey ||
    input.isComposing ||
    input.keyCode === 229 ||
    host.chatMessage.trim() ||
    host.chatAttachments.length > 0 ||
    host.chatInputHistoryIndex !== -1 ||
    activeQueuedMessageEdit(host)
  ) {
    return null;
  }
  const recalled = { handled: true, preventDefault: true, restoreCaret: "down" as const };
  const local = readChatQueueForScope(host, host.sessionKey)
    .toSorted(compareChatQueueOrder)
    .findLast((item) => isRecallableLocalItem(item) || isWithdrawableSteer(item));
  if (local?.sendRunId && isWithdrawableSteer(local)) {
    const steer = { ...local, runId: local.sendRunId };
    return withdrawDispatchedSteer(host, steer, invalidate)
      ? { handled: true, preventDefault: true, restoreCaret: null }
      : null;
  }
  if (local) {
    // Composer ownership first, so removal does not release the attachment payloads.
    host.chatAttachments = [...(local.attachments ?? [])];
    if (removeQueuedMessage(host, local.id, { discard: true }) !== "removed") {
      host.chatAttachments = [];
      return null;
    }
    host.chatMessage = local.text;
    host.chatMentions = local.mentions ? [...local.mentions] : [];
    return recalled;
  }
  const server = newestServerQueuedText(host);
  if (server?.steer) {
    return withdrawDispatchedSteer(host, server, invalidate)
      ? { handled: true, preventDefault: true, restoreCaret: null }
      : null;
  }
  if (!server || !cancelServerQueued(server.id)) {
    return null;
  }
  host.chatMessage = server.text;
  host.chatMentions = [];
  return recalled;
}
