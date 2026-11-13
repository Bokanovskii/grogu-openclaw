import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Drafts are transient presentation, not an alternative widget document store.
export const WIDGET_DRAFT_MAX_CHARS = 256 * 1024;
export const WIDGET_DRAFT_TITLE_MAX_CHARS = 200;

export type WidgetDraftUnavailable = "limit" | "gap" | "unsupported" | "invalid";
export type WidgetDraftProgress = {
  receivedChars: number;
  title?: string;
  unavailable?: WidgetDraftUnavailable;
  offset?: number;
  html?: string;
};

/** Reconnect and non-UI consumers retain facts only, never partial markup. */
export function readWidgetDraftMetadata(value: unknown): WidgetDraftProgress | undefined {
  const record = asOptionalObjectRecord(value);
  if (
    !record ||
    typeof record.receivedChars !== "number" ||
    !Number.isSafeInteger(record.receivedChars) ||
    record.receivedChars < 0
  ) {
    return undefined;
  }
  const unavailable = record.unavailable;
  return {
    receivedChars: record.receivedChars,
    ...(typeof record.title === "string"
      ? { title: truncateUtf16Safe(record.title, WIDGET_DRAFT_TITLE_MAX_CHARS) }
      : {}),
    ...(unavailable === "limit" ||
    unavailable === "gap" ||
    unavailable === "unsupported" ||
    unavailable === "invalid"
      ? { unavailable }
      : {}),
  };
}
