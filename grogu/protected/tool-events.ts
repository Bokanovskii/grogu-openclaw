import type { ProtectedActivity } from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type Source = { url: string; title: string };
export type Widget = { id: string; title: string; replaces?: string };
export const widgetIdPattern = /^cv_[a-f0-9]{32}$/u;

/**
 * Owns which widget supersedes which. The model does not name an artifact, so a widget replaces the
 * newest earlier widget in the same chat with the same title.
 */
export function createWidgetChain(earlier: Iterable<Pick<Widget, "id" | "title">> = []) {
  const latest = new Map<string, string>();
  for (const widget of earlier) {
    latest.set(widget.title, widget.id);
  }
  return (widget: Widget): Widget => {
    const replaces = latest.get(widget.title);
    latest.set(widget.title, widget.id);
    return replaces && replaces !== widget.id ? { ...widget, replaces } : widget;
  };
}

const toolLabels: Partial<Record<string, string>> = {
  sessions_list: "Looking through your chats",
  sessions_history: "Reading another chat",
  sessions_send: "Sending to another chat",
  route_to_agent: "Asking another agent",
};

export function projectActivity(
  name: unknown,
  id: unknown,
  status: ProtectedActivity["status"],
): ProtectedActivity | undefined {
  if (typeof id !== "string" || !id || id.length > 256 || typeof name !== "string") {
    return undefined;
  }
  const [kind, label] =
    name === "web_search"
      ? (["search", "Searching the web"] as const)
      : name === "web_fetch"
        ? (["fetch", "Fetching a source"] as const)
        : name === "show_widget"
          ? (["widget", "Creating a widget"] as const)
          : (["tool", toolLabels[name] ?? "Using a tool"] as const);
  return { id, kind, label, status };
}

// Web tools frame untrusted titles for the model; show members only the framed text.
const framedTitle =
  /^\n?<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: Web (?:Search|Fetch)\n---\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u;

function sourceTitle(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }
  const title = (framedTitle.exec(value)?.[2] ?? value).replace(/\s+/gu, " ").trim();
  return title.slice(0, 256) || fallback;
}

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
      title: sourceTitle(value.title, parsed.hostname),
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
