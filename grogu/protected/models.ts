import type { ProtectedModel } from "@openclaw/gateway-protocol/protected";
import {
  resolveThinkingDefaultForModel,
  resolveThinkingProfile,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../../src/auto-reply/thinking.js";
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
  return { ...model, thinking: { levels, default: defaultLevel } };
}

export async function fetchProtectedCopilotModels(
  credential: { accessToken: string; expiresAt?: number },
  authority: { signal: AbortSignal; revalidate: () => Promise<void> },
): Promise<Array<{ model: ProtectedModel; definition: CatalogModel; baseUrl: string }>> {
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
    throw new ProtectedError(
      401,
      "provider_credential_expired",
      "Reconnect or renew this provider first.",
    );
  }
  const api = await import("../../extensions/github-copilot/api.js");
  try {
    await authority.revalidate();
    const auth = await api.resolveCopilotRuntimeAuth({ githubToken: credential.accessToken });
    await authority.revalidate();
    const catalog = await api.fetchCopilotModelCatalog({
      copilotApiToken: auth.apiKey,
      baseUrl: auth.baseUrl,
      signal: authority.signal,
    });
    await authority.revalidate();
    return catalog.filter(api.isCopilotCatalogModelVisible).map((definition) => ({
      model: withThinking(
        {
          provider: "github-copilot",
          id: definition.id,
          label: definition.name,
          ...(definition.contextWindow === undefined
            ? {}
            : { contextWindow: definition.contextWindow }),
        },
        { ...definition, provider: "github-copilot" },
      ),
      definition,
      baseUrl: auth.baseUrl,
    }));
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
