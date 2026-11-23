import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ProtectedAutomationRecordSchema,
  ProtectedChatSchema,
  type ProtectedAutomationRecord,
} from "./protected.js";

// sharing-v1 shapes are sent only to requests that list that capability.
const id = Type.String({ minLength: 1, maxLength: 256 });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const shareId = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
export const ProtectedSharePersonSchema = node({ personId: id, displayName: Type.String() });
export const ProtectedChatShareSchema = node({
  id: shareId,
  path: Type.String({ pattern: "^/s/[A-Za-z0-9_-]{43}$" }),
  createdAt: Type.Integer({ minimum: 0 }),
  recipients: Type.Array(
    node({ ...ProtectedSharePersonSchema.properties, grantedAt: Type.Integer({ minimum: 0 }) }),
  ),
});
export const ProtectedChatShareResponseSchema = node({
  share: Type.Union([ProtectedChatShareSchema, Type.Null()]),
});
export const ProtectedSharedChatSummarySchema = node({
  id,
  title: Type.String(),
  updatedAt: Type.Number(),
  owner: ProtectedSharePersonSchema,
});
export const ProtectedShareClaimResponseSchema = node({
  access: Type.Union([Type.Literal("owner"), Type.Literal("recipient")]),
  chat: ProtectedSharedChatSummarySchema,
});
export const ProtectedSharedChatsResponseSchema = node({
  chats: Type.Array(ProtectedSharedChatSummarySchema),
});
export const ProtectedSharedChatResponseSchema = node({
  chat: ProtectedChatSchema,
  owner: ProtectedSharePersonSchema,
});
// automations-public-v1 shapes. Owners see a follower count, never follower identities.
const automation = ProtectedAutomationRecordSchema.properties;
export const ProtectedPublicAutomationSchema = node({
  id: automation.id,
  name: automation.name,
  instructions: automation.instructions,
  whenToNotify: automation.whenToNotify,
  doneWhen: automation.doneWhen,
  schedule: automation.schedule,
  state: automation.state,
  nextCheckAt: automation.nextCheckAt,
  owner: ProtectedSharePersonSchema,
  publishedAt: Type.Integer({ minimum: 0 }),
  followers: Type.Integer({ minimum: 0 }),
  following: Type.Boolean(),
  subscribed: Type.Boolean(),
});
export const ProtectedPublicAutomationsResponseSchema = node({
  automations: Type.Array(ProtectedPublicAutomationSchema),
});
export const ProtectedPublicAutomationResponseSchema = node({
  automation: ProtectedPublicAutomationSchema,
});
export const ProtectedAutomationFollowRequestSchema = node({
  subscribed: Type.Optional(Type.Boolean()),
});
export const ProtectedAutomationNotificationsRequestSchema = node({ subscribed: Type.Boolean() });
export type ProtectedSharePerson = Static<typeof ProtectedSharePersonSchema>;
export type ProtectedChatShare = Static<typeof ProtectedChatShareSchema>;
export type ProtectedChatShareResponse = Static<typeof ProtectedChatShareResponseSchema>;
export type ProtectedSharedChatSummary = Static<typeof ProtectedSharedChatSummarySchema>;
export type ProtectedShareClaimResponse = Static<typeof ProtectedShareClaimResponseSchema>;
export type ProtectedSharedChatsResponse = Static<typeof ProtectedSharedChatsResponseSchema>;
export type ProtectedSharedChatResponse = Static<typeof ProtectedSharedChatResponseSchema>;
export type ProtectedAutomationPublication = NonNullable<ProtectedAutomationRecord["publication"]>;
export type ProtectedPublicAutomation = Static<typeof ProtectedPublicAutomationSchema>;
export type ProtectedPublicAutomationsResponse = Static<
  typeof ProtectedPublicAutomationsResponseSchema
>;
export type ProtectedPublicAutomationResponse = Static<
  typeof ProtectedPublicAutomationResponseSchema
>;
export type ProtectedAutomationFollowRequest = Static<
  typeof ProtectedAutomationFollowRequestSchema
>;
export type ProtectedAutomationNotificationsRequest = Static<
  typeof ProtectedAutomationNotificationsRequestSchema
>;
export const isProtectedAutomationFollowRequest = (
  value: unknown,
): value is ProtectedAutomationFollowRequest =>
  Value.Check(ProtectedAutomationFollowRequestSchema, value);
export const isProtectedAutomationNotificationsRequest = (
  value: unknown,
): value is ProtectedAutomationNotificationsRequest =>
  Value.Check(ProtectedAutomationNotificationsRequestSchema, value);
