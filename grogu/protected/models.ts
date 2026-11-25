import { createHash } from "node:crypto";
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
import { LruCache } from "../../src/infra/lru-cache.js";
import {
  DEFAULT_GITHUB_COPILOT_DOMAIN,
  normalizeGithubCopilotDomain,
  parseGithubCopilotBoundToken,
} from "../../src/plugin-sdk/github-copilot-domain.js";
import { LiveModelCatalogHttpError } from "../../src/plugin-sdk/provider-catalog-live-runtime.js";
import { ProtectedError } from "./errors.js";

type CopilotApi = Pick<
  typeof import("../../extensions/github-copilot/api.js"),
  | "resolveCopilotRuntimeAuth"
  | "CopilotRuntimeAuthError"
  | "fetchCopilotModelCatalog"
  | "isCopilotCatalogModelVisible"
  | "getCopilotCatalogVendor"
  | "getCopilotCatalogContextSizes"
>;
type CatalogModel = Awaited<ReturnType<CopilotApi["fetchCopilotModelCatalog"]>>[number];
export type ProtectedCopilotModel = {
  model: ProtectedModel;
  definition: CatalogModel;
  baseUrl: string;
};

// Only GitHub's public account-tier endpoints can receive a parallel probe. Tenant-specific
// credentials and alternate endpoints always wait for fresh GitHub account discovery.
const publicTierEndpoints = new Set([
  "https://api.individual.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
]);

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
  const preferred = levels.includes("medium") ? "medium" : resolveThinkingDefaultForModel(params);
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

export function createProtectedCopilotModelLookup(
  loadApi: () => Promise<CopilotApi> = () => import("../../extensions/github-copilot/api.js"),
) {
  const routes = new LruCache<{ baseUrl: string; until: number }>(64);
  return async function fetchProtectedCopilotModels(
    credential: { accessToken: string; expiresAt?: number },
    authority: { profileId: string; signal: AbortSignal; revalidate: () => Promise<void> },
    options?: {
      includeVendor?: boolean;
      includeContextSizes?: boolean;
      note?: (name: "copilotAccountMs" | "copilotCatalogMs", ms: number) => void;
    },
  ): Promise<ProtectedCopilotModel[]> {
    const assertCredential = () => {
      authority.signal.throwIfAborted();
      if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
        throw new ProtectedError(
          401,
          "provider_credential_expired",
          "Reconnect or renew this provider first.",
        );
      }
    };
    assertCredential();
    let bound: ReturnType<typeof parseGithubCopilotBoundToken>;
    try {
      bound = parseGithubCopilotBoundToken(credential.accessToken);
    } catch {
      throw new ProtectedError(401, "provider_auth_failed", "Reconnect this provider first.");
    }
    const api = await loadApi();
    const githubToken = bound?.token ?? credential.accessToken;
    let key: string | undefined;
    const probe = new AbortController();
    try {
      await authority.revalidate();
      assertCredential();
      const domain =
        bound?.githubDomain ?? normalizeGithubCopilotDomain(process.env.COPILOT_GITHUB_DOMAIN);
      if (domain === DEFAULT_GITHUB_COPILOT_DOMAIN) {
        key = createHash("sha256")
          .update(JSON.stringify([authority.profileId, credential.accessToken]))
          .digest("hex");
      }
      const readCatalog = async (baseUrl: string, apiKey: string, signal: AbortSignal) => {
        const start = performance.now();
        const catalog = await api.fetchCopilotModelCatalog({
          baseUrl,
          copilotApiToken: apiKey,
          signal,
        });
        return { catalog, ms: performance.now() - start };
      };
      const hint = key && routes.get(key);
      const priorUrl = hint && hint.until > Date.now() ? hint.baseUrl : undefined;
      const early = priorUrl
        ? readCatalog(priorUrl, githubToken, AbortSignal.any([authority.signal, probe.signal]))
        : undefined;
      // A catalog failure must not mask an account denial or a move to a different endpoint.
      void early?.catch(() => {});
      const authStart = performance.now();
      const auth = await api
        .resolveCopilotRuntimeAuth({
          githubToken,
          ...(bound && { boundGithubDomain: bound.githubDomain }),
          signal: authority.signal,
        })
        .finally(() => options?.note?.("copilotAccountMs", performance.now() - authStart));
      await authority.revalidate();
      assertCredential();
      const matched = early && priorUrl === auth.baseUrl && githubToken === auth.apiKey;
      if (!matched) {
        probe.abort();
      }
      const { catalog, ms } = await (matched
        ? early
        : readCatalog(auth.baseUrl, auth.apiKey, authority.signal));
      options?.note?.("copilotCatalogMs", ms);
      await authority.revalidate();
      assertCredential();
      if (key && publicTierEndpoints.has(auth.baseUrl)) {
        routes.set(key, {
          baseUrl: auth.baseUrl,
          until: Math.min(Date.now() + 5 * 60_000, credential.expiresAt ?? Infinity),
        });
      } else if (key) {
        routes.delete(key);
      }
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
      if (key) {
        routes.delete(key);
      }
      await authority.revalidate();
      assertCredential();
      if (error instanceof ProtectedError) {
        throw error;
      }
      if (
        (error instanceof api.CopilotRuntimeAuthError ||
          error instanceof LiveModelCatalogHttpError) &&
        (error.status === 401 || error.status === 403)
      ) {
        throw new ProtectedError(401, "provider_auth_failed", "Reconnect this provider first.");
      }
      throw new ProtectedError(502, "provider_failed", "The model list could not be loaded.");
    } finally {
      probe.abort();
    }
  };
}
