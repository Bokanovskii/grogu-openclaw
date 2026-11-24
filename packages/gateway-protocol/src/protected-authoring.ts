import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ProtectedAutomationCapabilitiesSchema,
  ProtectedAutomationCatalogSchema,
  ProtectedAutomationCatalogV1Schema,
  ProtectedAutomationDraftSchema,
  ProtectedAutomationRecordSchema,
  ProtectedChatResponseSchema,
  ProtectedChatSchema,
  ProtectedTurnEventSchema,
  ProtectedTurnRequestSchema,
} from "./protected.js";

const protectedRevision = Type.String({ pattern: "^[1-9][0-9]{0,15}$" });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const ProtectedAuthoringDraftSchema = node({
  draft: ProtectedAutomationDraftSchema,
  draftRevision: protectedRevision,
});
// Recovery is opt-in. Older catalog and chat detail schemas remain strict.
const automations = ProtectedAutomationCapabilitiesSchema.properties;
const capabilities = node({
  automations: node({
    ...automations,
    chat: node({ ...automations.chat.properties, draftRecovery: Type.Literal(true) }),
  }),
});
export const ProtectedDraftRecoveryCatalogSchema = node({
  ...ProtectedAutomationCatalogSchema.properties,
  agents: Type.Union([
    ProtectedAutomationCatalogSchema.properties.agents,
    ProtectedAutomationCatalogV1Schema.properties.agents,
  ]),
  capabilities,
});
export const ProtectedDraftRecoveryChatSchema = node({
  ...ProtectedChatResponseSchema.properties,
  authoringDraft: Type.Optional(ProtectedAuthoringDraftSchema),
  authoringBusy: Type.Boolean(),
});
const createDraft = node({ draft: ProtectedAutomationDraftSchema });
const checkpoint = node({
  draft: ProtectedAutomationDraftSchema,
  baseDraftRevision: Type.Union([protectedRevision, Type.Null()]),
});
export type ProtectedAuthoringDraft = Static<typeof ProtectedAuthoringDraftSchema>;
export const isProtectedAuthoringDraft = (value: unknown): value is ProtectedAuthoringDraft =>
  Value.Check(ProtectedAuthoringDraftSchema, value);
export const isProtectedAuthoringCreate = (value: unknown): value is Static<typeof createDraft> =>
  Value.Check(createDraft, value);
export const isProtectedAuthoringCheckpoint = (
  value: unknown,
): value is Static<typeof checkpoint> => Value.Check(checkpoint, value);

/** Authoring turns carry the member's exact draft; the server owns the chat binding. */
export const ProtectedAuthoringTurnRequestSchema = node({
  ...ProtectedTurnRequestSchema.properties,
  authoring: node({
    ...ProtectedAuthoringDraftSchema.properties,
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
