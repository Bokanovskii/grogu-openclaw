import { resolveAnthropicThinkingEffort } from "@openclaw/ai/internal/anthropic";
import type { ProtectedModel } from "@openclaw/gateway-protocol/protected";
import { mapThinkingLevel } from "../../src/agents/embedded-agent-runner/utils.js";
import {
  resolveNativeThinkingChoices,
  resolveThinkingDefaultForModel,
  resolveThinkingProfile,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../../src/auto-reply/thinking.js";
import { parseGithubCopilotBoundToken } from "../../src/plugin-sdk/github-copilot-domain.js";
import { LiveModelCatalogHttpError } from "../../src/plugin-sdk/provider-catalog-live-runtime.js";
import { ProtectedError } from "./errors.js";

type CatalogModel = Awaited<
  ReturnType<typeof import("../../extensions/github-copilot/api.js").fetchCopilotModelCatalog>
>[number];

export function withThinking(model: ProtectedModel, catalogEntry?: ThinkingCatalogEntry) {
  if (!catalogEntry && model.thinking) {
    return model;
  }
  const catalog = catalogEntry ? [catalogEntry] : undefined;
  const params = { provider: model.provider, model: model.id, catalog, agentRuntime: "openclaw" };
  const profile = resolveThinkingProfile(params);
  const efforts = catalogEntry?.compat?.supportedReasoningEfforts;
  const levels = profile.levels
    .map(({ id }) => id)
    .filter((id) => {
      if (!efforts || id === "off" || id === "ultra") {
        return true;
      }
      const mapped =
        catalogEntry?.thinkingLevelMap?.[id as Exclude<ThinkLevel, "adaptive" | "ultra">];
      return efforts.includes(mapped ?? id);
    });
  const preferred = model.provider === "sparky" ? "ultra" : resolveThinkingDefaultForModel(params);
  const defaultLevel = levels.includes(preferred) ? preferred : (levels[0] ?? "off");
  const nativeChoices = resolveNativeThinkingChoices({
    ...params,
    levels,
    mapLevel: mapThinkingLevel,
    ...(catalogEntry?.api === "anthropic-messages" && catalogEntry.reasoning
      ? {
          mapEffort: (level: Exclude<ThinkLevel, "ultra" | "adaptive">) =>
            resolveAnthropicThinkingEffort(
              {
                id: catalogEntry.id,
                provider: catalogEntry.provider,
                api: "anthropic-messages",
                reasoning: catalogEntry.reasoning === true,
                thinkingLevelMap: catalogEntry.thinkingLevelMap,
                params: catalogEntry.params,
              },
              level,
            ),
        }
      : {}),
  });
  return {
    ...model,
    thinking: {
      levels,
      default: defaultLevel,
      ...(nativeChoices ? { nativeChoices } : {}),
      orchestrationLevels: levels.filter((level) => level === "ultra"),
    },
  };
}

export async function fetchProtectedCopilotModels(
  credential: { accessToken: string; expiresAt?: number },
  authority: { signal: AbortSignal; revalidate: () => Promise<void> },
  options?: { includeVendor?: boolean; includeContextSizes?: boolean },
): Promise<Array<{ model: ProtectedModel; definition: CatalogModel; baseUrl: string }>> {
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
    throw new ProtectedError(
      401,
      "provider_credential_expired",
      "Reconnect or renew this provider first.",
    );
  }
  let bound: ReturnType<typeof parseGithubCopilotBoundToken>;
  try {
    bound = parseGithubCopilotBoundToken(credential.accessToken);
  } catch {
    throw new ProtectedError(401, "provider_auth_failed", "Reconnect this provider first.");
  }
  const api = await import("../../extensions/github-copilot/api.js");
  try {
    await authority.revalidate();
    const auth = await api.resolveCopilotRuntimeAuth(
      bound
        ? { githubToken: bound.token, boundGithubDomain: bound.githubDomain }
        : { githubToken: credential.accessToken },
    );
    await authority.revalidate();
    const catalog = await api.fetchCopilotModelCatalog({
      copilotApiToken: auth.apiKey,
      baseUrl: auth.baseUrl,
      signal: authority.signal,
    });
    await authority.revalidate();
    return catalog.filter(api.isCopilotCatalogModelVisible).map((definition) => {
      const vendor = options?.includeVendor ? api.getCopilotCatalogVendor(definition) : undefined;
      const contextSizes = options?.includeContextSizes
        ? api.getCopilotCatalogContextSizes(definition)
        : undefined;
      return {
        model: withThinking(
          {
            provider: "github-copilot",
            id: definition.id,
            label: definition.name,
            ...(vendor ? { vendor } : {}),
            ...(contextSizes ? { contextSizes } : {}),
            ...(definition.contextWindow === undefined
              ? {}
              : { contextWindow: definition.contextWindow }),
          },
          { ...definition, provider: "github-copilot" },
        ),
        definition,
        baseUrl: auth.baseUrl,
      };
    });
  } catch (error) {
    await authority.revalidate();
    if (
      (error instanceof api.CopilotRuntimeAuthError ||
        error instanceof LiveModelCatalogHttpError) &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new ProtectedError(401, "provider_auth_failed", "Reconnect this provider first.");
    }
    throw new ProtectedError(502, "provider_failed", "The model list could not be loaded.");
  }
}
