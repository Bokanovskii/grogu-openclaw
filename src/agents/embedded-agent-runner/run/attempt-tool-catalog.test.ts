import { describe, expect, it } from "vitest";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { HostSessionAccess } from "../../tools/scoped-session-access.js";
import { withHostSessionAccess } from "../../tools/scoped-session-access.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const config = { tools: { codeMode: false, toolSearch: false } };
const model = makeProviderModelFixture({
  provider: "openai",
  id: "isolated-session-read",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
});
const genericHostScope: HostSessionAccess = {
  assertCurrent: () => {},
  revalidate: async () => {},
  creatorProfileId: "profile-1",
  resolve: async () => undefined,
};
const isolatedRunHostScope: HostSessionAccess = {
  ...genericHostScope,
  isolatedAutomationRunReads: true,
};

async function prepareToolNames(hostScope?: HostSessionAccess) {
  const toolSurfaceRuntime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    agentId: "main",
    model,
    modelProvider: "openai",
    modelId: model.id,
    modelToolsEnabled: true,
    sessionKey: "agent:main:isolated-run",
    sessionId: "isolated-run",
    runId: "isolated-run",
  });
  const sourceTools = [
    "read",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "memory_search",
  ].map(createStubTool);
  const attempt = {
    config,
    contextIsolation: "isolated",
    model,
    modelId: model.id,
    provider: "openai",
    runId: "isolated-run",
    sessionId: "isolated-run",
  } as unknown as EmbeddedRunAttemptParams;
  const input = {
    attempt,
    setup: {
      effectiveWorkspace: "/workspace",
      getProviderRuntimeHandle: () => undefined,
      sessionAgentId: "main",
    },
    preparedToolBase: {
      codeModeControlsEnabledForRun: false,
      codeModeSkills: [],
      localModelLeanPreserveToolNames: [],
      runtimeCapabilityProfile: { policy: {} },
      toolSearchConfig: toolSurfaceRuntime.plan.toolSearchConfig,
      toolSearchControlsEnabledForRun: false,
      toolsEnabled: true,
      toolSurfaceRuntime,
      toolHookContext: undefined,
    },
    bundleTools: { clientTools: [], uncompactedEffectiveTools: sourceTools },
    abortSignal: new AbortController().signal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
  } as never;
  try {
    const catalog = await (hostScope
      ? withHostSessionAccess(hostScope, () => prepareEmbeddedAttemptToolCatalog(input))
      : prepareEmbeddedAttemptToolCatalog(input));
    return catalog.effectiveTools.map((tool) => tool.name);
  } finally {
    toolSurfaceRuntime.cleanup();
  }
}

describe("prepareEmbeddedAttemptToolCatalog", () => {
  it("keeps isolated session reads unavailable without host scope", async () => {
    expect(await prepareToolNames()).toEqual(["read"]);
  });

  it("keeps isolated session reads unavailable with generic host scope", async () => {
    expect(await prepareToolNames(genericHostScope)).toEqual(["read"]);
  });

  it("exposes only scoped session reads for isolated runs with read authority", async () => {
    expect(await prepareToolNames(isolatedRunHostScope)).toEqual([
      "read",
      "sessions_list",
      "sessions_history",
    ]);
  });
});
