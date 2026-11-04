import { createHash } from "node:crypto";
import { z } from "zod";

export const WORKER_TRIGGER_CONTRACT_VERSION = 1;
const MAX_TOOL_ARGS_BYTES = 4 * 1024;
const MAX_CONTINUATIONS = 8;
const MAX_CONTINUATION_FIRES = 3;
const MAX_TTL_MS = 24 * 60 * 60_000;

const templateIdSchema = z.enum(["gmail-metadata-v1", "messages-metadata-v1"]);
export function isEffectiveWorkerSchemaPin(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) && new Set(value).size >= 4;
}
const schemaSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .refine(isEffectiveWorkerSchemaPin, "schema hash must come from an effective probe");
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
    schemaSha256: schemaSha256Schema,
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
    if (
      new Set(value.toolsAllow).size !== value.toolsAllow.length ||
      !value.toolsAllow.includes(expected.raw) ||
      value.toolsAllow.some(
        (tool) => tool.includes("*") || ["exec", "message"].includes(tool.toLowerCase()),
      )
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
        (value.args.include_recipients !== undefined && value.args.include_recipients !== false) ||
        value.args.sanitize_content !== true ||
        value.maxItems !== value.args.max ||
        keys.some(
          (key) =>
            ![
              "headers",
              "include_body",
              "include_recipients",
              "max",
              "query",
              "sanitize_content",
            ].includes(key),
        ))
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
const parsedRecord = (value) => {
  if (record(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
};
const textContentRecord = (envelope) => {
  if (!Array.isArray(envelope?.content) || envelope.content.length !== 1) return null;
  const block = record(envelope.content[0]);
  return block?.type === "text" ? parsedRecord(block.text) : null;
};
const failure = (kind) => ({ error: { kind } });
const normalizeFailureKind = (value) => {
  const kind = record(value) && typeof value.kind === "string" ? value.kind : "";
  if (["transient", "timeout", "network", "incomplete", "unavailable"].includes(kind)) return "transient";
  if (["auth", "permission", "config", "schema"].includes(kind)) return kind;
  const code = record(value) && typeof value.code === "string" ? value.code.toUpperCase() : "";
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"].includes(code)) return "transient";
  const name = record(value) && typeof value.name === "string" ? value.name : "";
  if (["AbortError", "TimeoutError"].includes(name)) return "transient";
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
  const continuationCandidates = entries.flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.id !== "string" || !item.id || !["gmail", "messages"].includes(item.source)) return [];
    if (!Number.isSafeInteger(item.fires) || item.fires < 0 || item.fires >= template.continuation.maxFires) return [];
    if (!Number.isFinite(item.dueAt) || !Number.isFinite(item.expiresAt) || item.expiresAt <= nowMs) return [];
    return [{ id: item.id, source: item.source, dueAt: Math.max(nowMs, item.dueAt), expiresAt: Math.min(item.expiresAt, nowMs + maxTtlMs), fires: item.fires }];
  }).sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id) || b.fires - a.fires || a.dueAt - b.dueAt || a.expiresAt - b.expiresAt);
  const continuationKeys = new Set();
  const continuations = continuationCandidates
    .filter((entry) => {
      const key = entry.source + ":" + entry.id;
      if (continuationKeys.has(key)) return false;
      continuationKeys.add(key);
      return true;
    })
    .sort((a, b) => a.dueAt - b.dueAt || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
    .slice(0, template.continuation.maxOpen);
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
  const stdout = parsedRecord(value.stdout);
  if (envelope.isError === true) {
    return failure(normalizeFailureKind(stdout?.error ?? value.error ?? envelope.error));
  }
  if (value.tool !== "gmail_search" || value.risk !== "read") return failure("schema");
  if (value.exit_code !== 0) return failure(normalizeFailureKind(stdout?.error ?? value.error));
  if (!stdout || !Array.isArray(stdout.messages) || stdout.messages.length > maxItems) return failure("schema");
  if (!Number.isSafeInteger(stdout.count) || stdout.count < 0 || stdout.count !== stdout.messages.length || typeof stdout.has_more !== "boolean") return failure("schema");
  const truncated = stdout.has_more || (stdout.nextPageToken != null && stdout.nextPageToken !== "");
  try {
    const items = canonicalize(stdout.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: nonempty(item.id, "gmail." + index + ".id"),
        threadId: optional(item.threadId, "gmail." + index + ".thread"),
        timestamp: timestamp(item.internalDateIso ?? item.date, "gmail." + index + ".timestamp"),
      };
    }), (item) => String(item.id));
    return {
      items,
      cursor: null,
      coverage: {
        kind: "bounded_head",
        limit: maxItems,
        truncated,
        empty: !truncated && items.length === 0,
      },
    };
  } catch {
    return failure("schema");
  }
};
const decodeMessages = (observation, maxItems) => {
  const envelope = record(observation);
  if (!envelope) return failure("schema");
  const value = textContentRecord(envelope);
  if (envelope.isError === true) return failure(normalizeFailureKind(value?.error ?? envelope.error));
  if (!value || value.error != null) return failure(normalizeFailureKind(value?.error));
  if (
    typeof value.source !== "string" ||
    !value.source.trim() ||
    !Number.isSafeInteger(value.since_ts) ||
    value.since_ts < 0 ||
    !Number.isSafeInteger(value.before_ts) ||
    value.before_ts < 0 ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.has_more !== "boolean" ||
    !Number.isSafeInteger(value.next_offset) ||
    value.next_offset < 0 ||
    !Array.isArray(value.messages) ||
    value.messages.length > value.limit ||
    value.messages.length > maxItems
  ) return failure("schema");
  if (value.has_more) return failure("incomplete");
  try {
    const items = canonicalize(value.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: nonempty(item.message_id, "messages." + index + ".id"),
        conversationId: nonempty(item.chat_id, "messages." + index + ".conversation"),
        timestamp: timestamp(item.ts, "messages." + index + ".timestamp"),
      };
    }), (item) => String(item.conversationId) + ":" + String(item.id));
    const cursor = { sinceTs: offset(value.since_ts, "messages.since_ts"), beforeTs: offset(value.before_ts, "messages.before_ts"), nextOffset: offset(value.next_offset, "messages.next_offset") };
    return {
      items,
      cursor,
      coverage: {
        kind: "bounded_recent_window",
        limit: value.limit,
        truncated: false,
        empty: items.length === 0,
      },
    };
  } catch {
    return failure("schema");
  }
};
const evaluate = (template, observation, previousState, nowMs) => {
  const state = normalizeState(previousState, nowMs, template);
  const source = template.templateId === "gmail-metadata-v1" ? "gmail" : "messages";
  const decoded = source === "gmail" ? decodeGmail(observation, template.maxItems) : decodeMessages(observation, template.maxItems);
  if (decoded.error) return decoded;
  const fingerprint = JSON.stringify({ items: decoded.items, coverage: decoded.coverage });
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
    message = JSON.stringify({ version: contractVersion, kind: "source_delta", source, cursor: decoded.cursor, coverage: decoded.coverage, items: decoded.items, uncertainty: decoded.coverage.truncated ? "older_matches_not_observed" : null, nativeSourceSweep: nativeSweepDue });
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
