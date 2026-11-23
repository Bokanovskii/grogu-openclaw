import { Type, type Static } from "typebox";

const id = Type.String({ minLength: 1 });
const timestamp = Type.Integer({ minimum: 0 });

/** One finished run kept for its owner. `text` is the private final text, never a published message. */
export const ProtectedAutomationFinishedRunSchema = Type.Object(
  {
    id,
    automationId: id,
    version: id,
    definitionRevision: Type.Integer({ minimum: 1 }),
    runId: id,
    runAtMs: timestamp,
    completedAtMs: timestamp,
    automationName: Type.String(),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const ProtectedAutomationRunListResponseSchema = Type.Object(
  { runs: Type.Array(ProtectedAutomationFinishedRunSchema) },
  { additionalProperties: false },
);

export const ProtectedAutomationRunResponseSchema = Type.Object(
  { run: ProtectedAutomationFinishedRunSchema },
  { additionalProperties: false },
);

export const ProtectedAutomationLifecycleRunSchema = Type.Object(
  {
    id,
    automationId: id,
    profileId: id,
    definitionRevision: Type.Integer({ minimum: 1 }),
    trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("manual")]),
    scheduledAtMs: timestamp,
    queuedAtMs: timestamp,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
    runChatId: Type.Union([id, Type.Null()]),
    startedAtMs: Type.Union([timestamp, Type.Null()]),
    finishedAtMs: Type.Union([timestamp, Type.Null()]),
    errorCode: Type.Union([
      Type.Literal("interrupted"),
      Type.Literal("member_inactive"),
      Type.Literal("automation_disabled"),
      Type.Literal("definition_changed"),
      Type.Literal("quota_exceeded"),
      Type.Literal("provider_timeout"),
      Type.Literal("provider_busy"),
      Type.Literal("provider_rejected"),
      Type.Literal("provider_failed"),
      Type.Literal("plan_limit"),
      Type.Literal("model_unavailable"),
      Type.Literal("chat_too_long"),
      Type.Literal("turn_failed"),
      Type.Literal("result_failed"),
      Type.Null(),
    ]),
    resultId: Type.Union([id, Type.Null()]),
    delivery: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ProtectedAutomationLifecycleListResponseSchema = Type.Object(
  { runs: Type.Array(ProtectedAutomationLifecycleRunSchema) },
  { additionalProperties: false },
);

export const ProtectedAutomationInboxEntrySchema = Type.Object(
  {
    runId: id,
    automationId: id,
    resultId: id,
    createdAtMs: timestamp,
    push: Type.Literal("not-started"),
  },
  { additionalProperties: false },
);

export const ProtectedAutomationInboxResponseSchema = Type.Object(
  { entries: Type.Array(ProtectedAutomationInboxEntrySchema) },
  { additionalProperties: false },
);

export type ProtectedAutomationFinishedRun = Static<typeof ProtectedAutomationFinishedRunSchema>;
export type ProtectedAutomationRunListResponse = Static<
  typeof ProtectedAutomationRunListResponseSchema
>;
export type ProtectedAutomationRunResponse = Static<typeof ProtectedAutomationRunResponseSchema>;
export type ProtectedAutomationLifecycleRun = Static<typeof ProtectedAutomationLifecycleRunSchema>;
export type ProtectedAutomationLifecycleListResponse = Static<
  typeof ProtectedAutomationLifecycleListResponseSchema
>;
export type ProtectedAutomationInboxResponse = Static<
  typeof ProtectedAutomationInboxResponseSchema
>;
