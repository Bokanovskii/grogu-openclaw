import { inspectTlsCertificateError } from "@openclaw/ai/internal/shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { htmlToMarkdown, markdownToText, truncateWebFetchText } from "./web-fetch-utils.js";

export function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType } = params;
  if (!detail) {
    return "";
  }
  let text = detail;
  const contentTypeLower = normalizeOptionalLowercaseString(contentType);
  const head = normalizeLowercaseStringOrEmpty(detail.trimStart().slice(0, 256));
  if (
    contentTypeLower?.includes("text/html") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html")
  ) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  return truncateWebFetchText(text.trim(), params.maxChars).text;
}

export function createWebFetchConnectionError(error: unknown): Error {
  const certificate = inspectTlsCertificateError(error);
  return Object.assign(new Error("Web fetch connection failed.", { cause: error }), {
    code:
      certificate?.code ??
      (certificate ? "WEB_FETCH_TLS_CERTIFICATE" : "WEB_FETCH_TRANSPORT_FAILED"),
  });
}
