import { Type, type Static } from "typebox";

const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const origin = Type.String({ maxLength: 300 });
const displayOrigin = Type.String({ maxLength: 600 });

/** Sent only to clients that negotiated `browser-handoff-v2`; origins are server-derived. */
export const ProtectedBrowserHandoffSchema = node({
  id: Type.String({ pattern: "^[A-Za-z0-9_-]{22}$" }),
  state: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("active"),
    Type.Literal("origin-changed"),
    Type.Literal("returned"),
    Type.Literal("cancelled"),
    Type.Literal("expired"),
    Type.Literal("revoked"),
  ]),
  mode: Type.Literal("fresh"),
  origin: Type.Union([origin, Type.Null()]),
  displayOrigin: Type.Union([displayOrigin, Type.Null()]),
  expiresAt: Type.Integer({ minimum: 0 }),
});
export type ProtectedBrowserHandoff = Static<typeof ProtectedBrowserHandoffSchema>;

export const ProtectedBrowserHandoffClaimResponseSchema = node({
  controller: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  origin,
  displayOrigin,
  viewport: node({ width: Type.Literal(1280), height: Type.Literal(800) }),
  expiresAt: Type.Integer({ minimum: 0 }),
});
export type ProtectedBrowserHandoffClaimResponse = Static<
  typeof ProtectedBrowserHandoffClaimResponseSchema
>;
