import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "../agents/command/model-ref.js";
import {
  beginModelRequestTelemetry,
  closeModelRequestTelemetry,
  currentHttpRequestTelemetry,
  instrumentModelFetch,
} from "../agents/model-request-telemetry.js";
import { createSparkyAdmission, queueSparkyFetch } from "../agents/sparky-request-queue.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const dispatch = vi.hoisted(() =>
  vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
      _options?: { sessionMutationCommitGuard?: () => void },
    ) => ({ runId: "override-run" }),
  ),
);
vi.mock("./server-plugin-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-plugin-in-process-dispatch.js")>()),
  dispatchGatewayMethodInProcess: dispatch,
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) =>
    params.provider !== "fixture"
      ? undefined
      : params.context.modelId === "literal"
        ? "permitted"
        : params.context.modelId === "permitted"
          ? "different"
          : undefined,
}));
vi.mock("../agents/grogu-private-profile.js", () => ({
  loadGroguPrivateProfile: () => ({ schemaVersion: 1, bindings: {} }),
}));
vi.mock("../agents/model-request-telemetry-store.js", () => ({
  resolveModelTelemetryDirectory: () => "/synthetic/telemetry",
  createRequestTelemetryClient: () => ({
    write: () => {},
    droppedWrites: 0,
    close: async () => {},
  }),
}));

let config: OpenClawConfig;

beforeEach(() => {
  dispatch.mockClear();
  config = {
    agents: { entries: { worker: { model: "fixture/literal" } } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          models: [
            {
              id: "literal",
              name: "Literal",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    plugins: {
      entries: {
        "override-fixture": {
          subagent: { allowModelOverride: true, allowedModels: ["fixture/permitted"] },
        },
      },
    },
  };
});

afterEach(async () => {
  await closeModelRequestTelemetry();
  vi.useRealTimers();
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

function run(override: { provider?: string; model?: string }) {
  setRuntimeConfigSnapshot(config);
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const runtime = createGatewaySubagentRuntime(
    () => context,
    resolvePluginSubagentOverridePolicies(config),
  );
  return withPluginRuntimePluginScope({ pluginId: "override-fixture" }, () =>
    runtime.run({
      sessionKey: "agent:worker:subagent:override",
      message: "Use the selected model",
      ...override,
    }),
  );
}

describe("plugin subagent initial override policy", () => {
  it("keeps automatic Main handoffs out of Sparky's human priority despite a UUID and user trigger", async () => {
    vi.useFakeTimers();
    config.plugins = {
      entries: { "research-topics": { subagent: { allowModelOverride: true } } },
    };
    const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
    const runtime = createGatewaySubagentRuntime(
      () => context,
      resolvePluginSubagentOverridePolicies(config),
    );
    const model = makeProviderModelFixture({
      api: "openai-completions",
      id: "synthetic",
      provider: "sparky",
      baseUrl: "https://queue.example.invalid/v1",
    });
    const pool = createSparkyAdmission();
    const releaseBackground = await pool.acquire(undefined, "scheduled");
    const classes: Array<string | undefined> = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      classes.push(currentHttpRequestTelemetry()?.record.workClass);
      return new Response(null);
    });
    const transport = instrumentModelFetch(model, queueSparkyFetch(model, fetcher, { pool }));
    const dispatched = createDeferred();
    dispatch.mockImplementationOnce(async (_method, params) => {
      const tracker = beginModelRequestTelemetry({
        sessionId: "00000000-0000-4000-8000-000000000001",
        sessionKey: "agent:main:main",
        trigger: "user",
        inputProvenance: normalizeInputProvenance(params.inputProvenance),
      });
      const response = tracker.run(() => transport("https://queue.example.invalid"));
      dispatched.resolve();
      await response;
      tracker.finish({ outcome: "success" });
      return { runId: "override-run" };
    });
    const handoff = {
      sessionKey: "agent:main:main",
      message: "An automatic research finding",
      model: "sparky/synthetic",
      deliver: false,
      inputProvenance: { kind: "external_user" },
    };
    const automatic = withPluginRuntimePluginScope({ pluginId: "research-topics" }, () =>
      runtime.run(handoff),
    );
    await dispatched.promise;
    expect(fetcher).not.toHaveBeenCalled();
    expect(pool.waiting).toBe(1);
    const human = beginModelRequestTelemetry({
      sessionId: "00000000-0000-4000-8000-000000000002",
      trigger: "user",
      inputProvenance: { kind: "external_user" },
    });
    await human.run(() => transport("https://queue.example.invalid"));
    human.finish({ outcome: "success" });
    expect(classes).toEqual(["interactive"]);
    expect(pool.waiting).toBe(1);
    releaseBackground();
    await automatic;
    expect(classes).toEqual(["interactive", "scheduled"]);
    expect(pool.activeCount).toBe(0);
  });

  it("checks the exact configured execution target", async () => {
    await expect(run({ provider: "fixture", model: "literal" })).rejects.toThrow(
      /not allowlisted/u,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves an explicit API owner without configured model rows", async () => {
    config.models!.providers!.fixture!.api = "openai-completions";
    config.models!.providers!.fixture!.models = [];
    await expect(run({ model: "fixture/literal" })).rejects.toThrow(/not allowlisted/u);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "preserves command selection for %j with chained aliases",
    async (override) => {
      config.models!.providers!.fixture!.models = [];
      await expect(run(override)).resolves.toMatchObject({ runId: "override-run" });
      const request = dispatch.mock.calls[0]?.[1];
      expect(request).toMatchObject(override);
      const model = request?.model as string;
      const selected = request?.provider
        ? normalizeAgentCommandModelRef(config, request.provider as string, model, {})
        : parseAgentCommandModelRef(config, "worker", model, "", {});
      expect(selected).toEqual({ provider: "fixture", model: "permitted" });
    },
  );

  it("rejects a replaced configuration before admitting its prepared override", async () => {
    config.models!.providers!.fixture!.models = [];
    const pending = run({ provider: "fixture", model: "literal" });
    config = { ...config };
    await expect(pending).rejects.toThrow(/configuration changed before admission/u);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
