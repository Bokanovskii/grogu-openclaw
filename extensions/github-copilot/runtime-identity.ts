import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

// GitHub's current fine-grained PAT contract is the Copilot CLI identity.
// Keep this provider-owned instead of changing the legacy public SDK constant.
const COPILOT_RUNTIME_INTEGRATION_ID = "copilot-developer-cli";

/** Keep public defaults separate from caller-provided headers. */
export function buildCopilotRuntimeHeaderParts(params?: {
  config?: OpenClawConfig;
  headers?: Record<string, string>;
  previousPublicHeaders?: Readonly<Record<string, string>>;
}): { publicHeaders: Record<string, string>; headers: Record<string, string> } {
  const provider = params?.config?.models?.providers?.["github-copilot"];
  const modelHeaders = Object.fromEntries(
    Object.entries(params?.headers ?? {}).filter(
      ([name, value]) => params?.previousPublicHeaders?.[name] !== value,
    ),
  );
  let integrationId: string | undefined;
  for (const headers of [provider?.headers, provider?.request?.headers, modelHeaders]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "copilot-integration-id") {
        integrationId =
          normalizeResolvedSecretInputString({
            value,
            path: "models.providers.github-copilot.headers.Copilot-Integration-Id",
          }) ?? integrationId;
      }
    }
  }
  // HTTP header names are case-insensitive. Remove every authored spelling so
  // native Headers/SDK merging cannot turn the identity into a comma-joined pair.
  const headers = Object.fromEntries(
    Object.entries(modelHeaders).filter(
      ([name]) => name.toLowerCase() !== "copilot-integration-id",
    ),
  );
  const publicHeaders: Record<string, string> = {
    ...buildCopilotIdeHeaders(),
    "Openai-Organization": "github-copilot",
    ...(!integrationId ? { "Copilot-Integration-Id": COPILOT_RUNTIME_INTEGRATION_ID } : {}),
  };
  for (const name of Object.keys(headers)) {
    delete publicHeaders[name];
  }
  return {
    publicHeaders,
    headers: {
      ...headers,
      ...(integrationId ? { "Copilot-Integration-Id": integrationId } : {}),
    },
  };
}

/** Keep catalog and inference identity aligned without forwarding unrelated configured secrets. */
export function buildCopilotRuntimeHeaders(params?: {
  config?: OpenClawConfig;
  headers?: Record<string, string>;
}): Record<string, string> {
  const parts = buildCopilotRuntimeHeaderParts(params);
  return { ...parts.publicHeaders, ...parts.headers };
}
