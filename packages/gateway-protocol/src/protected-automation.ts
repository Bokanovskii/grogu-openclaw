import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { id, node, protectedAgentId, ProtectedThinkLevelSchema } from "./protected-fields.js";
import { MAX_DATE_TIMESTAMP_MS } from "./schema/cron-shared.js";

export const ProtectedAutomationCapabilitiesSchema = node({
  catalog: Type.Boolean(),
  draftValidation: Type.Boolean(),
  list: Type.Boolean(),
  create: Type.Boolean(),
  delete: Type.Optional(Type.Boolean()),
  scheduleControl: Type.Boolean(),
  run: Type.Boolean(),
  sharing: Type.Boolean(),
  notifications: Type.Boolean(),
  contextAccess: Type.Optional(Type.Boolean()),
  chat: Type.Optional(
    node({
      list: Type.Boolean(),
      read: Type.Boolean(),
      proposeCreate: Type.Boolean(),
      proposePatch: Type.Boolean(),
      authoring: Type.Optional(Type.Boolean()),
    }),
  ),
  // Sent only to automations-public-v1 clients, like ProtectedAutomationRecord.publication.
  public: Type.Optional(
    node({ publish: Type.Boolean(), follow: Type.Boolean(), notifications: Type.Boolean() }),
  ),
});
export const ProtectedAutomationScheduleSchema = Type.Union([
  node({
    kind: Type.Literal("every"),
    everyMs: Type.Integer({ minimum: 1, maximum: MAX_DATE_TIMESTAMP_MS }),
  }),
  node({
    kind: Type.Literal("cron"),
    expr: Type.String({ minLength: 1, maxLength: 128 }),
    tz: Type.String({ minLength: 1, maxLength: 64 }),
  }),
]);
export const protectedAutomationPacingLimits = { minimumMs: 60_000, maximumMs: 2_592_000_000 };
const pacingDelayMs = Type.Integer({
  minimum: protectedAutomationPacingLimits.minimumMs,
  maximum: protectedAutomationPacingLimits.maximumMs,
});
const protectedAutomationPacing = node({ minMs: pacingDelayMs, maxMs: pacingDelayMs });
export type ProtectedAutomationPacing = Static<typeof protectedAutomationPacing>;

export function isValidProtectedAutomationPacing(
  schedule: ProtectedAutomationSchedule,
  pacing: ProtectedAutomationPacing,
): boolean {
  return (
    schedule.kind === "every" &&
    Number.isSafeInteger(pacing.minMs) &&
    Number.isSafeInteger(pacing.maxMs) &&
    pacing.minMs >= protectedAutomationPacingLimits.minimumMs &&
    pacing.maxMs <= protectedAutomationPacingLimits.maximumMs &&
    pacing.minMs <= schedule.everyMs &&
    schedule.everyMs <= pacing.maxMs
  );
}
export const ProtectedAutomationIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const ProtectedAutomationCronCatalogSchema = node({
  format: Type.Literal("5-field"),
  repeats: Type.Array(
    Type.Union([Type.Literal("daily"), Type.Literal("weekdays"), Type.Literal("saturday")]),
    { minItems: 1, uniqueItems: true },
  ),
  timeZones: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    minItems: 1,
    uniqueItems: true,
  }),
  timePrecision: Type.Literal("minute"),
  staggerMs: Type.Literal(0),
  daylightSaving: node({
    nonexistentLocalTime: Type.Literal("skip"),
    repeatedLocalTime: Type.Literal("first"),
  }),
});
export const ProtectedAutomationScheduleCatalogSchema = node({
  kinds: Type.Array(Type.Union([Type.Literal("every"), Type.Literal("cron")]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  }),
  everyMs: Type.Optional(node({ minimum: Type.Integer(), maximum: Type.Integer() })),
  cron: Type.Optional(ProtectedAutomationCronCatalogSchema),
  pacing: Type.Optional(node({ minimumMs: pacingDelayMs, maximumMs: pacingDelayMs })),
});
const protectedAutomationDraftFields = {
  name: Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" }),
  instructions: Type.String({ minLength: 1, maxLength: 16_384, pattern: "\\S" }),
  whenToNotify: Type.String({ minLength: 1, maxLength: 4_096, pattern: "\\S" }),
  doneWhen: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S" })),
  agentId: protectedAgentId,
  model: node({
    provider: Type.Literal("sparky"),
    id,
  }),
  thinking: Type.Optional(ProtectedThinkLevelSchema),
  contextAccess: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("member")])),
  schedule: ProtectedAutomationScheduleSchema,
  pacing: Type.Optional(protectedAutomationPacing),
};
export const ProtectedAutomationDraftSchema = node(protectedAutomationDraftFields);
export const ProtectedAutomationCreateRequestSchema = ProtectedAutomationDraftSchema;
export const ProtectedAutomationPatchRequestSchema = node({
  name: Type.Optional(protectedAutomationDraftFields.name),
  instructions: Type.Optional(protectedAutomationDraftFields.instructions),
  whenToNotify: Type.Optional(protectedAutomationDraftFields.whenToNotify),
  doneWhen: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S" }), Type.Null()]),
  ),
  agentId: Type.Optional(protectedAgentId),
  model: Type.Optional(protectedAutomationDraftFields.model),
  thinking: Type.Optional(Type.Union([ProtectedThinkLevelSchema, Type.Null()])),
  schedule: Type.Optional(ProtectedAutomationScheduleSchema),
  pacing: Type.Optional(Type.Union([protectedAutomationPacing, Type.Null()])),
  enabled: Type.Optional(Type.Boolean()),
});
export const ProtectedAutomationRecordSchema = node({
  ...protectedAutomationDraftFields,
  thinking: ProtectedThinkLevelSchema,
  id: ProtectedAutomationIdSchema,
  version: Type.String({ minLength: 1, maxLength: 128 }),
  enabled: Type.Boolean(),
  state: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
  nextCheckAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  nextCheckReason: Type.Optional(
    Type.Union([Type.Literal("model"), Type.Literal("fallback"), Type.Literal("backoff")]),
  ),
  publication: Type.Optional(
    Type.Union([
      node({
        publishedAt: Type.Integer({ minimum: 0 }),
        followers: Type.Integer({ minimum: 0 }),
      }),
      Type.Null(),
    ]),
  ),
});
export const ProtectedAutomationListResponseSchema = node({
  automations: Type.Array(ProtectedAutomationRecordSchema),
});
export const ProtectedAutomationResponseSchema = node({
  automation: ProtectedAutomationRecordSchema,
});
export const ProtectedAutomationRunResponseSchema = node({
  runId: id,
  status: Type.Literal("queued"),
});
export const ProtectedAutomationDraftValidationSchema = Type.Union([
  node({
    valid: Type.Literal(true),
    draft: ProtectedAutomationDraftSchema,
  }),
  node({
    valid: Type.Literal(false),
    errors: Type.Array(
      node({
        field: Type.String({ minLength: 1, maxLength: 32 }),
        code: Type.String({ minLength: 1, maxLength: 48 }),
        message: Type.String({ minLength: 1, maxLength: 160 }),
      }),
      { minItems: 1 },
    ),
  }),
]);
export type ProtectedAutomationCapabilities = Static<typeof ProtectedAutomationCapabilitiesSchema>;
export type ProtectedAutomationId = Static<typeof ProtectedAutomationIdSchema>;
export type ProtectedAutomationSchedule = Static<typeof ProtectedAutomationScheduleSchema>;
export type ProtectedAutomationCronCatalog = Static<typeof ProtectedAutomationCronCatalogSchema>;
export type ProtectedAutomationDraft = Static<typeof ProtectedAutomationDraftSchema>;
export type ProtectedAutomationCreateRequest = Static<
  typeof ProtectedAutomationCreateRequestSchema
>;
export type ProtectedAutomationPatchRequest = Static<typeof ProtectedAutomationPatchRequestSchema>;
export type ProtectedAutomationRecord = Static<typeof ProtectedAutomationRecordSchema>;
export type ProtectedAutomationListResponse = Static<typeof ProtectedAutomationListResponseSchema>;
export type ProtectedAutomationResponse = Static<typeof ProtectedAutomationResponseSchema>;
export type ProtectedAutomationRunResponse = Static<typeof ProtectedAutomationRunResponseSchema>;
export type ProtectedAutomationDraftValidation = Static<
  typeof ProtectedAutomationDraftValidationSchema
>;
export const isProtectedAutomationPatchRequest = (
  value: unknown,
): value is ProtectedAutomationPatchRequest =>
  Value.Check(ProtectedAutomationPatchRequestSchema, value);
