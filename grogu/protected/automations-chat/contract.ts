import {
  ProtectedAutomationDraftSchema,
  ProtectedAutomationIdSchema,
  ProtectedAutomationPatchRequestSchema,
  type ProtectedAutomationDraft,
  type ProtectedAutomationDraftValidation,
  type ProtectedAutomationRecord,
} from "@openclaw/gateway-protocol/protected";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const AUTOMATIONS_CHAT_PLUGIN_ID = "alcove-automations-chat";
export const AUTOMATIONS_CHAT_TOOL_NAMES = [
  "automations_list",
  "automations_read",
  "automations_propose_create",
  "automations_propose_patch",
] as const;
/** Authoring turns get only these tools; ordinary automation chats keep the proposal tools. */
export const AUTOMATIONS_AUTHORING_TOOL_NAMES = [
  "automation_draft_read",
  "automation_draft_update",
  "automation_draft_save",
] as const;
export const NEXT_CHECK_TOOL_NAME = "next_check";

export const NextCheckParametersSchema = node({
  in: Type.String({ minLength: 1, maxLength: 100, description: 'Relative delay, e.g. "15m".' }),
});
export function isNextCheckParameters(
  value: unknown,
): value is Static<typeof NextCheckParametersSchema> {
  return Value.Check(NextCheckParametersSchema, value);
}

export type NextCheckBindings = {
  parseDurationMs: (duration: string) => number;
  proposeNextCheck: (delayMs: number) => void;
};

export const AutomationsChatListParametersSchema = node({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const AutomationsChatReadParametersSchema = node({
  automationId: ProtectedAutomationIdSchema,
});
export const AutomationsChatProposeCreateParametersSchema = node({
  draft: ProtectedAutomationDraftSchema,
});
export const AutomationsChatProposalPatchSchema = Type.Omit(ProtectedAutomationPatchRequestSchema, [
  "enabled",
]);
export const AutomationsChatProposePatchParametersSchema = node({
  automationId: ProtectedAutomationIdSchema,
  expectedVersion: Type.String({ minLength: 1, maxLength: 16, pattern: "^[1-9]\\d*$" }),
  patch: AutomationsChatProposalPatchSchema,
});

export const AutomationsAuthoringReadParametersSchema = node({});
export const AutomationsAuthoringUpdateParametersSchema = node({
  draft: ProtectedAutomationDraftSchema,
});
export const AutomationsAuthoringSaveParametersSchema = node({
  draftRevision: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 16,
      pattern: "^[1-9]\\d*$",
      description: "Only supply this if the member specifies a revision. Otherwise omit it.",
    }),
  ),
});

export type AutomationsChatListParameters = Static<typeof AutomationsChatListParametersSchema>;
export type AutomationsChatReadParameters = Static<typeof AutomationsChatReadParametersSchema>;
export type AutomationsChatProposeCreateParameters = Static<
  typeof AutomationsChatProposeCreateParametersSchema
>;
export type AutomationsChatProposalPatch = Omit<
  Static<typeof ProtectedAutomationPatchRequestSchema>,
  "enabled"
>;
export type AutomationsChatProposePatchParameters = Static<
  typeof AutomationsChatProposePatchParametersSchema
>;

type ValidationErrors = Extract<ProtectedAutomationDraftValidation, { valid: false }>["errors"];

export type AutomationsChatBindings = {
  list: (input: AutomationsChatListParameters) => Promise<{
    status: "ok";
    writeApplied: false;
    total: number;
    offset: number;
    limit: number;
    automations: ProtectedAutomationRecord[];
  }>;
  read: (
    input: AutomationsChatReadParameters,
  ) => Promise<
    | { status: "found"; writeApplied: false; automation: ProtectedAutomationRecord }
    | { status: "not_found"; writeApplied: false }
  >;
  proposeCreate: (
    input: AutomationsChatProposeCreateParameters,
  ) => Promise<
    | { status: "proposed"; writeApplied: false; draft: ProtectedAutomationDraft }
    | { status: "invalid"; writeApplied: false; errors: ValidationErrors }
  >;
  proposePatch: (input: AutomationsChatProposePatchParameters) => Promise<
    | {
        status: "proposed";
        writeApplied: false;
        automationId: string;
        expectedVersion: string;
        draft: ProtectedAutomationDraft;
      }
    | { status: "invalid"; writeApplied: false; errors: ValidationErrors }
    | { status: "not_found"; writeApplied: false }
    | { status: "version_mismatch"; writeApplied: false; currentVersion: string }
    | { status: "unavailable"; writeApplied: false; reason: "automation_active" }
  >;
};

export type AutomationsAuthoringUpdateParameters = Static<
  typeof AutomationsAuthoringUpdateParametersSchema
>;
export type AutomationsAuthoringSaveParameters = Static<
  typeof AutomationsAuthoringSaveParametersSchema
>;

/** Draft results are unsaved (writeApplied:false); only save reports a committed record. */
export type AutomationsAuthoringBindings = {
  authoring: "automation";
  read: () => Promise<{
    status: "ok";
    writeApplied: false;
    draftRevision: string;
    draft: ProtectedAutomationDraft;
    saved: ProtectedAutomationRecord | null;
  }>;
  update: (input: AutomationsAuthoringUpdateParameters) => Promise<
    | {
        status: "draft_updated";
        writeApplied: false;
        draftRevision: string;
        draft: ProtectedAutomationDraft;
      }
    | { status: "invalid"; writeApplied: false; errors: ValidationErrors }
  >;
  save: (input: AutomationsAuthoringSaveParameters) => Promise<
    | { status: "saved"; writeApplied: true; automation: ProtectedAutomationRecord }
    | { status: "invalid"; writeApplied: false; errors: ValidationErrors }
    | {
        status: "refused";
        writeApplied: false;
        reason:
          | "draft_changed"
          | "version_mismatch"
          | "not_found"
          | "automation_active"
          | "unavailable";
      }
  >;
};

export function isAutomationsAuthoringUpdateParameters(
  value: unknown,
): value is AutomationsAuthoringUpdateParameters {
  return Value.Check(AutomationsAuthoringUpdateParametersSchema, value);
}

export function isAutomationsAuthoringSaveParameters(
  value: unknown,
): value is AutomationsAuthoringSaveParameters {
  return Value.Check(AutomationsAuthoringSaveParametersSchema, value);
}

export function isAutomationsChatListParameters(
  value: unknown,
): value is AutomationsChatListParameters {
  return Value.Check(AutomationsChatListParametersSchema, value);
}

export function isAutomationsChatReadParameters(
  value: unknown,
): value is AutomationsChatReadParameters {
  return Value.Check(AutomationsChatReadParametersSchema, value);
}

export function isAutomationsChatProposeCreateParameters(
  value: unknown,
): value is AutomationsChatProposeCreateParameters {
  return Value.Check(AutomationsChatProposeCreateParametersSchema, value);
}

export function isAutomationsChatProposePatchParameters(
  value: unknown,
): value is AutomationsChatProposePatchParameters {
  return Value.Check(AutomationsChatProposePatchParametersSchema, value);
}

export function isAutomationsChatProposalPatch(
  value: unknown,
): value is AutomationsChatProposalPatch {
  return (
    Value.Check(AutomationsChatProposalPatchSchema, value) &&
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length > 0
  );
}
