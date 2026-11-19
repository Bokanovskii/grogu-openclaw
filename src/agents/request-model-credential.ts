import { sealSecretSentinel } from "../secrets/sentinel.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

const brand = Symbol("requestModelCredential");
export type RequestModelCredential = Readonly<{ [brand]: true }>;
type Credential = {
  provider: string;
  model: string;
  accessToken: string;
  expiresAt?: number;
  assertCurrent: () => void;
};
const credentials = new WeakMap<RequestModelCredential, Credential>();

/** Host-only capability. Neither the token nor renewal material is serialized in run parameters. */
export function createRequestModelCredential(input: Credential) {
  if (!input.accessToken || !input.provider || !input.model) {
    throw new TypeError("A request credential requires an exact provider and model.");
  }
  const handle: RequestModelCredential = Object.freeze({ [brand]: true });
  credentials.set(handle, { ...input });
  return {
    handle,
    close() {
      credentials.delete(handle);
    },
  };
}

export function resolveRequestModelCredential(
  handle: RequestModelCredential,
  provider: string,
  model: string,
): ResolvedProviderAuth {
  const credential = credentials.get(handle);
  if (
    !credential ||
    credential.provider !== provider ||
    credential.model !== model ||
    (credential.expiresAt !== undefined && Date.now() >= credential.expiresAt)
  ) {
    throw new Error("Request credential is closed, expired, or belongs to another route.");
  }
  credential.assertCurrent();
  return {
    apiKey: sealSecretSentinel(credential.accessToken, { label: `request-model-auth:${provider}` }),
    mode: provider === "openai" ? "oauth" : provider === "github-copilot" ? "token" : "api-key",
    source: "request-only",
  };
}
