import type { Generated } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

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
    toolCallId: nonblank(256),
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

export function parseRequest(value: unknown): Request {
  if (!Check(requestSchema, value)) {
    throw new Error("Invalid research_topics arguments. Use the action schema and bounded fields.");
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
  "lookup (default 8, max 20) finds bounded candidates by title/aliases/summary; category filters tags. " +
  "Review semantic equivalence in this turn, get the full brief, then add/update/merge. " +
  "Stable ids; updates patch only supplied fields and require expectedRevision. On conflict reread " +
  "and reconcile, never blindly replay. merge also requires sourceRevision and reconciled title/brief; " +
  "it unions links and returns affectedSessionRefs for you to update those sessions. New sessionRefs " +
  "must be your current conversation; existing refs survive updates/merges. sourceIds are " +
  "provider budgets, not conversations. No claims: overlapping research is allowed. " +
  "Intake runs bounded new-evidence passes; only the research worker advances old topics. " +
  "due orders least-served first, then priority and oldest waiting. record_check uses expectedRevision " +
  "and a unique operationId per completed unit; it preserves content and keeps unfinished work ready. " +
  "Monitoring requires an actual monitoringReason and nextDueAtMs; there is no default timer. " +
  "Before each fetch use source_attempt; if denied do not fetch. Record its attemptId via source_result " +
  "(ok/throttled/error/skipped, retryAfterMinutes for Retry-After). Saved-info synthesis needs no fetch. " +
  "complete freezes the topic with a reason and resolves configured Main itself. " +
  "For an explicit owner correction, reopen with expectedRevision, then update the returned revision; " +
  "this invalidates the old completion. Ordinary producer updates must not reopen automatically. " +
  "post_update writes a visible message to one recorded source session through the native transcript " +
  "owner; supply its sessionKey/sessionId, message, operationId, and completionId for a closing update. " +
  "notify_main sends a text candidate to configured Main; keep its returned runId, never blindly resend. " +
  "For completion, Main uses prepare_text with its final ownerText, then the normal message tool to " +
  "the configured owner route. Native successful message receipts settle that obligation. " +
  "Main can recover with confirm_completion and the actual toolCallId; no model-supplied delivery " +
  "claim is accepted. finalize never deletes unconfirmed destinations. forget is immediate permanent " +
  "deletion only for an explicit owner request, never a completion-verification workaround. " +
  "No archives, source fetches, or per-topic jobs are created.";
