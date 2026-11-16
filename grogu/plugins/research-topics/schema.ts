import type { Generated } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,95}$" });
const text = (maxLength: number) => Type.String({ maxLength });
const nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const nullableTimestamp = Type.Union([timestamp, Type.Null()]);
const minutes = Type.Integer({ minimum: 1, maximum: 525_600 });
const revision = Type.Integer({ minimum: 1 });
const priority = Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]);
const purpose = Type.Union([
  Type.Literal("answer"),
  Type.Literal("decision"),
  Type.Literal("watch"),
]);
const workState = Type.Union([
  Type.Literal("ready"),
  Type.Literal("monitoring"),
  Type.Literal("waiting"),
]);
const status = Type.Union([Type.Literal("active"), Type.Literal("completion_pending")]);
const origin = Type.Union([
  Type.Literal("owner"),
  Type.Literal("noticed"),
  Type.Literal("automation"),
]);
const session = { sessionKey: nonblank(512), sessionId: nonblank(128) };
const sessionRef = object({ ...session, messageId: Type.Optional(nonblank(256)) });
const sourceIds = Type.Array(id, { maxItems: 20 });
const aliases = Type.Array(nonblank(160), { maxItems: 32 });
const tags = Type.Array(nonblank(80), { maxItems: 32 });
const sessionRefs = Type.Array(sessionRef, { maxItems: 64 });
const scheduling = {
  workState: Type.Optional(workState),
  monitoringReason: Type.Optional(text(1_000)),
  nextDueAtMs: Type.Optional(nullableTimestamp),
};
const topicFields = {
  title: Type.Optional(nonblank(240)),
  brief: Type.Optional(text(65_536)),
  why: Type.Optional(text(1_000)),
  notes: Type.Optional(text(2_000)),
  findingsRef: Type.Optional(text(1_000)),
  priority: Type.Optional(priority),
  purpose: Type.Optional(purpose),
  completionRule: Type.Optional(Type.Union([nonblank(2_000), Type.Null()])),
  origin: Type.Optional(origin),
  notifyBar: Type.Optional(text(1_000)),
  aliases: Type.Optional(aliases),
  tags: Type.Optional(tags),
  sessionRefs: Type.Optional(sessionRefs),
  sourceIds: Type.Optional(sourceIds),
  ...scheduling,
};
const page = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  after: Type.Optional(id),
};
const outcome = Type.Union([
  Type.Literal("ok"),
  Type.Literal("throttled"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
export const requestSchema = Type.Union([
  object({ action: Type.Literal("list"), status: Type.Optional(status), ...page }),
  object({ action: Type.Literal("get"), id }),
  object({
    action: Type.Literal("lookup"),
    query: nonblank(500),
    sessionKey: Type.Optional(session.sessionKey),
    category: Type.Optional(nonblank(80)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  object({ action: Type.Literal("add"), id, ...topicFields, title: nonblank(240) }),
  object({
    action: Type.Literal("update"),
    id,
    expectedRevision: revision,
    changes: object(topicFields),
  }),
  object({
    action: Type.Literal("merge"),
    id,
    expectedRevision: revision,
    sourceId: id,
    sourceRevision: revision,
    changes: object({ ...topicFields, title: nonblank(240), brief: text(65_536) }),
  }),
  object({ action: Type.Literal("forget"), id, expectedRevision: revision }),
  object({
    action: Type.Literal("due"),
    category: Type.Optional(nonblank(80)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  object({
    action: Type.Literal("record_check"),
    id,
    expectedRevision: revision,
    operationId: nonblank(128),
    ...scheduling,
  }),
  object({
    action: Type.Literal("complete"),
    id,
    expectedRevision: revision,
    reason: nonblank(2_000),
  }),
  object({ action: Type.Literal("reopen"), id, expectedRevision: revision }),
  object({ action: Type.Literal("link_session"), id }),
  object({
    action: Type.Literal("post_update"),
    id,
    expectedRevision: revision,
    ...session,
    message: nonblank(8_000),
    operationId: nonblank(128),
    completionId: Type.Optional(nonblank(128)),
  }),
  object({
    action: Type.Literal("notify_main"),
    id,
    expectedRevision: revision,
    message: nonblank(8_000),
    operationId: nonblank(128),
  }),
  object({
    action: Type.Literal("prepare_text"),
    id,
    expectedRevision: revision,
    completionId: nonblank(128),
    ownerText: nonblank(8_000),
  }),
  object({
    action: Type.Literal("confirm_completion"),
    id,
    expectedRevision: revision,
    completionId: nonblank(128),
    toolCallId: Type.Optional(nonblank(256)),
  }),
  object({
    action: Type.Literal("finalize"),
    id,
    expectedRevision: revision,
    completionId: nonblank(128),
  }),
  object({ action: Type.Literal("source_list"), ...page }),
  object({
    action: Type.Literal("source_set"),
    id,
    minimumIntervalMinutes: minutes,
    expectedRevision: Type.Optional(revision),
  }),
  object({ action: Type.Literal("source_attempt"), id }),
  object({
    action: Type.Literal("source_result"),
    id,
    attemptId: nonblank(128),
    outcome,
    retryAfterMinutes: Type.Optional(minutes),
  }),
]);

// Provider tool schemas require an object root; the union validates action-specific fields.
export const toolSchema = object({
  action: Type.Index(requestSchema, ["action"]),
  id: Type.Optional(id),
  ...topicFields,
  ...page,
  status: Type.Optional(status),
  query: Type.Optional(nonblank(500)),
  sessionKey: Type.Optional(session.sessionKey),
  sessionId: Type.Optional(session.sessionId),
  message: Type.Optional(nonblank(8_000)),
  category: Type.Optional(nonblank(80)),
  expectedRevision: Type.Optional(revision),
  changes: Type.Optional(object(topicFields)),
  sourceId: Type.Optional(id),
  sourceRevision: Type.Optional(revision),
  operationId: Type.Optional(nonblank(128)),
  reason: Type.Optional(nonblank(2_000)),
  ownerText: Type.Optional(nonblank(8_000)),
  completionId: Type.Optional(nonblank(128)),
  toolCallId: Type.Optional(nonblank(256)),
  minimumIntervalMinutes: Type.Optional(minutes),
  attemptId: Type.Optional(nonblank(128)),
  outcome: Type.Optional(outcome),
  retryAfterMinutes: Type.Optional(minutes),
});

export type Request = Static<typeof requestSchema>;
export type SessionRef = Static<typeof sessionRef>;
export type CompletionReceipt = Pick<SessionRef, "sessionKey" | "sessionId"> & {
  kind: "session_message" | "owner_text";
  messageId: string;
  completedAtMs: number;
  toolCallId?: string;
};
export type Topic = {
  id: string;
  title: string;
  brief: string;
  why: string;
  notes: string;
  findingsRef: string;
  priority: Static<typeof priority>;
  purpose: Static<typeof purpose>;
  workState: Static<typeof workState>;
  status: Static<typeof status>;
  completionRule: string | null;
  monitoringReason: string;
  origin: Static<typeof origin>;
  notifyBar: string;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastCheckedAtMs: number | null;
  nextDueAtMs: number | null;
  lastNotifiedAtMs: number | null;
  serviceCount: number;
  waitingSinceMs: number;
  lastCheckOperationId: string | null;
  lastCheckFingerprint: string | null;
  completionId: string | null;
  completionReason: string | null;
  ownerText: string | null;
  completedAtMs: number | null;
};
export type Source = {
  id: string;
  minimumIntervalMinutes: number;
  lastAttemptedAtMs: number | null;
  lastFetchedAtMs: number | null;
  lastStatus: Static<typeof outcome> | null;
  backoffUntilMs: number | null;
  attemptId: string | null;
  lastResultFingerprint: string | null;
  revision: number;
};
export type CompletionDestination = {
  topicId: string;
  destinationId: string;
  kind: "main" | "session";
  sessionKey: string;
  sessionId: string;
  receiptJson: string | null;
};
export type TopicRecord = Topic & {
  sessionRefs: SessionRef[];
  destinations: (Omit<CompletionDestination, "receiptJson"> & { receipt: unknown })[];
};
export type LedgerDatabase = {
  topics: Topic;
  sources: Source;
  topic_sources: { topicId: string; sourceId: string };
  topic_aliases: { topicId: string; alias: string };
  topic_tags: { topicId: string; tag: string };
  topic_sessions: { topicId: string; sessionKey: string; sessionId: string; messageId: string };
  completion_destinations: CompletionDestination;
  topic_search: {
    topicId: string;
    title: string;
    aliases: string;
    summary: string;
    topic_search: Generated<string>;
    rank: Generated<number>;
  };
};
export type LedgerOperations = {
  publication: {
    input: { id: string; expectedRevision: number };
    output: TopicRecord;
  };
  request: {
    input: {
      request: Request;
      now: number;
      caller?: Pick<SessionRef, "sessionKey" | "sessionId">;
      mainSession?: Pick<SessionRef, "sessionKey" | "sessionId">;
      verifiedReceipt?: CompletionReceipt;
    };
    output: unknown;
  };
  matchMessage: {
    input: { ownerText: string; caller: Pick<SessionRef, "sessionKey" | "sessionId"> };
    output: { id: string; expectedRevision: number; completionId: string } | undefined;
  };
};

const actionSchemas = requestSchema.anyOf;
const categoryHint = "it only filters lookup and due; label a topic with tags";
const unknownNameLimit = 8;
const unknownNameLength = 64;

// The provider schema is flat and cannot show per-action requirements, so a rejection names the repair.
// The validator stops after a few errors per call and a flat call with many wrong fields uses them all
// before it reports the summary, so missing and unknown fields come from the action's own property list
// and every field is validated alone.
function describeInvalidRequest(value: unknown): string {
  const input = typeof value === "object" && value !== null ? value : undefined;
  const action = input && "action" in input ? input.action : undefined;
  const schema = actionSchemas.find((candidate) => candidate.properties.action.const === action);
  if (!input || !schema) {
    const names = actionSchemas.map((candidate) => candidate.properties.action.const);
    return `Invalid research_topics arguments: action must be one of ${names.join(", ")}.`;
  }
  const missing: string[] = [];
  const unknown: string[] = [];
  const allowed = new Map<string, string[]>();
  const choices = new Map<string, string[]>();
  const invalid = new Map<string, string[]>();
  const join = (...parts: string[]) => parts.filter(Boolean).join(".");
  const addUnknown = (where: string, names: string[]) => {
    for (const name of names.slice(0, unknownNameLimit)) {
      const shown =
        name.length > unknownNameLength ? `${name.slice(0, unknownNameLength)}...` : name;
      unknown.push(
        name === "category" ? `${join(where, shown)} (${categoryHint})` : join(where, shown),
      );
    }
    if (names.length > unknownNameLimit) {
      unknown.push(`and ${names.length - unknownNameLimit} more${where ? ` in ${where}` : ""}`);
    }
  };
  const check = (field: TSchema, fieldValue: unknown, where: string) => {
    for (const error of Errors(field, fieldValue)) {
      const at = join(where, error.instancePath.slice(1).replaceAll("/", "."));
      if (error.keyword === "required") {
        missing.push(...error.params.requiredProperties.map((name) => join(at, name)));
      } else if (error.keyword === "additionalProperties") {
        addUnknown(at, error.params.additionalProperties);
      } else if (error.keyword === "const") {
        choices.set(at, [...(choices.get(at) ?? []), JSON.stringify(error.params.allowedValue)]);
      } else if (error.keyword !== "boolean" && error.keyword !== "anyOf") {
        invalid.set(at, [...(invalid.get(at) ?? []), error.message]);
      }
    }
  };
  const inspect = (shape: TObject, fields: object, where: string) => {
    for (const [name, field] of Object.entries(shape.properties)) {
      if (!Type.IsOptional(field) && !Object.hasOwn(fields, name)) {
        missing.push(join(where, name));
      }
    }
    const entries: [string, unknown][] = Object.entries(fields);
    const extra = entries
      .map(([name]) => name)
      .filter((name) => !Object.hasOwn(shape.properties, name));
    if (extra.length > 0) {
      addUnknown(where, extra);
      allowed.set(
        where,
        Object.keys(shape.properties).filter((name) => name !== "action"),
      );
    }
    for (const [name, fieldValue] of entries) {
      const field = Object.hasOwn(shape.properties, name) ? shape.properties[name] : undefined;
      if (!field) {
        continue;
      }
      if (
        Type.IsObject(field) &&
        typeof fieldValue === "object" &&
        fieldValue !== null &&
        !Array.isArray(fieldValue)
      ) {
        inspect(field, fieldValue, join(where, name));
      } else {
        check(field, fieldValue, join(where, name));
      }
    }
  };
  inspect(schema, input, "");
  for (const [where, values] of choices) {
    invalid.set(where, [`must be one of ${values.join(", ")}`, ...(invalid.get(where) ?? [])]);
  }
  const parts = [`Invalid research_topics ${schema.properties.action.const} arguments.`];
  if (missing.length > 0) {
    parts.push(`Missing: ${missing.join(", ")}.`);
  }
  if (unknown.length > 0) {
    parts.push(`Unknown: ${unknown.join(", ")}.`);
  }
  for (const [where, fields] of allowed) {
    parts.push(`Allowed${where ? ` in ${where}` : ""}: ${fields.join(", ")}.`);
  }
  if (invalid.size > 0) {
    const problems = [...invalid].slice(0, 5).map(([where, reasons]) => {
      return `${where || "arguments"} ${reasons.join(" or ")}`;
    });
    parts.push(`Invalid: ${problems.join("; ")}.`);
  }
  return parts.join(" ");
}

export function parseRequest(value: unknown): Request {
  if (!Check(requestSchema, value)) {
    throw new Error(describeInvalidRequest(value));
  }
  const fields =
    value.action === "add"
      ? value
      : value.action === "update" || value.action === "merge"
        ? value.changes
        : undefined;
  if (fields?.brief !== undefined && Buffer.byteLength(fields.brief, "utf8") > 65_536) {
    throw new Error("Research brief exceeds 65536 UTF-8 bytes. Reconcile it before saving.");
  }
  return value;
}

export const toolDescription =
  "Internal shared Research Topics owner; no routine ledger narration to the user. " +
  "lookup (default 8, max 20) finds bounded candidates by title/aliases/summary; category only filters lookup/due by tag, so label topics with tags. " +
  "Review semantic equivalence in this turn, get the full brief, then add/update/merge. " +
  "add needs a new stable slug id and title. update patches supplied fields inside changes and requires expectedRevision. On conflict reread " +
  "and reconcile, never blindly replay. merge also requires sourceRevision and reconciled title/brief; " +
  "it unions links and returns affectedSessionRefs for you to update those sessions. New sessionRefs " +
  "must be your current conversation; existing refs survive updates/merges. To receive updates on an existing " +
  "topic your conversation did not add, call link_session with only id after you contribute to it (add already " +
  "links you; scheduled runs cannot link). sourceIds are " +
  "provider budgets, not conversations. No claims: overlapping research is allowed. " +
  "Intake runs bounded new-evidence passes; only the research worker advances old topics. " +
  "due orders least-served first, then priority and oldest waiting. record_check uses expectedRevision " +
  "and a unique operationId per completed unit; it preserves content and keeps unfinished work ready. " +
  "Monitoring is workState monitoring with an actual monitoringReason and nextDueAtMs in the same call; other states take neither, and there is no default timer. " +
  "Before each fetch use source_attempt; its id is the provider from source_list, never a topic id. If denied do not fetch. Record its attemptId via source_result " +
  "(ok/throttled/error/skipped, retryAfterMinutes for Retry-After). Saved-info synthesis needs no fetch. " +
  "complete freezes the topic with a reason and resolves configured Main itself. " +
  "For an explicit owner correction, reopen with expectedRevision, then update the returned revision; " +
  "this invalidates the old completion. Ordinary producer updates must not reopen automatically. " +
  "post_update writes a visible message to one recorded source session through the native transcript " +
  "owner; supply its sessionKey/sessionId, message, operationId, and completionId for a closing update. " +
  "notify_main sends a text candidate to configured Main; keep its returned runId, never blindly resend. " +
  "For completion, Main uses prepare_text with its final ownerText, then the normal message tool to " +
  "the configured owner route. Native successful message receipts settle that obligation. " +
  "Main can recover with confirm_completion, which finds the prepared wording in its recent " +
  "native history; no model-supplied delivery claim is accepted. finalize never deletes unconfirmed destinations. forget takes only id and expectedRevision; it is immediate permanent " +
  "deletion only for an explicit owner request, never a completion-verification workaround. " +
  "No archives, source fetches, or per-topic jobs are created.";
