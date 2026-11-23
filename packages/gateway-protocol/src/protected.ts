import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MAX_DATE_TIMESTAMP_MS } from "./schema/cron-shared.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const protectedAgentId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" });
const protectedAutomationIdPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const ProtectedAgentToolSchema = Type.Union([
  Type.Literal("web_search"),
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
// agents-v1 shapes are sent only to requests that list that capability; the legacy shapes above stay exact.
export const ProtectedAgentSkillSchema = node({
  id: protectedAgentId,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
});
export const ProtectedAgentPresentationSchema = node({
  icon: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
  reasoningIndicator: Type.Union([Type.Literal("grogu-eater"), Type.Literal("standard")]),
  widgetWidth: Type.Union([Type.Literal("standard"), Type.Literal("wide")]),
});
export const ProtectedAgentV1Schema = node({
  ...ProtectedAgentSchema.properties,
  tools: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), { uniqueItems: true }),
  selectable: Type.Boolean(),
  examplePrompts: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 4 }),
  skills: Type.Array(ProtectedAgentSkillSchema, { maxItems: 8 }),
  presentation: ProtectedAgentPresentationSchema,
});
export const ProtectedAgentCatalogV1Schema = node({
  defaultAgentId: protectedAgentId,
  agents: Type.Array(ProtectedAgentV1Schema),
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
  contextSize: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
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
  node({
    type: Type.Literal("child-result"),
    runId: id,
    agentId: protectedAgentId,
    text: Type.String(),
  }),
  node({ type: Type.Literal("reasoning"), text: Type.String() }),
  node({ type: Type.Literal("activity"), ...ProtectedActivitySchema.properties }),
  node({ type: Type.Literal("sources"), sources: Type.Array(ProtectedSourceSchema) }),
  node({ type: Type.Literal("widget"), ...ProtectedWidgetSchema.properties }),
  node({
    type: Type.Literal("usage"),
    contextTokens: Type.Integer({ minimum: 0 }),
    inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    contextSize: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
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
  agentId: Type.Optional(protectedAgentId),
  reasoning: Type.Optional(Type.String()),
  activity: Type.Optional(Type.Array(ProtectedActivitySchema)),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
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
  selectedAgentId: Type.Optional(protectedAgentId),
  activeRun: Type.Optional(node({ id })),
  authoring: Type.Optional(
    node({
      kind: Type.Literal("automation"),
      automationId: Type.Optional(Type.String({ pattern: protectedAutomationIdPattern })),
    }),
  ),
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
  vendor: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  contextSizes: Type.Optional(
    node({
      options: Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 2,
        maxItems: 2,
        uniqueItems: true,
      }),
      default: Type.Integer({ minimum: 1 }),
      longContextSurcharge: Type.Boolean(),
    }),
  ),
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
export const ProtectedProfileIconSchema = Type.Union([
  node({ kind: Type.Literal("emoji"), emoji: Type.String({ minLength: 1, maxLength: 32 }) }),
  node({
    kind: Type.Literal("image"),
    url: Type.String({
      pattern: "^/api/protected/v1/people/[A-Za-z0-9_.:%-]+/icon\\?v=[A-Za-z0-9_-]{1,128}$",
    }),
  }),
]);
const profileIconField = Type.Union([ProtectedProfileIconSchema, Type.Null()]);
const profileSetupFields = { setupRequired: Type.Boolean(), icon: profileIconField };
export const ProtectedMeSchema = node({
  user: node({ id, displayName: Type.String(), ...profileSetupFields }),
  disclosure: Type.String(),
  models: Type.Array(ProtectedModelSchema),
  capabilities: node({
    copilotConnect: Type.Boolean(),
    openaiConnect: Type.Boolean(),
    admin: Type.Boolean(),
    feedback: Type.Optional(Type.Boolean()),
    telemetry: Type.Optional(Type.Boolean()),
    memory: Type.Optional(node({ review: Type.Boolean() })),
    sharing: Type.Optional(Type.Boolean()),
  }),
});
export const ProtectedMemoryNoteSchema = node({
  id: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  name: Type.String({ minLength: 1 }),
  bytes: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
});
export const ProtectedMemoryListResponseSchema = node({
  notes: Type.Array(ProtectedMemoryNoteSchema),
});
export const ProtectedMemoryReadResponseSchema = node({
  note: ProtectedMemoryNoteSchema,
  text: Type.String(),
});
export const ProtectedAutomationCapabilitiesSchema = node({
  catalog: Type.Boolean(),
  draftValidation: Type.Boolean(),
  list: Type.Boolean(),
  create: Type.Boolean(),
  scheduleControl: Type.Boolean(),
  run: Type.Boolean(),
  sharing: Type.Boolean(),
  notifications: Type.Boolean(),
  chat: Type.Optional(
    node({
      list: Type.Boolean(),
      read: Type.Boolean(),
      proposeCreate: Type.Boolean(),
      proposePatch: Type.Boolean(),
      authoring: Type.Optional(Type.Boolean()),
    }),
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
export const ProtectedAutomationIdSchema = Type.String({
  pattern: protectedAutomationIdPattern,
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
const protectedAutomationCatalogFields = {
  capabilities: node({
    automations: ProtectedAutomationCapabilitiesSchema,
  }),
  defaultAgentId: protectedAgentId,
  agents: Type.Array(ProtectedAgentSchema),
  models: Type.Array(ProtectedModelSchema, { minItems: 1, maxItems: 1 }),
  schedule: node({
    kinds: Type.Array(Type.Union([Type.Literal("every"), Type.Literal("cron")]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    everyMs: Type.Optional(
      node({
        minimum: Type.Integer(),
        maximum: Type.Integer(),
      }),
    ),
    cron: Type.Optional(ProtectedAutomationCronCatalogSchema),
  }),
  limits: node({
    definitionBytes: Type.Integer({ minimum: 1 }),
    nameCodeUnits: Type.Integer({ minimum: 1 }),
    instructionsBytes: Type.Integer({ minimum: 1 }),
    whenToNotifyBytes: Type.Integer({ minimum: 1 }),
    doneWhenCodeUnits: Type.Integer({ minimum: 1 }),
  }),
};
export const ProtectedAutomationCatalogSchema = node(protectedAutomationCatalogFields);
export const ProtectedAutomationCatalogV1Schema = node({
  ...protectedAutomationCatalogFields,
  agents: Type.Array(ProtectedAgentV1Schema),
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
  schedule: ProtectedAutomationScheduleSchema,
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
  agentId: Type.Optional(protectedAutomationDraftFields.agentId),
  model: Type.Optional(protectedAutomationDraftFields.model),
  thinking: Type.Optional(Type.Union([ProtectedThinkLevelSchema, Type.Null()])),
  schedule: Type.Optional(ProtectedAutomationScheduleSchema),
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
export const ProtectedAccountNameSchema = node({
  displayName: Type.String({ minLength: 1, maxLength: 40 }),
});
export const ProtectedDirectorySettingsSchema = node({
  description: Type.String({ maxLength: 140 }),
  hidden: Type.Boolean(),
});
const protectedAccountUser = node({
  id,
  // Empty only while the account still needs first-time setup.
  displayName: Type.String({ maxLength: 40 }),
  ...profileSetupFields,
});
export const ProtectedAccountSchema = node({
  user: protectedAccountUser,
  directory: ProtectedDirectorySettingsSchema,
});
export const ProtectedAccountNameResponseSchema = node({ user: protectedAccountUser });
export const ProtectedAccountIconSchema = node({
  icon: Type.Union([
    node({ kind: Type.Literal("emoji"), emoji: Type.String({ minLength: 1, maxLength: 32 }) }),
    Type.Null(),
  ]),
});
export const ProtectedAccountIconResponseSchema = node({ icon: profileIconField });
export const ProtectedDirectorySettingsResponseSchema = node({
  directory: ProtectedDirectorySettingsSchema,
});
export const ProtectedPeopleSchema = node({
  people: Type.Array(
    node({
      id,
      ...ProtectedAccountNameSchema.properties,
      description: Type.String({ maxLength: 140 }),
      icon: profileIconField,
    }),
  ),
  nextCursor: Type.Union([id, Type.Null()]),
});
export const ProtectedAccessRequestStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("approving"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("removed"),
  Type.Literal("withdrawn"),
]);
export const ProtectedPublicAccessRequestSchema = node({
  id,
  email: Type.String({ minLength: 3, maxLength: 254 }),
  name: Type.String({ maxLength: 80 }),
  note: Type.String({ maxLength: 1000 }),
  status: ProtectedAccessRequestStatusSchema,
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export const ProtectedAccessRequestSubmitSchema = node({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  note: Type.String({ maxLength: 1000 }),
});
export const ProtectedAccessRequestEditSchema = node({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  note: Type.String({ maxLength: 1000 }),
});
export const ProtectedAccessRequestReceiptResultSchema = node({
  accepted: Type.Literal(true),
});
export const ProtectedAccessRequestEditResponseSchema = node({
  request: node({
    id,
    status: ProtectedAccessRequestStatusSchema,
  }),
});
export const ProtectedAccessRequestStatusResponseSchema = node({
  request: Type.Union([ProtectedPublicAccessRequestSchema, Type.Null()]),
});
export const ProtectedAdminRequestSchema = node({
  ...ProtectedPublicAccessRequestSchema.properties,
  policyState: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("synced"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
  ),
});
export const ProtectedAdminRequestsResponseSchema = node({
  requests: Type.Array(ProtectedAdminRequestSchema),
  policyBlocked: Type.Boolean(),
  blockedPersonId: Type.Optional(id),
});
export const ProtectedAdminPolicyRetryResponseSchema = node({ queued: Type.Literal(true) });
export const ProtectedAdminPersonSchema = node({
  id,
  email: Type.Union([Type.String({ minLength: 3, maxLength: 254 }), Type.Null()]),
  issuer: Type.String({ minLength: 1 }),
  subject: Type.Optional(id),
  profileId: Type.Optional(id),
  lastActiveAt: Type.Optional(Type.Integer({ minimum: 0 })),
  status: Type.Union([Type.Literal("approved"), Type.Literal("removed")]),
  revision: Type.Integer({ minimum: 1 }),
  policyState: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("synced"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
  ),
});
export const ProtectedAdminPeopleResponseSchema = node({
  people: Type.Array(ProtectedAdminPersonSchema),
});
export const ProtectedDailyUsageSchema = node({
  day: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  messages: Type.Integer({ minimum: 0 }),
  tokens: Type.Integer({ minimum: 0 }),
  models: Type.Array(Type.String()),
  errors: Type.Integer({ minimum: 0 }),
  missingUsage: Type.Integer({ minimum: 0 }),
  missingMessages: Type.Integer({ minimum: 0 }),
});
export const ProtectedAdminUsageResponseSchema = node({
  daily: Type.Array(ProtectedDailyUsageSchema),
  chatCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  approximateStorageBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  lastActiveAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  lastChatActivityAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export const ProtectedAdminPushKeySchema = node({ publicKey: Type.String() });
export const ProtectedAdminPushSubscribeSchema = node({
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  keys: node({
    p256dh: Type.String({ minLength: 1, maxLength: 512 }),
    auth: Type.String({ minLength: 1, maxLength: 512 }),
  }),
});
export const ProtectedAdminPushSubscribeResponseSchema = node({ subscriptionId: id });
export const ProtectedAdminPushUnsubscribeSchema = node({
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
});
export const ProtectedAdminPushUnsubscribeResponseSchema = node({ removed: Type.Boolean() });
export const ProtectedOwnerActionResponseSchema = node({
  request: ProtectedPublicAccessRequestSchema,
  policy: Type.Optional(Type.Literal("sync_pending")),
});
export const ProtectedAdminPersonRemovalResponseSchema = node({
  person: ProtectedAdminPersonSchema,
  policy: Type.Union([Type.Literal("removal_pending"), Type.Literal("identity_unavailable")]),
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
export const ProtectedChatStorageSchema = node({
  limitBytes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  usedBytes: Type.Integer({ minimum: 0 }),
  chats: Type.Array(
    node({
      id,
      title: Type.String(),
      updatedAt: Type.Number(),
      version: Type.String(),
      approximateBytes: Type.Integer({ minimum: 0 }),
    }),
  ),
});
export const ProtectedExportSchema = node({ chats: Type.Array(ProtectedChatSchema) });
export const ProtectedChatResponseSchema = node({
  chat: ProtectedChatSchema,
  usage: Type.Optional(
    node({
      contextTokens: Type.Integer({ minimum: 0 }),
      inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
      outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
      contextSize: Type.Optional(Type.Integer({ minimum: 1 })),
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
export type ProtectedAgentSkill = Static<typeof ProtectedAgentSkillSchema>;
export type ProtectedAgentPresentation = Static<typeof ProtectedAgentPresentationSchema>;
export type ProtectedAgentV1 = Static<typeof ProtectedAgentV1Schema>;
export type ProtectedAgentCatalogV1 = Static<typeof ProtectedAgentCatalogV1Schema>;
export type ProtectedAgentCatalogDto = Static<typeof ProtectedAgentCatalogSchema>;
export type ProtectedAgentSelection = Static<typeof ProtectedAgentSelectionSchema>;
export type ProtectedAgentSelectionResponse = Static<typeof ProtectedAgentSelectionResponseSchema>;
export type ProtectedAgentMention = Static<typeof ProtectedAgentMentionSchema>;
export type ProtectedTurnEvent = Static<typeof ProtectedTurnEventSchema>;
export type ProtectedTurnRequest = Static<typeof ProtectedTurnRequestSchema>;
export type ProtectedChat = Static<typeof ProtectedChatSchema>;
export type ProtectedChatSummary = Static<typeof ProtectedChatSummarySchema>;
export type ProtectedChatStorage = Static<typeof ProtectedChatStorageSchema>;
export type ProtectedMessage = Static<typeof ProtectedMessageSchema>;
export type ProtectedActivity = Static<typeof ProtectedActivitySchema>;
export type ProtectedModel = Static<typeof ProtectedModelSchema>;
export type ProtectedMe = Static<typeof ProtectedMeSchema>;
export type ProtectedMemoryNote = Static<typeof ProtectedMemoryNoteSchema>;
export type ProtectedMemoryListResponse = Static<typeof ProtectedMemoryListResponseSchema>;
export type ProtectedMemoryReadResponse = Static<typeof ProtectedMemoryReadResponseSchema>;
export type ProtectedAutomationCapabilities = Static<typeof ProtectedAutomationCapabilitiesSchema>;
export type ProtectedAutomationCatalog = Static<typeof ProtectedAutomationCatalogSchema>;
export type ProtectedAutomationCatalogV1 = Static<typeof ProtectedAutomationCatalogV1Schema>;
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
export type ProtectedAccount = Static<typeof ProtectedAccountSchema>;
export type ProtectedAccountName = Static<typeof ProtectedAccountNameSchema>;
export type ProtectedProfileIcon = Static<typeof ProtectedProfileIconSchema>;
export type ProtectedAccountIcon = Static<typeof ProtectedAccountIconSchema>;
export type ProtectedAccountIconResponse = Static<typeof ProtectedAccountIconResponseSchema>;
export type ProtectedAccountNameResponse = Static<typeof ProtectedAccountNameResponseSchema>;
export type ProtectedDirectorySettings = Static<typeof ProtectedDirectorySettingsSchema>;
export type ProtectedDirectorySettingsResponse = Static<
  typeof ProtectedDirectorySettingsResponseSchema
>;
export type ProtectedPeople = Static<typeof ProtectedPeopleSchema>;
export type ProtectedAccessRequestStatus = Static<typeof ProtectedAccessRequestStatusSchema>;
export type ProtectedPublicAccessRequest = Static<typeof ProtectedPublicAccessRequestSchema>;
export type ProtectedAccessRequestSubmit = Static<typeof ProtectedAccessRequestSubmitSchema>;
export type ProtectedAccessRequestEdit = Static<typeof ProtectedAccessRequestEditSchema>;
export type ProtectedAccessRequestReceiptResult = Static<
  typeof ProtectedAccessRequestReceiptResultSchema
>;
export type ProtectedAccessRequestEditResponse = Static<
  typeof ProtectedAccessRequestEditResponseSchema
>;
export type ProtectedAccessRequestStatusResponse = Static<
  typeof ProtectedAccessRequestStatusResponseSchema
>;
export type ProtectedAdminRequest = Static<typeof ProtectedAdminRequestSchema>;
export type ProtectedAdminRequestsResponse = Static<typeof ProtectedAdminRequestsResponseSchema>;
export type ProtectedAdminPolicyRetryResponse = Static<
  typeof ProtectedAdminPolicyRetryResponseSchema
>;
export type ProtectedAdminPerson = Static<typeof ProtectedAdminPersonSchema>;
export type ProtectedAdminPeopleResponse = Static<typeof ProtectedAdminPeopleResponseSchema>;
export type ProtectedDailyUsage = Static<typeof ProtectedDailyUsageSchema>;
export type ProtectedAdminUsageResponse = Static<typeof ProtectedAdminUsageResponseSchema>;
export type ProtectedAdminPushKey = Static<typeof ProtectedAdminPushKeySchema>;
export type ProtectedAdminPushSubscribe = Static<typeof ProtectedAdminPushSubscribeSchema>;
export type ProtectedAdminPushSubscribeResponse = Static<
  typeof ProtectedAdminPushSubscribeResponseSchema
>;
export type ProtectedAdminPushUnsubscribe = Static<typeof ProtectedAdminPushUnsubscribeSchema>;
export type ProtectedAdminPushUnsubscribeResponse = Static<
  typeof ProtectedAdminPushUnsubscribeResponseSchema
>;
export type ProtectedOwnerActionResponse = Static<typeof ProtectedOwnerActionResponseSchema>;
export type ProtectedAdminPersonRemovalResponse = Static<
  typeof ProtectedAdminPersonRemovalResponseSchema
>;
export type ProtectedChatResponse = Static<typeof ProtectedChatResponseSchema>;
export type ProtectedDevicePrompt = Static<typeof ProtectedDevicePromptSchema>;
export type ProtectedDevicePoll = Static<typeof ProtectedDevicePollSchema>;
export const isProtectedTurnRequest = (value: unknown): value is ProtectedTurnRequest =>
  Value.Check(ProtectedTurnRequestSchema, value);
export const isProtectedAutomationPatchRequest = (
  value: unknown,
): value is ProtectedAutomationPatchRequest =>
  Value.Check(ProtectedAutomationPatchRequestSchema, value);
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
export const isProtectedAccountIcon = (value: unknown): value is ProtectedAccountIcon =>
  Value.Check(ProtectedAccountIconSchema, value);
