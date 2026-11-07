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
// Seaglass row ids are positive integer ROWIDs; the Messages identity key joins two of them with ":".
const rowId = (value, label) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error("worker_source_malformed:" + label);
};
const epochSeconds = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  const bridgeCode = record(value) && typeof value.code === "string" ? value.code.toLowerCase() : "";
  if (["invalid_input", "input_contract", "output_contract", "invalid_contract", "store_range", "store_type"].includes(bridgeCode)) return "schema";
  const transientCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"];
  if (transientCodes.includes(bridgeCode.toUpperCase())) return "transient";
  if (bridgeCode && !["tool_error", "internal_error"].includes(bridgeCode)) return "schema";
  const codeValue = record(value) ? value.nativeCode : undefined;
  const code = typeof codeValue === "string" ? codeValue.toUpperCase() : "";
  if (transientCodes.includes(code)) return "transient";
  const nameValue = record(value) ? value.nativeName ?? value.name : undefined;
  const name = typeof nameValue === "string" ? nameValue : "";
  if (["AbortError", "TimeoutError"].includes(name)) return "transient";
  return "schema";
};
// gog exit codes: 4 auth_required, 6 permission_denied, 7 rate_limited, 8 retryable, 10 config, 11 orphaned, 130 cancelled.
// A Map never matches a string or prototype key; every other code keeps the generic classification.
const gmailExitKinds = new Map([[4, "auth"], [6, "permission"], [7, "transient"], [8, "transient"], [10, "config"], [11, "transient"], [130, "transient"]]);
const gmailFailureKind = (exitCode, error) => gmailExitKinds.get(exitCode) ?? normalizeFailureKind(error);
const identities = {
  gmail: (item) => String(nonempty(item.id, "gmail.id")),
  messages: (item) => String(nonempty(item.conversationId, "messages.conversation")) + ":" + String(nonempty(item.id, "messages.id")),
};
// The identity keys a v2 writer can emit; a stored v2 prior holding anything else is corrupt.
const usableKeys = {
  gmail: (key) => typeof key === "string" && key.trim() !== "",
  messages: (key) => typeof key === "string" && /^[1-9][0-9]*:[1-9][0-9]*$/.test(key),
};
// The coverage kind each source writes, which a stored v2 prior of that source must carry.
const coverageKinds = { gmail: "bounded_head", messages: "bounded_recent_window" };
// Item timestamps in the unit of the stored floor (epoch ms for Gmail, epoch seconds for Messages); NaN when unreadable.
const stamps = {
  gmail: (item) => typeof item.timestamp === "string" ? Date.parse(item.timestamp) : NaN,
  messages: (item) => typeof item.timestamp === "number" ? item.timestamp : NaN,
};
const floorOf = (items, stamp) => {
  const times = items.map(stamp);
  return times.length > 0 && times.every(Number.isFinite) ? Math.min(...times) : null;
};
// A truncated page only proves the newest items when their timestamps are readable and ordered newest-first.
const headFailure = (rows, stamp) => {
  const times = rows.map(stamp);
  if (!times.every(Number.isFinite)) return failure("schema");
  return times.every((time, index) => index === 0 || time <= times[index - 1]) ? null : failure("incomplete");
};
// v1 (first deployed runtime) stored whole items; v2 stores only their identity keys and the truncated head's floor.
const priorHead = (fingerprint, source) => {
  try {
    const stored = record(JSON.parse(fingerprint));
    if (stored?.v === 2) {
      // Anything the writer cannot emit is corrupt state, which is rebaselined rather than compared against.
      const coverage = record(stored.coverage);
      const truncated = coverage?.truncated;
      const idsUsable = Array.isArray(stored.ids) && stored.ids.every(usableKeys[source]);
      const coverageUsable = coverage?.kind === coverageKinds[source] && typeof truncated === "boolean";
      const floorUsable = stored.floor === null || (truncated === true && Number.isFinite(stored.floor));
      if (!idsUsable || !coverageUsable || !floorUsable) return null;
      return { ids: new Set(stored.ids), floor: stored.floor };
    }
    if (!stored || stored.v !== undefined || !Array.isArray(stored.items)) return null;
    const truncated = record(stored.coverage)?.truncated === true;
    return { ids: new Set(stored.items.map((item) => identities[source](item))), floor: truncated ? floorOf(stored.items, stamps[source]) : null };
  } catch {
    return null;
  }
};
const maxGaps = 4;
// A gap is a stretch of a source a past evaluation could not page through within its tool budget:
// the head it must reach (target), where paging resumes (floor/cursor), and the boundary ids already read (edge).
const normalizeGaps = (value, source) => {
  if (!Array.isArray(value)) return [];
  const usable = usableKeys[source];
  return value.flatMap((entry) => {
    const gap = record(entry);
    const target = record(gap?.target);
    const cursor = gap?.cursor === null ? null : record(gap?.cursor);
    if (!gap || !target || !Array.isArray(target.ids) || !target.ids.every(usable) || !(target.floor === null || Number.isFinite(target.floor))) return [];
    if (!Array.isArray(gap.edge) || !gap.edge.every(usable) || !(gap.floor === null || Number.isFinite(gap.floor))) return [];
    if (source === "gmail" ? !Number.isFinite(gap.floor) : !cursor || !epochSeconds(cursor.sinceTs) || !epochSeconds(cursor.beforeTs) || !Number.isSafeInteger(cursor.nextOffset) || cursor.nextOffset < 0) return [];
    return [{ target: { ids: target.ids, floor: target.floor }, floor: gap.floor, cursor: cursor && { sinceTs: cursor.sinceTs, beforeTs: cursor.beforeTs, nextOffset: cursor.nextOffset }, edge: gap.edge }];
  }).slice(-maxGaps);
};
const normalizeState = (value, nowMs, template) => {
  const loaded = record(value);
  const loadedSources = record(loaded?.sources) || {};
  const sources = {};
  for (const source of ["gmail", "messages"]) {
    const item = record(loadedSources[source]);
    if (item && typeof item.fingerprint === "string" && utf8Bytes(item.fingerprint) <= maxStateBytes / 2 && Number.isFinite(item.lastSuccessAt) && priorHead(item.fingerprint, source)) {
      const gaps = normalizeGaps(item.gaps, source);
      sources[source] = { fingerprint: item.fingerprint, lastSuccessAt: item.lastSuccessAt, ...(gaps.length > 0 ? { gaps } : {}) };
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
    return failure(gmailFailureKind(value.exit_code, stdout?.error ?? value.error ?? envelope.error));
  }
  if (value.tool !== "gmail_search" || value.risk !== "read") return failure("schema");
  if (value.exit_code !== 0) return failure(gmailFailureKind(value.exit_code, stdout?.error ?? value.error));
  if (!stdout || !Array.isArray(stdout.messages) || stdout.messages.length > maxItems) return failure("schema");
  if (!Number.isSafeInteger(stdout.count) || stdout.count < 0 || stdout.count !== stdout.messages.length || typeof stdout.has_more !== "boolean") return failure("schema");
  const truncated = stdout.has_more || (stdout.nextPageToken != null && stdout.nextPageToken !== "");
  try {
    const rows = stdout.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: nonempty(item.id, "gmail." + index + ".id"),
        threadId: optional(item.threadId, "gmail." + index + ".thread"),
        timestamp: timestamp(item.internalDateIso ?? item.date, "gmail." + index + ".timestamp"),
      };
    });
    const unordered = truncated ? headFailure(rows, stamps.gmail) : null;
    if (unordered) return unordered;
    const items = canonicalize(rows, identities.gmail);
    return {
      rows,
      items,
      floor: truncated ? floorOf(rows, stamps.gmail) : null,
      cursor: null,
      coverage: {
        kind: coverageKinds.gmail,
        limit: maxItems,
        truncated,
        empty: !truncated && items.length === 0,
      },
    };
  } catch {
    return failure("schema");
  }
};
const decodeMessages = (observation, maxItems, paged = false) => {
  const envelope = record(observation);
  if (!envelope) return failure("schema");
  const value = textContentRecord(envelope);
  if (envelope.isError === true) return failure(normalizeFailureKind(value?.error ?? envelope.error));
  if (!value || value.error != null) return failure(normalizeFailureKind(value?.error));
  if (
    typeof value.source !== "string" ||
    !value.source.trim() ||
    !epochSeconds(value.since_ts) ||
    !epochSeconds(value.before_ts) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.has_more !== "boolean" ||
    // Seaglass reports a null next_offset when the window has no further page.
    (value.has_more ? !Number.isSafeInteger(value.next_offset) || value.next_offset < 0 : value.next_offset !== null && (!Number.isSafeInteger(value.next_offset) || value.next_offset < 0)) ||
    !Array.isArray(value.messages) ||
    value.messages.length > value.limit ||
    value.messages.length > maxItems
  ) return failure("schema");
  try {
    const rows = value.messages.map((raw, index) => {
      const item = record(raw);
      if (!item) throw new Error();
      return {
        id: rowId(item.message_id, "messages." + index + ".id"),
        conversationId: rowId(item.chat_id, "messages." + index + ".conversation"),
        timestamp: timestamp(item.ts, "messages." + index + ".timestamp"),
      };
    });
    // A truncated page only proves the newest messages when it starts at the head.
    if (value.has_more && value.offset !== 0 && !paged) return failure("incomplete");
    const unordered = value.has_more ? headFailure(rows, stamps.messages) : null;
    if (unordered) return unordered;
    const items = canonicalize(rows, identities.messages);
    return {
      rows,
      items,
      floor: value.has_more ? floorOf(rows, stamps.messages) : null,
      cursor: { sinceTs: value.since_ts, beforeTs: value.before_ts, nextOffset: value.next_offset },
      coverage: {
        kind: coverageKinds.messages,
        limit: value.limit,
        truncated: value.has_more,
        empty: !value.has_more && items.length === 0,
      },
    };
  } catch {
    return failure("schema");
  }
};
const maxOlderPages = 4;
// Arguments for the page just older than a truncated one: Messages keeps its window and advances
// the offset; Gmail has no page token, so it narrows the query to before the page's oldest second.
const olderPageArgs = (template, page) => {
  if (!page.coverage.truncated) return null;
  if (template.templateId === "gmail-metadata-v1") {
    return Number.isFinite(page.floor) ? { ...template.args, query: template.args.query + " before:" + (Math.floor(page.floor / 1000) + 1) } : null;
  }
  return Number.isSafeInteger(page.cursor?.nextOffset)
    ? { ...template.args, since_ts: page.cursor.sinceTs, before_ts: page.cursor.beforeTs, offset: page.cursor.nextOffset }
    : null;
};
// A row a scan toward a past head has reached: one that head held, or one older than its floor.
const belowTarget = (source, target, row) => target.ids.has(identities[source](row)) || (target.floor !== null && Number.isFinite(stamps[source](row)) && stamps[source](row) < target.floor);
// Pages older than the given page until reaching the target head, spending the evaluation's shared tool budget.
// Stops incomplete on a failed page (resumed next time) or stalled when paging cannot advance.
const scanOlder = async (source, page, target, seen, fetchOlderPage, budget) => {
  const identity = identities[source];
  const older = [];
  let reached = page.rows.some((row) => belowTarget(source, target, row));
  while (!reached && page.coverage.truncated && budget.left > 0) {
    budget.left -= 1;
    const next = await fetchOlderPage(page);
    if (!next) return { older, page, complete: false, stalled: true };
    if (next.error) return { older, page, complete: false, stalled: false };
    const unseen = next.rows.filter((row) => !seen.has(identity(row)));
    if (unseen.length === 0) return { older, page, complete: false, stalled: true };
    for (const row of unseen) seen.add(identity(row));
    older.push(...unseen);
    reached = unseen.some((row) => belowTarget(source, target, row));
    page = next;
  }
  return { older, page, complete: reached || !page.coverage.truncated, stalled: false };
};
// Gmail's before: cursor rereads the page's oldest second, so those ids are carried to skip next time.
const edgeIds = (source, page) => source !== "gmail" || !Number.isFinite(page.floor)
  ? []
  : page.rows.filter((row) => Math.floor(stamps.gmail(row) / 1000) === Math.floor(page.floor / 1000)).map((row) => identities.gmail(row));
const evaluate = async (template, observation, previousState, nowMs, fetchOlderPage) => {
  const state = normalizeState(previousState, nowMs, template);
  const source = template.templateId === "gmail-metadata-v1" ? "gmail" : "messages";
  const decoded = source === "gmail" ? decodeGmail(observation, template.maxItems) : decodeMessages(observation, template.maxItems);
  if (decoded.error) return decoded;
  const identity = identities[source];
  const fingerprint = JSON.stringify({ v: 2, ids: decoded.items.map((item) => identity(item)), coverage: decoded.coverage, floor: decoded.floor });
  if (utf8Bytes(fingerprint) > maxStateBytes / 2) return failure("schema");
  const prior = record(state.sources[source]);
  const known = prior ? priorHead(prior.fingerprint, source) : null;
  const budget = { left: fetchOlderPage ? maxOlderPages : 0 };
  const observedRows = [...decoded.rows];
  // Deduping keeps one arbitrary row per identity, so freshness is decided on the raw rows instead.
  // An unseen identity is exposed by a removal only when its row is positively older than a truncated target's floor.
  // Unreadable timestamps are never exposed and equal timestamps count as inside, so both fire.
  const fresh = new Set();
  const markFresh = (rows, target) => {
    for (const row of rows) if (!belowTarget(source, target, row)) fresh.add(identity(row));
  };
  let unobserved = false;
  const gaps = [];
  if (known) {
    const headScan = decoded.coverage.truncated
      ? await scanOlder(source, decoded, known, new Set(decoded.rows.map((row) => identity(row))), fetchOlderPage, budget)
      : { older: [], page: decoded, complete: true, stalled: false };
    observedRows.push(...headScan.older);
    markFresh([...decoded.rows, ...headScan.older], known);
    // Unread messages between this head and the last one become a gap, resumed by later evaluations.
    if (!headScan.complete && (headScan.stalled || !fetchOlderPage)) unobserved = true;
    else if (!headScan.complete) {
      gaps.push({ target: { ids: [...known.ids], floor: known.floor }, floor: headScan.page.floor, cursor: headScan.page.cursor, edge: edgeIds(source, headScan.page) });
    }
  }
  // Older gaps resume, oldest first, with whatever budget the head left.
  const pending = [];
  for (const gap of prior?.gaps ?? []) {
    if (budget.left === 0) {
      pending.push(gap);
      continue;
    }
    const target = { ids: new Set(gap.target.ids), floor: gap.target.floor };
    const start = { rows: [], floor: gap.floor, cursor: gap.cursor, coverage: { truncated: true } };
    const scan = await scanOlder(source, start, target, new Set(gap.edge), fetchOlderPage, budget);
    observedRows.push(...scan.older);
    markFresh(scan.older, target);
    if (scan.complete) continue;
    if (scan.stalled) unobserved = true;
    else pending.push(scan.page === start ? gap : { ...gap, floor: scan.page.floor, cursor: scan.page.cursor, edge: edgeIds(source, scan.page) });
  }
  gaps.unshift(...pending);
  while (gaps.length > maxGaps) {
    gaps.shift();
    unobserved = true;
  }
  const added = canonicalize(observedRows, identity).filter((item) => fresh.has(identity(item)));
  const changed = added.length > 0;
  const withGaps = () => ({ ...state.sources, [source]: { fingerprint, cursor: decoded.cursor, lastSuccessAt: nowMs, ...(gaps.length > 0 ? { gaps } : {}) } });
  state.sources = withGaps();
  // Gaps that cannot fit the state budget are dropped oldest first, and the delta says so.
  while (gaps.length > 0 && utf8Bytes(JSON.stringify(state)) > maxStateBytes) {
    gaps.shift();
    unobserved = true;
    state.sources = withGaps();
  }
  if (changed) {
    const id = source + ":" + nowMs + ":" + fingerprint.length;
    state.continuations = [...state.continuations.filter((entry) => entry.id !== id), { id, source, dueAt: nowMs + template.continuation.delayMs, expiresAt: nowMs + template.continuation.ttlMs, fires: 0 }]
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, template.continuation.maxOpen);
  }
  const dueIndex = state.continuations.findIndex((entry) => entry.source === source && entry.dueAt <= nowMs);
  const nativeSweepDue = state.nextNativeSweepAt <= nowMs;
  let message;
  if (changed) {
    message = JSON.stringify({ version: contractVersion, kind: "source_delta", source, cursor: decoded.cursor, coverage: decoded.coverage, items: added, uncertainty: unobserved ? "older_matches_not_observed" : gaps.length > 0 ? "older_matches_pending" : null, nativeSourceSweep: nativeSweepDue });
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
  const decode =
    template.templateId === "gmail-metadata-v1"
      ? "decodeGmail(older, template.maxItems)"
      : "decodeMessages(older, template.maxItems, true)";
  return `const template = ${JSON.stringify(template)};
${PORTABLE_TRIGGER_RUNTIME}
const fetchOlderPage = async (page) => {
  const args = olderPageArgs(template, page);
  if (!args) return null;
  let older;
  try {
    older = await ${callable}(args);
  } catch (error) {
    return failure(normalizeFailureKind(error));
  }
  return ${decode};
};
let observation;
try {
  observation = await ${callable}(template.args);
} catch (error) {
  return failure(normalizeFailureKind(error));
}
return await evaluate(template, observation, trigger.state, Date.now(), fetchOlderPage);`;
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
