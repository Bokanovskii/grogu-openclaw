import { z } from "zod";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

export const gmailReadOnlyScope = "https://www.googleapis.com/auth/gmail.readonly";
const secret = z.string().min(1).max(8192);
const timestamp = z.number().int().positive().max(8640000000000000);
const googleClient = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientSecret: secret.optional(),
  redirectUri: z.string().url().max(2048),
});
const gmail = z.strictObject({
  version: z.literal(1),
  generation: z.string().uuid(),
  kind: z.literal("gmail"),
  client: googleClient,
  credential: z
    .strictObject({
      account: z.string().email().max(254),
      accessToken: secret,
      refreshToken: secret,
      expiresAt: timestamp,
      scope: z.literal(gmailReadOnlyScope),
    })
    .optional(),
  pending: z
    .strictObject({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      expiresAt: timestamp,
      claimed: z.boolean(),
    })
    .optional(),
});
const calendar = z.strictObject({
  version: z.literal(1),
  generation: z.string().uuid(),
  kind: z.literal("icloud-calendar"),
  account: z.string().email().max(254),
  password: z.string().regex(/^[a-z]{4}(?:-[a-z]{4}){3}$/u),
});

export const userConnectorSchema = z.discriminatedUnion("kind", [gmail, calendar]);
export type UserConnector = z.infer<typeof userConnectorSchema>;
export type UserConnectorKind = UserConnector["kind"];
export type UserGmailConnector = z.infer<typeof gmail>;

export function parseUserConnector(value: unknown): UserConnector {
  const parsed = userConnectorSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Connector state is invalid. Disconnect and reconnect the connector.");
  }
  const connector = parsed.data;
  if (connector.kind === "gmail") {
    if (connector.client.clientSecret) {
      registerSecretValueForRedaction(connector.client.clientSecret);
    }
    if (connector.credential) {
      registerSecretValueForRedaction(connector.credential.accessToken);
      registerSecretValueForRedaction(connector.credential.refreshToken);
    }
    if (connector.pending) {
      registerSecretValueForRedaction(connector.pending.verifier);
    }
  } else {
    registerSecretValueForRedaction(connector.password);
  }
  return connector;
}

export type UserConnectorCommand = {
  profileId: string;
  kind: UserConnectorKind;
} & (
  | { action: "read" }
  | { action: "replace"; expectedGeneration: string | null; connector: UserConnector }
  | { action: "delete"; expectedGeneration: string | null }
);
