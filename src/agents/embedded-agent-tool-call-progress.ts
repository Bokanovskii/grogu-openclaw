import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export function readToolCallBlock(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const contentIndex = event.contentIndex;
  const partial = asOptionalObjectRecord(event.partial);
  if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) {
    return undefined;
  }
  return asOptionalObjectRecord(
    Array.isArray(partial?.content) ? partial.content[contentIndex] : undefined,
  );
}

export function readToolCallId(event: Record<string, unknown>): string | undefined {
  const toolCall = asOptionalObjectRecord(event.toolCall);
  if (typeof toolCall?.id === "string" && toolCall.id) {
    return toolCall.id;
  }
  const block = readToolCallBlock(event);
  return typeof block?.id === "string" && block.id ? block.id : undefined;
}
