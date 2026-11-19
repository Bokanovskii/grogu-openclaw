import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type Source = { url: string; title: string };
export type Widget = { id: string; title: string };
export const widgetIdPattern = /^cv_[a-f0-9]{32}$/u;

function source(value: unknown): Source[] {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.length > 2048) {
    return [];
  }
  const parsed = URL.parse(value.url);
  if (
    !parsed ||
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    return [];
  }
  return [
    {
      url: parsed.href,
      title: typeof value.title === "string" ? value.title.slice(0, 256) : parsed.hostname,
    },
  ];
}

export function projectToolResult(name: unknown, details: unknown) {
  const empty: { sources: Source[]; widgets: Widget[] } = { sources: [], widgets: [] };
  if (!isRecord(details)) {
    return empty;
  }
  if (name === "web_search") {
    const records = details.results ?? details.citations;
    return {
      ...empty,
      sources: Array.isArray(records) ? records.slice(0, 20).flatMap(source) : [],
    };
  }
  if (name === "web_fetch" && !details.error && details.status !== "error") {
    return {
      ...empty,
      sources: source({ url: details.finalUrl ?? details.url, title: details.title }),
    };
  }
  if (
    name === "show_widget" &&
    details.kind === "canvas" &&
    isRecord(details.view) &&
    typeof details.view.id === "string" &&
    widgetIdPattern.test(details.view.id) &&
    isRecord(details.presentation) &&
    typeof details.presentation.title === "string"
  ) {
    return {
      ...empty,
      widgets: [{ id: details.view.id, title: details.presentation.title.slice(0, 256) }],
    };
  }
  return empty;
}
