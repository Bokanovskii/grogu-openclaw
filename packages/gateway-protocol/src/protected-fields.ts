import { Type, type TProperties } from "typebox";

export const id = Type.String({ minLength: 1, maxLength: 256 });
export const protectedAgentId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" });
export const node = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
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
