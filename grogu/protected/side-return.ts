// Policy for "Send to main chat": how chosen side-chat replies become one parent message.
// The route schema owns the reply count and note length; this module owns the text size.
export const sideReturnTextLimit = 12_000;
export const sideReturnTruncationMarker = "\n\n[Shortened. The full reply is in the side chat.]";

function truncate(text: string, limit: number) {
  if (text.length <= limit) {
    return text;
  }
  // Never cut inside a surrogate pair.
  const high = text.charCodeAt(limit - 1);
  const end = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end).trimEnd()}${sideReturnTruncationMarker}`;
}

/**
 * The member's note comes first; the copied replies follow in transcript order.
 * Widget-only replies still leave a line of text so the parent model sees what was sent.
 */
export function composeSideReturnText(
  replies: readonly string[],
  note: string | undefined,
  widgetTitles: readonly string[],
) {
  const copied = replies
    .map((reply) => reply.trim())
    .filter(Boolean)
    .join("\n\n");
  const body =
    copied || !widgetTitles.length ? copied : `Shared from a side chat: ${widgetTitles.join(", ")}`;
  return [note?.trim(), truncate(body, sideReturnTextLimit)].filter(Boolean).join("\n\n");
}
