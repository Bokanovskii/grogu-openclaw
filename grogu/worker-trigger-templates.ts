import { createHash } from "node:crypto";
import { z } from "zod";

export const WORKER_TRIGGER_CONTRACT_VERSION = 1;
const MAX_TOOL_ARGS_BYTES = 4 * 1024;
const MAX_CONTINUATIONS = 8;
const MAX_CONTINUATION_FIRES = 3;
const MAX_TTL_MS = 24 * 60 * 60_000;

const templateIdSchema = z.enum(["gmail-metadata-v1", "messages-metadata-v1"]);
export type WorkerTriggerTemplateId = z.infer<typeof templateIdSchema>;

function expectedCollectorTool(templateId: WorkerTriggerTemplateId) {
  return templateId === "gmail-metadata-v1"
    ? { raw: "gmail__gmail_search", callable: "MCP.gmail.gmailSearch" }
    : { raw: "seaglass__recent_messages", callable: "MCP.seaglass.recentMessages" };
}

export const workerTriggerTemplateSchema = z
  .object({
    version: z.literal(WORKER_TRIGGER_CONTRACT_VERSION),
    templateId: templateIdSchema,
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolsAllow: z.array(z.string().min(1)).min(1).max(32),
    args: z.record(z.string(), z.unknown()),
    maxItems: z.number().int().min(1).max(100).default(50),
    continuation: z
      .object({
        delayMs: z.number().int().min(60_000).max(MAX_TTL_MS),
        intervalMs: z.number().int().min(60_000).max(MAX_TTL_MS),
        nativeSweepIntervalMs: z.number().int().min(60_000).max(MAX_TTL_MS),
        maxOpen: z.number().int().min(1).max(MAX_CONTINUATIONS).default(MAX_CONTINUATIONS),
        maxFires: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTINUATION_FIRES)
          .default(MAX_CONTINUATION_FIRES),
        ttlMs: z.number().int().min(60_000).max(MAX_TTL_MS).default(MAX_TTL_MS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = expectedCollectorTool(value.templateId);
    const otherCollector =
      value.templateId === "gmail-metadata-v1"
        ? "seaglass__recent_messages"
        : "gmail__gmail_search";
    if (
      new Set(value.toolsAllow).size !== value.toolsAllow.length ||
      !value.toolsAllow.includes(expected.raw) ||
      value.toolsAllow.includes(otherCollector) ||
      value.toolsAllow.some((tool) => ["exec", "message"].includes(tool))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolsAllow"],
        message: "worker trigger toolsAllow must match the reviewed MCP collector policy",
      });
    }
    if (Buffer.byteLength(JSON.stringify(value.args), "utf8") > MAX_TOOL_ARGS_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: "worker trigger args exceed 4 KiB",
      });
    }
    const keys = Object.keys(value.args);
    if (
      value.templateId === "gmail-metadata-v1" &&
      (typeof value.args.query !== "string" ||
        !value.args.query.trim() ||
        typeof value.args.max !== "number" ||
        !Number.isSafeInteger(value.args.max) ||
        value.args.max < 1 ||
        value.args.max > 100 ||
        value.args.include_body !== false ||
        value.args.sanitize_content !== true ||
        value.maxItems !== value.args.max ||
        keys.some((key) => !["query", "max", "include_body", "sanitize_content"].includes(key)))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: "gmail template requires the reviewed metadata-only gmail_search arguments",
      });
    }
    if (
      value.templateId === "messages-metadata-v1" &&
      (value.args.include_text !== false ||
        (value.args.since_ts !== undefined &&
          (typeof value.args.since_ts !== "number" ||
            !Number.isSafeInteger(value.args.since_ts) ||
            value.args.since_ts < 0)) ||
        (value.args.before_ts !== undefined &&
          (typeof value.args.before_ts !== "number" ||
            !Number.isSafeInteger(value.args.before_ts) ||
            value.args.before_ts < 0)) ||
        (value.args.limit !== undefined &&
          (typeof value.args.limit !== "number" ||
            !Number.isSafeInteger(value.args.limit) ||
            value.args.limit < 1 ||
            value.args.limit > 100)) ||
        (value.args.offset !== undefined &&
          (typeof value.args.offset !== "number" ||
            !Number.isSafeInteger(value.args.offset) ||
            value.args.offset < 0)) ||
        (value.args.limit !== undefined && value.maxItems !== value.args.limit) ||
        keys.some(
          (key) => !["since_ts", "before_ts", "limit", "offset", "include_text"].includes(key),
        ))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: "messages template requires the reviewed metadata-only recent_messages arguments",
      });
    }
  });

export type WorkerTriggerTemplate = z.infer<typeof workerTriggerTemplateSchema>;

const PORTABLE_TRIGGER_RUNTIME = String.raw`
const contractVersion = 1;
const maxStateBytes = 16 * 1024;
const maxTtlMs = 24 * 60 * 60 * 1000;
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const nonempty = (value, label) => {
  if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value) && value !== 0)) return value;
  throw new Error("worker_source_malformed:" + label);
};
const timestamp = (value, label) => {
  const parsed = nonempty(value, label);
  if (typeof parsed === "number" && parsed < 0) throw new Error("worker_source_malformed:" + label);
  return parsed;
};
const optional = (value, label) => value == null ? null : nonempty(value, label);
const offset = (value, label) => {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("worker_source_malformed:" + label);
};
const failure = (kind) => ({ error: { kind } });
const normalizeFailureKind = (value) => {
  const kind = record(value) && typeof value.kind === "string" ? value.kind : "schema";
  if (["transient", "timeout", "network", "incomplete", "unavailable"].includes(kind)) return "transient";
  if (["auth", "permission", "config", "schema"].includes(kind)) return kind;
  return "schema";
};
const normalizeState = (value, nowMs, template) => {
  const loaded = record(value);
  const loadedSources = record(loaded?.sources) || {};
  const sources = {};
  for (const source of ["gmail", "messages"]) {
    const item = record(loadedSources[source]);
    if (item && typeof item.fingerprint === "string" && utf8Bytes(item.fingerprint) <= maxStateBytes / 2 && Number.isFinite(item.lastSuccessAt)) {
      sources[source] = { fingerprint: item.fingerprint, lastSuccessAt: item.lastSuccessAt };
    }
  }
  const entries = Array.isArray(loaded?.continuations) ? loaded.continuations : [];
  const continuations = entries.flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.id !== "string" || !item.id || !["gmail", "messages"].includes(item.source)) return [];
    if (!Number.isSafeInteger(item.fires) || item.fires < 0 || item.fires >= template.continuation.maxFires) return [];
    if (!Number.isFinite(item.dueAt) || !Number.isFinite(item.expiresAt) || item.expiresAt <= nowMs) return [];
    return [{ id: item.id, source: item.source, dueAt: Math.max(nowMs, item.dueAt), expiresAt: Math.min(item.expiresAt, nowMs + maxTtlMs), fires: item.fires }];
  }).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, template.continuation.maxOpen);
  const loadedSweep = loaded?.nextNativeSweepAt;
  const nextNativeSweepAt = Number.isFinite(loadedSweep) && loadedSweep >= 0
    ? Math.min(loadedSweep, nowMs + maxTtlMs)
    : nowMs + template.continuation.nativeSweepIntervalMs;
  return { version: contractVersion, sources, continuations, nextNativeSweepAt };
};
const canonicalize = (items, identity) => {
  const keyed = new Map();
  for (const item of items) {
    const key = identity(item);
    const prior = keyed.get(key);
    if (!prior || JSON.stringify(item).localeCompare(JSON.stringify(prior)) < 0) keyed.set(key, item);
  }
  return [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
};
const decodeGmail = (observation, maxItems) => {
  const envelope = record(observation);
  const value = record(envelope?.structuredContent);
  if (!envelope || !value) return failure("schema");
  if (envelope.isError === true) return failure(normalizeFailureKind(value.error ?? envelope.error));
  if (value.tool !== "gmail_search" || value.risk !== "read") return failure("schema");
  if (value.exit_code !== 0) return failure(normalizeFailureKind(value.error));
  if (!Array.isArray(value.messages) || value.messages.length > maxItems) return failure("schema");
  const hasMore = value.hasMore ?? value.has_more;
  const continuation = value.nextPageToken ?? value.next_page_token ?? value.nextCursor ?? value.next_cursor ?? value.continuation ?? value.cursor;
  if (hasMore === true || (continuation != null && continuation !== "") || (value.messages.length >= maxItems && hasMore !== false)) return failure("incomplete");
  try {
    const items = canonicalize(value.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: nonempty(item.message_id ?? item.id, "gmail." + index + ".id"),
        threadId: optional(item.thread_id ?? item.threadId, "gmail." + index + ".thread"),
        timestamp: timestamp(item.timestamp ?? item.internalDate, "gmail." + index + ".timestamp"),
        status: optional(item.status, "gmail." + index + ".status"),
      };
    }), (item) => String(item.id));
    return { items, cursor: optional(value.historyId ?? value.history_id, "gmail.history") };
  } catch {
    return failure("schema");
  }
};
const decodeMessages = (observation, maxItems) => {
  const envelope = record(observation);
  const value = record(envelope?.structuredContent) || envelope;
  if (!value) return failure("schema");
  if (envelope?.isError === true) return failure(normalizeFailureKind(value.error ?? envelope.error));
  if (value.error != null) return failure(normalizeFailureKind(value.error));
  if (!Array.isArray(value.messages) || value.messages.length > maxItems) return failure("schema");
  try {
    const items = canonicalize(value.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: nonempty(item.message_id ?? item.id ?? item.guid, "messages." + index + ".id"),
        conversationId: nonempty(item.chat_id ?? item.conversation_id, "messages." + index + ".conversation"),
        timestamp: timestamp(item.timestamp ?? item.date, "messages." + index + ".timestamp"),
      };
    }), (item) => String(item.conversationId) + ":" + String(item.id));
    const cursor = { sinceTs: timestamp(value.since_ts, "messages.since_ts"), beforeTs: timestamp(value.before_ts, "messages.before_ts"), nextOffset: value.next_offset == null ? null : offset(value.next_offset, "messages.next_offset") };
    return { items, cursor };
  } catch {
    return failure("schema");
  }
};
const evaluate = (template, observation, previousState, nowMs) => {
  const state = normalizeState(previousState, nowMs, template);
  const source = template.templateId === "gmail-metadata-v1" ? "gmail" : "messages";
  const decoded = source === "gmail" ? decodeGmail(observation, template.maxItems) : decodeMessages(observation, template.maxItems);
  if (decoded.error) return decoded;
  const fingerprint = JSON.stringify(decoded.items);
  if (utf8Bytes(fingerprint) > maxStateBytes / 2) return failure("schema");
  const prior = record(state.sources[source]);
  const baseline = !prior || typeof prior.fingerprint !== "string";
  const changed = !baseline && prior.fingerprint !== fingerprint;
  state.sources = { ...state.sources, [source]: { fingerprint, cursor: decoded.cursor, lastSuccessAt: nowMs } };
  if (changed) {
    const id = source + ":" + nowMs + ":" + fingerprint.length;
    state.continuations = [...state.continuations.filter((entry) => entry.id !== id), { id, source, dueAt: nowMs + template.continuation.delayMs, expiresAt: nowMs + template.continuation.ttlMs, fires: 0 }]
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, template.continuation.maxOpen);
  }
  const dueIndex = state.continuations.findIndex((entry) => entry.source === source && entry.dueAt <= nowMs);
  const nativeSweepDue = state.nextNativeSweepAt <= nowMs;
  let message;
  if (changed) {
    message = JSON.stringify({ version: contractVersion, kind: "source_delta", source, cursor: decoded.cursor, items: decoded.items, nativeSourceSweep: nativeSweepDue });
  } else if (dueIndex >= 0) {
    const due = state.continuations[dueIndex];
    const fires = due.fires + 1;
    if (fires >= template.continuation.maxFires) state.continuations.splice(dueIndex, 1);
    else state.continuations[dueIndex] = { ...due, fires, dueAt: nowMs + template.continuation.intervalMs };
    message = JSON.stringify({ version: contractVersion, kind: "continuation_due", source, checkpointId: due.id, attempt: fires, nativeSourceSweep: nativeSweepDue });
  } else if (nativeSweepDue) {
    message = JSON.stringify({ version: contractVersion, kind: "native_source_sweep" });
  }
  if (nativeSweepDue) state.nextNativeSweepAt = nowMs + template.continuation.nativeSweepIntervalMs;
  state.continuations = normalizeState(state, nowMs, template).continuations;
  if (utf8Bytes(JSON.stringify(state)) > maxStateBytes) return failure("schema");
  return message ? { fire: true, message, state } : { fire: false, state };
};`;

export function workerTriggerScriptSha256(script: string): string {
  return createHash("sha256").update(script).digest("hex");
}

export function renderWorkerTriggerScript(value: unknown): string {
  const template = workerTriggerTemplateSchema.parse(value);
  const callable = expectedCollectorTool(template.templateId).callable;
  return `const template = ${JSON.stringify(template)};
${PORTABLE_TRIGGER_RUNTIME}
let observation;
try {
  observation = await ${callable}(template.args);
} catch (error) {
  return failure(normalizeFailureKind(error));
}
return evaluate(template, observation, trigger.state, Date.now());`;
}

export function inspectRenderedWorkerTriggerScript(script: string): WorkerTriggerTemplate {
  const prefix = "const template = ";
  const end = script.indexOf(";\n");
  if (!script.startsWith(prefix) || end < prefix.length) {
    throw new Error("worker trigger script is not a tracked rendered template");
  }
  const template = workerTriggerTemplateSchema.parse(
    JSON.parse(script.slice(prefix.length, end)) as unknown,
  );
  if (renderWorkerTriggerScript(template) !== script) {
    throw new Error("worker trigger script does not match the tracked renderer");
  }
  return template;
}
