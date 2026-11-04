const FORMAT = "grogu-digest/v1";
const HEADER = `GROGU_CONTEXT_DIGEST\nformat=${FORMAT}\n`;
const MAX_BYTES = 12 * 1024;
const MAX_ENTRY_BYTES = 1_200;
const MAX_LEGACY_BYTES = 3_000;
const TRUNCATION_MARKER = "…[truncated]";

const encoder = new TextEncoder();

function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value, maxBytes, marker = TRUNCATION_MARKER) {
  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }
  const markerBytes = utf8Bytes(marker);
  if (markerBytes >= maxBytes) {
    let markerOnly = "";
    for (const char of marker) {
      if (utf8Bytes(markerOnly + char) > maxBytes) {
        break;
      }
      markerOnly += char;
    }
    return markerOnly;
  }
  let output = "";
  for (const char of value) {
    if (utf8Bytes(output + char) + markerBytes > maxBytes) {
      break;
    }
    output += char;
  }
  return output + marker;
}

function cleanText(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function contentText(content) {
  if (typeof content === "string") {
    return cleanText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    if (["text", "input_text", "output_text"].includes(type) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return cleanText(parts.join("\n"));
}

function toolFacts(message, tools) {
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    if (!["tool_use", "toolCall", "tool_call", "function_call"].includes(type)) {
      continue;
    }
    const name =
      typeof item.name === "string"
        ? item.name
        : typeof item.function?.name === "string"
          ? item.function.name
          : "unknown";
    noteTool(tools, name, "called");
  }
  if (message?.role !== "tool" && message?.role !== "toolResult") {
    return;
  }
  const name =
    typeof message.name === "string"
      ? message.name
      : typeof message.toolName === "string"
        ? message.toolName
        : "unknown";
  const outcome =
    message.isError === true || message.error
      ? "error"
      : message.isError === false
        ? "ok"
        : "unknown";
  noteTool(tools, name, outcome);
}

function noteTool(tools, name, outcome) {
  const normalized = cleanText(name).slice(0, 80) || "unknown";
  const current = tools.get(normalized) ?? { called: 0, ok: 0, error: 0, unknown: 0 };
  current[outcome] += 1;
  tools.set(normalized, current);
}

function timelineEntry(message) {
  const role = message?.role;
  const text = contentText(message?.content);
  if (!text) {
    return null;
  }
  if (role === "user") {
    return { role: "owner", text: truncateUtf8(text, MAX_ENTRY_BYTES) };
  }
  if (role !== "assistant") {
    return null;
  }
  const hasToolCall =
    Array.isArray(message.content) &&
    message.content.some(
      (item) =>
        item &&
        typeof item === "object" &&
        ["tool_use", "toolCall", "tool_call", "function_call"].includes(item.type),
    );
  return hasToolCall ? null : { role: "assistant", text: truncateUtf8(text, MAX_ENTRY_BYTES) };
}

function parsePreviousTimeline(summary) {
  if (!summary?.startsWith(HEADER)) {
    return null;
  }
  const entries = [];
  let inTimeline = false;
  for (const line of summary.split("\n")) {
    if (line === "timeline:") {
      inTimeline = true;
      continue;
    }
    if (inTimeline && line.endsWith(":") && line !== "timeline:") {
      break;
    }
    if (!inTimeline || !line.startsWith("@timeline ")) {
      continue;
    }
    try {
      const entry = JSON.parse(line.slice("@timeline ".length));
      if (
        entry &&
        (entry.role === "owner" || entry.role === "assistant") &&
        typeof entry.text === "string"
      ) {
        entries.push({
          role: entry.role,
          text: truncateUtf8(cleanText(entry.text), MAX_ENTRY_BYTES),
        });
      }
    } catch {
      return null;
    }
  }
  return entries;
}

function toolSection(tools) {
  if (tools.size === 0) {
    return "tools:\n- none\n";
  }
  const lines = [...tools.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, counts]) =>
        `- ${JSON.stringify(name)} called=${counts.called} ok=${counts.ok} error=${counts.error} unknown=${counts.unknown}`,
    );
  return `tools:\n${lines.join("\n")}\n`;
}

function renderDigest({ entries, tools, legacySummary }) {
  const toolsText = toolSection(tools);
  const legacyText = legacySummary
    ? `legacy-summary:\n${truncateUtf8(cleanText(legacySummary), MAX_LEGACY_BYTES)}\n`
    : "";
  const fixedText = `${HEADER}timeline:\n${toolsText}${legacyText}`;
  const selected = [];
  let usedBytes = utf8Bytes(fixedText);
  let omitted = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = `@timeline ${JSON.stringify(entries[index])}\n`;
    const lineBytes = utf8Bytes(line);
    if (usedBytes + lineBytes > MAX_BYTES) {
      omitted += 1;
      continue;
    }
    selected.push(line);
    usedBytes += lineBytes;
  }
  selected.reverse();
  const omittedText = omitted > 0 ? `timeline-omitted=${omitted}\n` : "";
  let result = `${HEADER}timeline:\n${selected.join("")}${omittedText}${toolsText}${legacyText}`;
  if (utf8Bytes(result) > MAX_BYTES) {
    result = truncateUtf8(result, MAX_BYTES);
  }
  return result;
}

export async function summarizeGroguDigest({ messages, previousSummary, signal }) {
  signal?.throwIfAborted();
  const tools = new Map();
  const currentEntries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    signal?.throwIfAborted();
    toolFacts(message, tools);
    const entry = timelineEntry(message);
    if (entry) {
      currentEntries.push(entry);
    }
  }
  const previousEntries = parsePreviousTimeline(previousSummary);
  return renderDigest({
    entries: [...(previousEntries ?? []), ...currentEntries],
    tools,
    legacySummary: previousEntries === null ? previousSummary : undefined,
  });
}

export const groguDigestFormat = Object.freeze({
  format: FORMAT,
  maxBytes: MAX_BYTES,
});
