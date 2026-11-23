import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ProtectedAutomationDraftSchema,
  ProtectedAutomationRecordSchema,
  ProtectedChatSchema,
  ProtectedTurnEventSchema,
  ProtectedTurnRequestSchema,
} from "./protected.js";

const protectedRevision = Type.String({ pattern: "^[1-9][0-9]{0,15}$" });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
/** Authoring turns carry the client-held unsaved draft; the chat binding stays server-held. */
export const ProtectedAuthoringTurnRequestSchema = node({
  ...ProtectedTurnRequestSchema.properties,
  authoring: node({
    draft: ProtectedAutomationDraftSchema,
    draftRevision: protectedRevision,
    automationVersion: Type.Optional(protectedRevision),
  }),
});
export const ProtectedAuthoringTurnEventSchema = Type.Union([
  ...ProtectedTurnEventSchema.anyOf,
  node({
    type: Type.Literal("automation-draft-update"),
    baseDraftRevision: protectedRevision,
    draftRevision: protectedRevision,
    draft: ProtectedAutomationDraftSchema,
  }),
  node({
    type: Type.Literal("automation-saved"),
    draftRevision: protectedRevision,
    automation: ProtectedAutomationRecordSchema,
  }),
  /** Nothing was saved; the client keeps its draft and shows the conflict. */
  node({
    type: Type.Literal("automation-save-refused"),
    draftRevision: protectedRevision,
    reason: Type.Union([
      Type.Literal("draft_changed"),
      Type.Literal("version_mismatch"),
      Type.Literal("not_found"),
      Type.Literal("automation_active"),
      Type.Literal("invalid"),
      Type.Literal("unavailable"),
    ]),
    currentVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  }),
]);
export const ProtectedAutomationAuthoringResponseSchema = node({
  chat: ProtectedChatSchema,
  automation: Type.Optional(ProtectedAutomationRecordSchema),
});
export type ProtectedAuthoringTurnRequest = Static<typeof ProtectedAuthoringTurnRequestSchema>;
export type ProtectedAuthoringTurnEvent = Static<typeof ProtectedAuthoringTurnEventSchema>;
export type ProtectedAutomationAuthoringResponse = Static<
  typeof ProtectedAutomationAuthoringResponseSchema
>;
export const isProtectedAuthoringTurnRequest = (
  value: unknown,
): value is ProtectedAuthoringTurnRequest =>
  Value.Check(ProtectedAuthoringTurnRequestSchema, value);
