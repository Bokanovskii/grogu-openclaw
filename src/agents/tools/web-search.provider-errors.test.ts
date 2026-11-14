import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderPlugin,
} from "../../plugins/web-provider-types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { executeWebSearchCandidates } from "../../web-search/runtime-execution.js";
import type { RunWebSearchParams } from "../../web-search/runtime-types.js";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({ runWebSearch: vi.fn(), endpoint: vi.fn() }));
vi.mock("../../web-search/runtime.js", () => ({ runWebSearch: mocks.runWebSearch }));
vi.mock("./web-guarded-fetch.js", () => ({ withTrustedWebToolsEndpoint: mocks.endpoint }));

const API_KEY = "pplx-synthetic-search-status-key";
const BODY = `private upstream diagnostic for ${API_KEY}`;
const config: OpenClawConfig = {
  tools: { web: { search: { provider: "perplexity" } } },
  plugins: { entries: { perplexity: { config: { webSearch: { apiKey: API_KEY } } } } },
};
let provider: PluginWebSearchProviderEntry;
let duckduckgo: PluginWebSearchProviderEntry;

beforeAll(async () => {
  const facade = await loadBundledPluginFacade<{
    createPerplexityWebSearchProvider: () => WebSearchProviderPlugin;
  }>({
    pluginId: "perplexity",
    artifactBasename: "web-search-provider.js",
  });
  provider = { ...facade.createPerplexityWebSearchProvider(), pluginId: "perplexity" };
  const duckduckgoFacade = await loadBundledPluginFacade<{
    createDuckDuckGoWebSearchProvider: () => WebSearchProviderPlugin;
  }>({
    pluginId: "duckduckgo",
    artifactBasename: "web-search-contract-api.js",
  });
  duckduckgo = {
    ...duckduckgoFacade.createDuckDuckGoWebSearchProvider(),
    pluginId: "duckduckgo",
  };
});

beforeEach(() => {
  mocks.endpoint.mockReset();
  mocks.runWebSearch.mockReset().mockImplementation((params: RunWebSearchParams) =>
    executeWebSearchCandidates({
      ...params,
      candidates: [provider],
      searchConfig: { cacheTtlMinutes: 0 },
      allowFallback: false,
    }),
  );
});

it("web_search preserves provider HTTP 403 guidance without exposing the response body", async () => {
  mocks.endpoint.mockImplementationOnce(
    async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) =>
      run({ response: new Response(BODY, { status: 403 }) }),
  );
  const result = await createWebSearchTool({ config })?.execute("search-http-error", {
    query: "synthetic query",
  });

  expect(result?.details).toMatchObject({
    kind: "error",
    provider: "perplexity",
    message: expect.stringContaining("HTTP 403"),
  });
  expect(JSON.stringify(result)).toContain("credentials");
  expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
  expect(JSON.stringify(result)).not.toContain(API_KEY);
});

it.each(["120", "Sat, 14 Nov 2026 12:02:00 GMT"])(
  "web_search exposes DuckDuckGo Retry-After %s without its response body",
  async (retryAfter) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T12:00:00Z"));
    mocks.runWebSearch.mockImplementationOnce((params: RunWebSearchParams) =>
      executeWebSearchCandidates({
        ...params,
        candidates: [duckduckgo],
        searchConfig: { cacheTtlMinutes: 0 },
        allowFallback: false,
      }),
    );
    mocks.endpoint.mockImplementationOnce(
      async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) =>
        run({
          response: new Response(BODY, {
            status: 429,
            headers: { "Retry-After": retryAfter },
          }),
        }),
    );
    try {
      const result = await createWebSearchTool({
        config: { tools: { web: { search: { provider: "duckduckgo" } } } },
      })?.execute("search-retry-after", { query: "synthetic retry delay" });

      expect(result?.details).toMatchObject({
        kind: "error",
        provider: "duckduckgo",
        message: expect.stringContaining("Retry after at least 120 seconds."),
      });
      expect(JSON.stringify(result)).toContain("HTTP 429");
      expect(JSON.stringify(result)).not.toContain(BODY);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(mocks.endpoint).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  },
);

it.each([undefined, 0, -1, Infinity, BODY])(
  "web_search omits an absent or invalid retry delay %s",
  async (retryAfterMs) => {
    mocks.endpoint.mockRejectedValueOnce(
      Object.assign(new Error(BODY), { status: 429, retryAfterMs }),
    );
    const result = await createWebSearchTool({ config })?.execute("search-no-retry-delay", {
      query: "synthetic query",
    });

    expect(result?.details).toMatchObject({
      kind: "error",
      message: expect.stringContaining("HTTP 429"),
    });
    expect(JSON.stringify(result)).not.toContain("Retry after at least");
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  },
);

it.each([
  { timeoutMs: 90_000, message: "Search timed out after 90s." },
  { timeoutMs: 1_250, message: "Search timed out after 1250ms." },
  { timeoutMs: undefined, message: "Search timed out." },
  { timeoutMs: 0, message: "Search timed out." },
  { timeoutMs: BODY, message: "Search timed out." },
])(
  "web_search preserves a provider timeout with budget $timeoutMs without private diagnostics",
  async ({ timeoutMs, message }) => {
    const cause = Object.assign(new Error(BODY), { name: "TimeoutError", timeoutMs });
    mocks.endpoint.mockRejectedValueOnce(cause);

    const result = await createWebSearchTool({ config })?.execute("search-timeout", {
      query: "synthetic query",
    });

    expect(result?.details).toMatchObject({
      kind: "error",
      provider: "perplexity",
      message: expect.stringContaining(message),
    });
    expect(JSON.stringify(result)).not.toContain("configuration");
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  },
);

it("web_search keeps connection failures distinct from deadline expiry", async () => {
  mocks.endpoint.mockRejectedValueOnce(new Error("fetch failed"));
  const result = await createWebSearchTool({ config })?.execute("search-connection-error", {
    query: "synthetic query",
  });

  expect(result?.details).toMatchObject({
    kind: "error",
    provider: "perplexity",
    message: expect.stringContaining("configuration and connection"),
  });
  expect(JSON.stringify(result)).not.toContain("Search timed out");
});
