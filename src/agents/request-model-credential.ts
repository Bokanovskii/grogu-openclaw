import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { holdSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createRequestSecretSentinel } from "../secrets/sentinel.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

const brand = Symbol("requestModelCredential");
// Declarations must reference this interface by name; an aliased object type can expand to the private brand.
export interface RequestModelCredential {
  readonly [brand]: true;
}
type Credential = {
  provider: string;
  model: string;
  accountModel?: { baseUrl: string; definition: ModelDefinitionConfig };
  accessToken: string;
  expiresAt?: number;
  assertCurrent: () => void;
};
const credentials = new WeakMap<RequestModelCredential, Credential & { sentinel: string }>();

/** Host-only capability. Neither the token nor renewal material is serialized in run parameters. */
export function createRequestModelCredential(input: Credential) {
  if (!input.accessToken || !input.provider || !input.model) {
    throw new TypeError("A request credential requires an exact provider and model.");
  }
  if (input.accountModel && input.accountModel.definition.id !== input.model) {
    throw new TypeError("The account model must match the request credential.");
  }
  const releaseRedaction = holdSecretValueForRedaction(input.accessToken);
  let requestSentinel: ReturnType<typeof createRequestSecretSentinel>;
  try {
    requestSentinel = createRequestSecretSentinel(input.accessToken);
  } catch (error) {
    releaseRedaction();
    throw error;
  }
  const handle: RequestModelCredential = Object.freeze({ [brand]: true as const });
  credentials.set(handle, { ...input, sentinel: requestSentinel.sentinel });
  return {
    handle,
    close() {
      credentials.delete(handle);
      requestSentinel.close();
      releaseRedaction();
    },
  };
}

function readCurrentCredential(handle: RequestModelCredential, provider: string, model: string) {
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
  return credential;
}

/** Apply the account's catalog row only to this execution, never to shared runtime admission. */
export function resolveRequestModelConfig(
  params: { config?: OpenClawConfig; requestModelCredential?: RequestModelCredential },
  provider: string,
  model: string,
): OpenClawConfig | undefined {
  const { config, requestModelCredential } = params;
  if (!requestModelCredential) {
    return config;
  }
  const credential = readCurrentCredential(requestModelCredential, provider, model);
  if (!credential.accountModel) {
    return config;
  }
  const { baseUrl, definition } = credential.accountModel;
  return {
    ...config,
    models: {
      ...config?.models,
      providers: {
        ...config?.models?.providers,
        [credential.provider]: { baseUrl, models: [definition] },
      },
    },
  };
}

export function resolveRequestModelCredential(
  handle: RequestModelCredential,
  provider: string,
  model: string,
): ResolvedProviderAuth {
  const credential = readCurrentCredential(handle, provider, model);
  return {
    apiKey: credential.sentinel,
    mode: provider === "openai" ? "oauth" : provider === "github-copilot" ? "token" : "api-key",
    source: "request-only",
  };
}
