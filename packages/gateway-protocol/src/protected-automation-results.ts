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

export type ProtectedAutomationFinishedRun = Static<typeof ProtectedAutomationFinishedRunSchema>;
export type ProtectedAutomationRunListResponse = Static<
  typeof ProtectedAutomationRunListResponseSchema
>;
export type ProtectedAutomationRunResponse = Static<typeof ProtectedAutomationRunResponseSchema>;
