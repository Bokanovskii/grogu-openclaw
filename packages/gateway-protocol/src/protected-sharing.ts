import { Type, type Static } from "typebox";
import { ProtectedChatSchema } from "./protected.js";

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
export type ProtectedSharePerson = Static<typeof ProtectedSharePersonSchema>;
export type ProtectedChatShare = Static<typeof ProtectedChatShareSchema>;
export type ProtectedChatShareResponse = Static<typeof ProtectedChatShareResponseSchema>;
export type ProtectedSharedChatSummary = Static<typeof ProtectedSharedChatSummarySchema>;
export type ProtectedShareClaimResponse = Static<typeof ProtectedShareClaimResponseSchema>;
export type ProtectedSharedChatsResponse = Static<typeof ProtectedSharedChatsResponseSchema>;
export type ProtectedSharedChatResponse = Static<typeof ProtectedSharedChatResponseSchema>;
