import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, maxLength: 256 });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const ProtectedProviderSchema = Type.Union([
  Type.Literal("sparky"),
  Type.Literal("github-copilot"),
  Type.Literal("anthropic"),
  Type.Literal("openai"),
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
  model: Type.Optional(id),
  provider: ProtectedProviderSchema,
  credential: Type.Optional(ProtectedCredentialSchema),
});
export const ProtectedSourceSchema = node({ title: Type.String(), url: Type.String() });
export const ProtectedWidgetSchema = node({ id, title: Type.String() });
export const ProtectedTurnEventSchema = Type.Union([
  node({ type: Type.Literal("start"), runId: id }),
  node({ type: Type.Literal("delta"), text: Type.String() }),
  node({ type: Type.Literal("sources"), sources: Type.Array(ProtectedSourceSchema) }),
  node({ type: Type.Literal("widget"), ...ProtectedWidgetSchema.properties }),
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
});
export const ProtectedChatSchema = node({
  ...ProtectedChatSummarySchema.properties,
  messages: Type.Array(ProtectedMessageSchema),
});
export const ProtectedModelSchema = node({
  provider: ProtectedProviderSchema,
  id,
  label: Type.String(),
});
export const ProtectedMeSchema = node({
  user: node({ id, displayName: Type.String() }),
  disclosure: Type.String(),
  models: Type.Array(ProtectedModelSchema),
  capabilities: node({
    copilotConnect: Type.Boolean(),
    openaiConnect: Type.Boolean(),
    admin: Type.Boolean(),
  }),
});
export const ProtectedAccessRequestStatusSchema = Type.Union([
  Type.Literal("open"),
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
  request: node({
    id,
    status: ProtectedAccessRequestStatusSchema,
  }),
});
export const ProtectedAccessRequestStatusResponseSchema = node({
  request: Type.Union([ProtectedPublicAccessRequestSchema, Type.Null()]),
});
export const ProtectedAdminRequestSchema = ProtectedPublicAccessRequestSchema;
export const ProtectedAdminRequestsResponseSchema = node({
  requests: Type.Array(ProtectedAdminRequestSchema),
});
export const ProtectedAdminPersonSchema = node({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  issuer: Type.String({ minLength: 1 }),
  subject: Type.Optional(id),
  profileId: Type.Optional(id),
  status: Type.Union([Type.Literal("approved"), Type.Literal("removed")]),
  revision: Type.Integer({ minimum: 1 }),
});
export const ProtectedAdminPeopleResponseSchema = node({
  people: Type.Array(ProtectedAdminPersonSchema),
});
export const ProtectedOwnerActionResponseSchema = node({
  request: ProtectedPublicAccessRequestSchema,
  policy: Type.Optional(
    Type.Union([Type.Literal("sync_pending"), Type.Literal("removal_pending")]),
  ),
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
  // A reply that this signed-in session started and that is still running on the server.
  activeRun: Type.Optional(node({ id })),
});
export const ProtectedCreateChatSchema = node({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
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
export type ProtectedTurnEvent = Static<typeof ProtectedTurnEventSchema>;
export type ProtectedTurnRequest = Static<typeof ProtectedTurnRequestSchema>;
export type ProtectedChat = Static<typeof ProtectedChatSchema>;
export type ProtectedChatSummary = Static<typeof ProtectedChatSummarySchema>;
export type ProtectedMessage = Static<typeof ProtectedMessageSchema>;
export type ProtectedModel = Static<typeof ProtectedModelSchema>;
export type ProtectedMe = Static<typeof ProtectedMeSchema>;
export type ProtectedAccessRequestStatus = Static<typeof ProtectedAccessRequestStatusSchema>;
export type ProtectedPublicAccessRequest = Static<typeof ProtectedPublicAccessRequestSchema>;
export type ProtectedAccessRequestSubmit = Static<typeof ProtectedAccessRequestSubmitSchema>;
export type ProtectedAccessRequestEdit = Static<typeof ProtectedAccessRequestEditSchema>;
export type ProtectedAccessRequestReceiptResult = Static<
  typeof ProtectedAccessRequestReceiptResultSchema
>;
export type ProtectedAccessRequestStatusResponse = Static<
  typeof ProtectedAccessRequestStatusResponseSchema
>;
export type ProtectedAdminRequest = Static<typeof ProtectedAdminRequestSchema>;
export type ProtectedAdminRequestsResponse = Static<typeof ProtectedAdminRequestsResponseSchema>;
export type ProtectedAdminPerson = Static<typeof ProtectedAdminPersonSchema>;
export type ProtectedAdminPeopleResponse = Static<typeof ProtectedAdminPeopleResponseSchema>;
export type ProtectedOwnerActionResponse = Static<typeof ProtectedOwnerActionResponseSchema>;
export type ProtectedDevicePrompt = Static<typeof ProtectedDevicePromptSchema>;
export type ProtectedDevicePoll = Static<typeof ProtectedDevicePollSchema>;
export const isProtectedTurnRequest = (value: unknown): value is ProtectedTurnRequest =>
  Value.Check(ProtectedTurnRequestSchema, value);
export const isProtectedCreateChat = (
  value: unknown,
): value is Static<typeof ProtectedCreateChatSchema> =>
  Value.Check(ProtectedCreateChatSchema, value);
export const isProtectedSteer = (value: unknown): value is Static<typeof ProtectedSteerSchema> =>
  Value.Check(ProtectedSteerSchema, value);
export const isProtectedRenew = (value: unknown): value is Static<typeof ProtectedRenewSchema> =>
  Value.Check(ProtectedRenewSchema, value);
