import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,95}$" });
const text = (maxLength: number) => Type.String({ maxLength });
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const nullableTimestamp = Type.Union([timestamp, Type.Null()]);
const minutes = Type.Integer({ minimum: 1, maximum: 525_600 });
const cadence = Type.Union([minutes, Type.Null()]);
const priority = Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]);
const status = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("done"),
  Type.Literal("archived"),
]);
const origin = Type.Union([
  Type.Literal("owner"),
  Type.Literal("noticed"),
  Type.Literal("automation"),
]);
const sourceIds = Type.Array(id, { maxItems: 20, uniqueItems: true });
const topicFields = {
  title: Type.String({ minLength: 1, maxLength: 240, pattern: "\\S" }),
  why: text(1_000),
  priority,
  status,
  cadenceMinutes: cadence,
  origin,
  notifyBar: text(1_000),
  notes: text(2_000),
  findingsRef: text(1_000),
  sourceIds,
};
const optionalFields = {
  title: Type.Optional(topicFields.title),
  why: Type.Optional(topicFields.why),
  priority: Type.Optional(priority),
  status: Type.Optional(status),
  cadenceMinutes: Type.Optional(cadence),
  origin: Type.Optional(origin),
  notifyBar: Type.Optional(topicFields.notifyBar),
  notes: Type.Optional(topicFields.notes),
  findingsRef: Type.Optional(topicFields.findingsRef),
  sourceIds: Type.Optional(sourceIds),
  nextDueAtMs: Type.Optional(nullableTimestamp),
};
const revision = Type.Integer({ minimum: 1 });
const leaseMinutes = Type.Integer({ minimum: 1, maximum: 60 });
const lease = Type.String({ minLength: 1, maxLength: 96 });
const outcomes = Type.Array(
  object({
    id,
    outcome: Type.Union([
      Type.Literal("ok"),
      Type.Literal("throttled"),
      Type.Literal("error"),
      Type.Literal("skipped"),
    ]),
    retryAfterMinutes: Type.Optional(minutes),
  }),
  { maxItems: 20 },
);
const page = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  after: Type.Optional(id),
};

export const requestSchema = Type.Union([
  object({ action: Type.Literal("list"), status: Type.Optional(status), ...page }),
  object({ action: Type.Literal("get"), id }),
  object({ action: Type.Literal("add"), id, ...optionalFields, title: topicFields.title }),
  object({
    action: Type.Literal("update"),
    id,
    expectedRevision: revision,
    changes: object(optionalFields),
  }),
  object({
    action: Type.Literal("remove"),
    id,
    expectedRevision: revision,
    hardDelete: Type.Optional(Type.Boolean()),
  }),
  object({
    action: Type.Literal("due"),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  object({
    action: Type.Literal("acquire"),
    id,
    leaseMinutes: Type.Optional(leaseMinutes),
  }),
  object({
    action: Type.Literal("record_check"),
    id,
    leaseId: lease,
    sources: outcomes,
    nextDueAtMs: Type.Optional(nullableTimestamp),
  }),
  object({ action: Type.Literal("record_notification"), id, confirmedAtMs: timestamp }),
  object({ action: Type.Literal("signal"), id }),
  object({ action: Type.Literal("source_list"), ...page }),
  object({
    action: Type.Literal("source_set"),
    id,
    minimumIntervalMinutes: minutes,
    expectedRevision: Type.Optional(revision),
  }),
]);

// Providers require an object at the tool-schema root; the action union validates each call.
export const toolSchema = object({
  action: Type.Index(requestSchema, ["action"]),
  id: Type.Optional(id),
  ...optionalFields,
  ...page,
  expectedRevision: Type.Optional(revision),
  changes: Type.Optional(object(optionalFields)),
  hardDelete: Type.Optional(Type.Boolean()),
  leaseMinutes: Type.Optional(leaseMinutes),
  leaseId: Type.Optional(lease),
  sources: Type.Optional(outcomes),
  confirmedAtMs: Type.Optional(timestamp),
  minimumIntervalMinutes: Type.Optional(minutes),
});

export type Request = Static<typeof requestSchema>;
export type Topic = {
  id: string;
  title: string;
  why: string;
  priority: Static<typeof priority>;
  status: Static<typeof status>;
  cadenceMinutes: number | null;
  origin: Static<typeof origin>;
  notifyBar: string;
  notes: string;
  findingsRef: string;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastCheckedAtMs: number | null;
  nextDueAtMs: number | null;
  lastNotifiedAtMs: number | null;
  leaseId: string | null;
  leaseUntilMs: number | null;
  pendingDue: number;
};
export type Source = {
  id: string;
  minimumIntervalMinutes: number;
  lastAttemptedAtMs: number | null;
  lastFetchedAtMs: number | null;
  lastStatus: "ok" | "throttled" | "error" | "skipped" | null;
  backoffUntilMs: number | null;
  leaseId: string | null;
  leaseUntilMs: number | null;
  revision: number;
};
export type LedgerDatabase = {
  topics: Topic;
  sources: Source;
  topic_sources: { topicId: string; sourceId: string };
};
export type LedgerOperations = {
  request: { input: { request: Request; now: number }; output: unknown };
};

export function parseRequest(value: unknown): Request {
  if (!Check(requestSchema, value)) {
    throw new Error("Invalid research_topics arguments. Use the action schema and bounded fields.");
  }
  return value;
}

export const toolDescription =
  "Manage the private research ledger. Use add for owner requests or inferred interests " +
  "(origin noticed); use stable topic ids, list/get before editing, expectedRevision for updates, " +
  "and remove to archive (hardDelete only for explicit permanent removal). cadenceMinutes=null " +
  "means on-signal, not continuous. signal makes an active topic due. " +
  "Define shared source ids with source_set before attaching sourceIds to topics. " +
  "due returns at most 50 eligible summaries ordered high/normal/low, then oldest due time. " +
  "Before ANY research fetch, acquire the topic; if unavailable, do not fetch. " +
  "acquire reserves its sources and records attempts; record_check must use that leaseId and " +
  "one outcome for EVERY source (ok, throttled for HTTP 429/refusal, error, or skipped). " +
  "Record throttling and Retry-After with retryAfterMinutes. lastFetchedAtMs records success only. " +
  "record_notification requires confirmedAtMs from a successful delivery record, never an intended send. " +
  "For scheduled notices, reconcile in a later turn after delivery; repeated or older confirmations " +
  "do not advance lastNotifiedAtMs. No action fetches, sends, or schedules a job. " +
  "Use notifyBar to decide whether a finding merits a message; keep long findings outside the ledger.";
