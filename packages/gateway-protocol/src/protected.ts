import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, maxLength: 256 });
const protectedAgentId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const ProtectedAgentToolSchema = Type.Union([
  Type.Literal("web_fetch"),
  Type.Literal("show_widget"),
  Type.Literal("sessions_list"),
  Type.Literal("sessions_history"),
  Type.Literal("sessions_send"),
]);
export const ProtectedAgentSchema = node({
  id: protectedAgentId,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
  tools: Type.Array(ProtectedAgentToolSchema),
});
export const ProtectedAgentCatalogSchema = node({
  defaultAgentId: protectedAgentId,
  agents: Type.Array(ProtectedAgentSchema),
});
export const ProtectedAgentSelectionSchema = node({
  selectedAgentId: protectedAgentId,
});
export const ProtectedAgentMentionSchema = node({ agentId: protectedAgentId });
export const ProtectedProviderSchema = Type.Union([
  Type.Literal("sparky"),
  Type.Literal("github-copilot"),
  Type.Literal("anthropic"),
  Type.Literal("openai"),
]);
export const ProtectedThinkLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("adaptive"),
  Type.Literal("max"),
  Type.Literal("ultra"),
]);
export const ProtectedCredentialSchema = node({
  accessToken: Type.String({ minLength: 1, maxLength: 16000 }),
  refreshToken: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
  expiresAt: Type.Optional(Type.Integer()),
  generation: Type.Optional(Type.Integer({ minimum: 0 })),
  accountId: Type.Optional(id),
});
export const ProtectedTurnRequestSchema = node({
  text: Type.String({ minLength: 1, maxLength: 16000 }),
  mentions: Type.Optional(
    Type.Array(ProtectedAgentMentionSchema, { maxItems: 4, uniqueItems: true }),
  ),
  model: Type.Optional(id),
  provider: ProtectedProviderSchema,
  credential: Type.Optional(ProtectedCredentialSchema),
  thinking: Type.Optional(ProtectedThinkLevelSchema),
});
export const ProtectedSourceSchema = node({ title: Type.String(), url: Type.String() });
export const ProtectedWidgetSchema = node({ id, title: Type.String() });
export const ProtectedActivitySchema = node({
  id,
  kind: Type.Union([
    Type.Literal("search"),
    Type.Literal("fetch"),
    Type.Literal("widget"),
    Type.Literal("tool"),
  ]),
  label: Type.String({ maxLength: 200 }),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
});
export const ProtectedTurnEventSchema = Type.Union([
  node({ type: Type.Literal("start"), runId: id }),
  node({ type: Type.Literal("delta"), text: Type.String() }),
  node({ type: Type.Literal("reasoning"), text: Type.String() }),
  node({ type: Type.Literal("activity"), ...ProtectedActivitySchema.properties }),
  node({
    type: Type.Literal("child-result"),
    runId: id,
    agentId: protectedAgentId,
    text: Type.String(),
  }),
  node({ type: Type.Literal("sources"), sources: Type.Array(ProtectedSourceSchema) }),
  node({ type: Type.Literal("widget"), ...ProtectedWidgetSchema.properties }),
  node({ type: Type.Literal("usage"), contextTokens: Type.Integer({ minimum: 0 }) }),
  node({
    type: Type.Literal("widget-draft"),
    id,
    title: Type.Optional(Type.String({ maxLength: 200 })),
    html: Type.Optional(Type.String({ maxLength: 262144 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 262144 })),
    receivedChars: Type.Integer({ minimum: 0 }),
    unavailable: Type.Optional(
      Type.Union([
        Type.Literal("limit"),
        Type.Literal("gap"),
        Type.Literal("unsupported"),
        Type.Literal("invalid"),
      ]),
    ),
  }),
  node({ type: Type.Literal("done"), chatVersion: Type.String() }),
  node({ type: Type.Literal("error"), code: Type.String(), message: Type.String() }),
]);
export const ProtectedMessageSchema = node({
  id,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String(),
  reasoning: Type.Optional(Type.String()),
  activity: Type.Optional(Type.Array(ProtectedActivitySchema)),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  agentId: Type.Optional(protectedAgentId),
  sources: Type.Optional(Type.Array(ProtectedSourceSchema)),
  widgets: Type.Optional(Type.Array(ProtectedWidgetSchema)),
  status: Type.Optional(
    Type.Union([Type.Literal("complete"), Type.Literal("interrupted"), Type.Literal("failed")]),
  ),
});
export const ProtectedChatSummarySchema = node({
  id,
  title: Type.String(),
  version: Type.String(),
  updatedAt: Type.Number(),
  activeRun: Type.Optional(node({ id })),
  selectedAgentId: Type.Optional(protectedAgentId),
});
export const ProtectedChatSchema = node({
  ...ProtectedChatSummarySchema.properties,
  messages: Type.Array(ProtectedMessageSchema),
});
export const ProtectedAgentSelectionResponseSchema = node({ chat: ProtectedChatSchema });
export const ProtectedModelSchema = node({
  provider: ProtectedProviderSchema,
  id,
  label: Type.String(),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  thinking: Type.Optional(
    node({
      levels: Type.Array(ProtectedThinkLevelSchema),
      default: ProtectedThinkLevelSchema,
      nativeChoices: Type.Optional(
        Type.Array(
          node({
            level: ProtectedThinkLevelSchema,
            aliases: Type.Array(ProtectedThinkLevelSchema),
          }),
        ),
      ),
      orchestrationLevels: Type.Optional(Type.Array(ProtectedThinkLevelSchema)),
    }),
  ),
});
export const ProtectedModelsSchema = node({ models: Type.Array(ProtectedModelSchema) });
export const ProtectedMeSchema = node({
  user: node({ id, displayName: Type.String() }),
  disclosure: Type.String(),
  models: Type.Array(ProtectedModelSchema),
  capabilities: node({ copilotConnect: Type.Boolean(), openaiConnect: Type.Boolean() }),
});
export const ProtectedAccountNameSchema = node({
  displayName: Type.String({ minLength: 1, maxLength: 40 }),
});
export const ProtectedDirectorySettingsSchema = node({
  description: Type.String({ maxLength: 140 }),
  hidden: Type.Boolean(),
});
export const ProtectedAccountSchema = node({
  user: node({ id, ...ProtectedAccountNameSchema.properties }),
  directory: ProtectedDirectorySettingsSchema,
});
export const ProtectedAccountNameResponseSchema = node({
  user: node({ id, ...ProtectedAccountNameSchema.properties }),
});
export const ProtectedDirectorySettingsResponseSchema = node({
  directory: ProtectedDirectorySettingsSchema,
});
export const ProtectedPeopleSchema = node({
  people: Type.Array(
    node({
      id,
      ...ProtectedAccountNameSchema.properties,
      description: Type.String({ maxLength: 140 }),
    }),
  ),
  nextCursor: Type.Union([id, Type.Null()]),
});
export const ProtectedDevicePromptSchema = node({
  id,
  verificationUrl: Type.String(),
  userCode: Type.String(),
  intervalMs: Type.Integer(),
  expiresAt: Type.Integer(),
});
export const ProtectedDevicePollSchema = Type.Union([
  node({ status: Type.Literal("pending") }),
  node({ status: Type.Literal("authorized"), credential: ProtectedCredentialSchema }),
]);
export const ProtectedRenewSchema = node({ credential: ProtectedCredentialSchema });
export const ProtectedErrorSchema = node({
  error: node({ code: Type.String(), message: Type.String() }),
});
export const ProtectedChatsSchema = node({ chats: Type.Array(ProtectedChatSummarySchema) });
export const ProtectedExportSchema = node({ chats: Type.Array(ProtectedChatSchema) });
export const ProtectedChatResponseSchema = node({
  chat: ProtectedChatSchema,
  usage: Type.Optional(
    node({
      contextTokens: Type.Integer({ minimum: 0 }),
      provider: ProtectedProviderSchema,
      model: id,
    }),
  ),
  // A reply that this signed-in session started and that is still running on the server.
  activeRun: Type.Optional(node({ id })),
});
export const ProtectedCreateChatSchema = node({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  selectedAgentId: Type.Optional(protectedAgentId),
});
export const ProtectedSteerSchema = node({
  id,
  text: Type.String({ minLength: 1, maxLength: 16000 }),
});
export const ProtectedSteerResultSchema = node({ queued: Type.Literal(true) });
export const ProtectedStopResultSchema = node({ stopped: Type.Literal(true) });
export const ProtectedWidgetResponseSchema = node({
  ...ProtectedWidgetSchema.properties,
  html: Type.String(),
  version: id,
});
export const ProtectedFilesSchema = node({
  files: Type.Array(node({ id, name: Type.String(), size: Type.Integer({ minimum: 0 }) })),
});
export type ProtectedCredential = Static<typeof ProtectedCredentialSchema>;
export type ProtectedAgentTool = Static<typeof ProtectedAgentToolSchema>;
export type ProtectedAgent = Static<typeof ProtectedAgentSchema>;
export type ProtectedAgentCatalogDto = Static<typeof ProtectedAgentCatalogSchema>;
export type ProtectedAgentSelection = Static<typeof ProtectedAgentSelectionSchema>;
export type ProtectedAgentSelectionResponse = Static<typeof ProtectedAgentSelectionResponseSchema>;
export type ProtectedAgentMention = Static<typeof ProtectedAgentMentionSchema>;
export type ProtectedTurnEvent = Static<typeof ProtectedTurnEventSchema>;
export type ProtectedTurnRequest = Static<typeof ProtectedTurnRequestSchema>;
export type ProtectedChat = Static<typeof ProtectedChatSchema>;
export type ProtectedChatSummary = Static<typeof ProtectedChatSummarySchema>;
export type ProtectedMessage = Static<typeof ProtectedMessageSchema>;
export type ProtectedActivity = Static<typeof ProtectedActivitySchema>;
export type ProtectedModel = Static<typeof ProtectedModelSchema>;
export type ProtectedMe = Static<typeof ProtectedMeSchema>;
export type ProtectedAccount = Static<typeof ProtectedAccountSchema>;
export type ProtectedAccountName = Static<typeof ProtectedAccountNameSchema>;
export type ProtectedAccountNameResponse = Static<typeof ProtectedAccountNameResponseSchema>;
export type ProtectedDirectorySettings = Static<typeof ProtectedDirectorySettingsSchema>;
export type ProtectedDirectorySettingsResponse = Static<
  typeof ProtectedDirectorySettingsResponseSchema
>;
export type ProtectedPeople = Static<typeof ProtectedPeopleSchema>;
export type ProtectedDevicePrompt = Static<typeof ProtectedDevicePromptSchema>;
export type ProtectedDevicePoll = Static<typeof ProtectedDevicePollSchema>;
export const isProtectedTurnRequest = (value: unknown): value is ProtectedTurnRequest =>
  Value.Check(ProtectedTurnRequestSchema, value);
export const isProtectedAgentSelection = (value: unknown): value is ProtectedAgentSelection =>
  Value.Check(ProtectedAgentSelectionSchema, value);
export const isProtectedAgentMention = (value: unknown): value is ProtectedAgentMention =>
  Value.Check(ProtectedAgentMentionSchema, value);
export const isProtectedCreateChat = (
  value: unknown,
): value is Static<typeof ProtectedCreateChatSchema> =>
  Value.Check(ProtectedCreateChatSchema, value);
export const isProtectedSteer = (value: unknown): value is Static<typeof ProtectedSteerSchema> =>
  Value.Check(ProtectedSteerSchema, value);
export const isProtectedRenew = (value: unknown): value is Static<typeof ProtectedRenewSchema> =>
  Value.Check(ProtectedRenewSchema, value);
export const isProtectedAccountName = (
  value: unknown,
): value is Static<typeof ProtectedAccountNameSchema> =>
  Value.Check(ProtectedAccountNameSchema, value);
export const isProtectedDirectorySettings = (
  value: unknown,
): value is Static<typeof ProtectedDirectorySettingsSchema> =>
  Value.Check(ProtectedDirectorySettingsSchema, value);
