import { Type, type Static } from "typebox";

const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

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
  revision: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
});

export type ProtectedMemoryNote = Static<typeof ProtectedMemoryNoteSchema>;
export type ProtectedMemoryListResponse = Static<typeof ProtectedMemoryListResponseSchema>;
export type ProtectedMemoryReadResponse = Static<typeof ProtectedMemoryReadResponseSchema>;
