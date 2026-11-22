import { Type, type Static } from "typebox";
import { ProtectedMessageSchema } from "./protected.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ProtectedShareKindSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("file"),
  Type.Literal("page"),
]);
export const ProtectedShareSnapshotSchema = Type.Union([
  node({
    kind: Type.Literal("chat"),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    chat: node({
      id,
      title: Type.String(),
      version: Type.String(),
      updatedAt: Type.Number(),
      selectedAgentId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" })),
      messages: Type.Array(ProtectedMessageSchema),
    }),
  }),
  node({
    kind: Type.Literal("file"),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    fileName: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    contentBase64: Type.String(),
  }),
  node({
    kind: Type.Literal("page"),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    html: Type.String(),
    cspSandbox: Type.Literal("scripts"),
  }),
]);
export const ProtectedShareListEntrySchema = node({
  grantId: id,
  resourceId: id,
  kind: ProtectedShareKindSchema,
  routeId: id,
  ownerProfileId: id,
  recipientProfileId: id,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  sharedAt: Type.Integer({ minimum: 0 }),
});
export const ProtectedShareListResponseSchema = node({
  shares: Type.Array(ProtectedShareListEntrySchema),
});
export const ProtectedShareCreateRequestSchema = node({
  kind: ProtectedShareKindSchema,
  routeId: id,
  recipientProfileIds: Type.Array(id, { minItems: 1, uniqueItems: true }),
});
export const ProtectedShareCreateResponseSchema = node({
  resourceId: id,
  routeId: id,
  grants: Type.Array(
    node({
      grantId: id,
      recipientProfileId: id,
    }),
  ),
});
export const ProtectedShareContentResponseSchema = node({
  resourceId: id,
  snapshot: ProtectedShareSnapshotSchema,
});

export type ProtectedShareKind = Static<typeof ProtectedShareKindSchema>;
export type ProtectedShareSnapshot = Static<typeof ProtectedShareSnapshotSchema>;
export type ProtectedShareListEntry = Static<typeof ProtectedShareListEntrySchema>;
export type ProtectedShareListResponse = Static<typeof ProtectedShareListResponseSchema>;
export type ProtectedShareCreateRequest = Static<typeof ProtectedShareCreateRequestSchema>;
export type ProtectedShareCreateResponse = Static<typeof ProtectedShareCreateResponseSchema>;
export type ProtectedShareContentResponse = Static<typeof ProtectedShareContentResponseSchema>;
