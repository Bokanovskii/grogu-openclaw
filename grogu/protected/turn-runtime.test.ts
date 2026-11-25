import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import type { PreparedModelRuntimeInput } from "../../src/agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

type Lease = { input: PreparedModelRuntimeInput; options: unknown; released: boolean };

// The real owner builds plugins for seconds, so the subject runs over a stand-in that records each
// lease and its release. The mock goes in before the subject loads, which only imports it lazily.
const leases: Lease[] = [];
let failingProvider: string | undefined;
const mocked = mock.module("../../src/agents/prepared-model-runtime.js", {
  exports: {
    acquireAgentRunPreparedModelRuntime: async (
      input: PreparedModelRuntimeInput,
      options: unknown,
    ) => {
      if (input.runtimePluginSelections?.[0]?.provider === failingProvider) {
        throw new Error("sk-live-secret from the provider");
      }
      const lease: Lease = { input, options, released: false };
      leases.push(lease);
      return {
        [Symbol.asyncDispose]: async () => {
          lease.released = true;
        },
      };
    },
  },
});
after(() => mocked.restore());
const { warmProtectedTurnRuntimes } = await import("./turn-runtime.js");

const config: OpenClawConfig = {};
const scope = {
  config,
  agentId: "protected",
  agentDir: "/state/agents/protected/agent",
  workspaceDir: "/state/workspace",
};

beforeEach(() => {
  leases.length = 0;
  failingProvider = undefined;
});

test("warming requests the runtime a protected turn requests, once per model, and releases it", async (t) => {
  t.mock.method(console, "info", () => {});
  const result = await warmProtectedTurnRuntimes(scope, [
    { provider: "sparky", id: "qwen" },
    { provider: "github-copilot", id: "gpt" },
  ]);
  assert.deepEqual(result, { warmed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(
    leases.map(({ input }) => input),
    [
      {
        ...scope,
        allowGatewaySubagentBinding: false,
        runtimePluginSelections: [{ provider: "sparky", modelId: "qwen", runtime: "openclaw" }],
      },
      {
        ...scope,
        allowGatewaySubagentBinding: false,
        runtimePluginSelections: [
          { provider: "github-copilot", modelId: "gpt", runtime: "openclaw" },
        ],
      },
    ],
  );
  assert.deepEqual(
    leases.map(({ options }) => options),
    [{ catalogMode: "static" }, { catalogMode: "static" }],
  );
  assert.deepEqual(
    leases.map(({ released }) => released),
    [true, true],
  );
});

test("a model that fails to warm never stops the rest or leaks its error", async (t) => {
  t.mock.method(console, "info", () => {});
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  failingProvider = "github-copilot";
  const result = await warmProtectedTurnRuntimes(scope, [
    { provider: "sparky", id: "qwen" },
    { provider: "github-copilot", id: "gpt" },
    { provider: "openai", id: "luna" },
  ]);
  assert.deepEqual(result, { warmed: 2, failed: 1, skipped: 0 });
  assert.deepEqual(
    leases.map(({ input }) => input.runtimePluginSelections?.[0]?.provider),
    ["sparky", "openai"],
  );
  assert.equal(
    written.join("").includes("sk-live-secret"),
    false,
    "the provider's error text must stay out of stderr",
  );
  assert.deepEqual(
    written.filter((line) => line.startsWith("Protected runtime warm-up")),
    [
      "Protected runtime warm-up failed for github-copilot (Error); its first request will build it.\n",
    ],
  );
});

test("no new build starts once the warm-up budget is spent", async (t) => {
  t.mock.method(console, "info", () => {});
  let clock = 0;
  const result = await warmProtectedTurnRuntimes(
    scope,
    [
      { provider: "sparky", id: "qwen" },
      { provider: "github-copilot", id: "gpt" },
      { provider: "openai", id: "luna" },
    ],
    { budgetMs: 60_000, now: () => (clock += 40_000) },
  );
  assert.deepEqual(result, { warmed: 1, failed: 0, skipped: 2 });
  assert.deepEqual(
    leases.map(({ input }) => input.runtimePluginSelections?.[0]?.provider),
    ["sparky"],
  );
});
