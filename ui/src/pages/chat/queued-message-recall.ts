import { compareChatQueueOrder, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
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

function newestServerQueuedText(host: ChatPageHost): { id: string; text: string } | null {
  const input = (getChatPendingInputs(host)?.queuedInputs ?? [])
    .filter((item) => item.queued && item.state === "queued" && item.runId)
    .toSorted((left, right) => left.acceptedAt - right.acceptedAt)
    .at(-1);
  if (!input) {
    return null;
  }
  // Server-held attachments cannot be rebuilt in the composer; leave those rows in place.
  const hasMedia = normalizeMessage(input.message).content.some(
    (part) =>
      part.type === "image" || part.type === "attachment" || part.type === "attachment_error",
  );
  const text = extractText(input.message) ?? "";
  return hasMedia || !text.trim() ? null : { id: `pending-input:${input.id}`, text };
}

/**
 * ArrowUp in an empty composer pulls the newest withdrawable queued message back
 * into the draft. Dispatched steers have left the browser's custody and stay put.
 */
export function recallNewestQueuedMessage(
  host: ChatPageHost,
  input: ChatInputHistoryKeyInput,
  cancelServerQueued: (id: string) => boolean,
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
    .findLast(isRecallableLocalItem);
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
  if (!server || !cancelServerQueued(server.id)) {
    return null;
  }
  host.chatMessage = server.text;
  host.chatMentions = [];
  return recalled;
}
