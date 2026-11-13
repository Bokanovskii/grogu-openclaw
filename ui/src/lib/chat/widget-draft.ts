import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readWidgetDraftMetadata,
  WIDGET_DRAFT_MAX_CHARS,
  type WidgetDraftUnavailable,
} from "../../../../src/shared/widget-draft.js";

export type WidgetDraft = {
  title?: string;
  receivedChars: number;
  html: string;
  unavailable?: WidgetDraftUnavailable;
  status: "building" | "failed" | "stopped";
  startedAt: number;
  error?: string;
};

export function updateWidgetDraft(
  previous: WidgetDraft | undefined,
  value: unknown,
  startedAt: number,
): WidgetDraft | undefined {
  const metadata = readWidgetDraftMetadata(value);
  const record = asOptionalObjectRecord(value);
  if (!metadata || !record || (previous && previous.status !== "building")) {
    return previous;
  }
  const html = previous?.html ?? "";
  const unavailable =
    previous?.unavailable ??
    metadata.unavailable ??
    (typeof record.html !== "string" || record.offset !== html.length
      ? "gap"
      : html.length + record.html.length > WIDGET_DRAFT_MAX_CHARS
        ? "limit"
        : undefined);
  return {
    title: metadata.title ?? previous?.title,
    receivedChars: metadata.receivedChars,
    html: unavailable ? "" : html + String(record.html),
    unavailable,
    status: "building",
    startedAt: previous?.startedAt ?? startedAt,
  };
}

export function readMessageWidgetDraft(message: unknown): WidgetDraft | undefined {
  const record = asOptionalObjectRecord(message);
  if (record?.["__openclawToolStreamLive"] !== true) {
    return undefined;
  }
  const draft = asOptionalObjectRecord(record["__openclawWidgetDraft"]);
  const metadata = readWidgetDraftMetadata(draft);
  if (
    !metadata ||
    !draft ||
    typeof draft.html !== "string" ||
    draft.html.length > WIDGET_DRAFT_MAX_CHARS ||
    typeof draft.startedAt !== "number" ||
    (draft.status !== "building" && draft.status !== "failed" && draft.status !== "stopped")
  ) {
    return undefined;
  }
  return {
    ...metadata,
    html: draft.html,
    startedAt: draft.startedAt,
    status: draft.status,
    ...(typeof draft.error === "string" ? { error: draft.error.slice(0, 200) } : {}),
  };
}
