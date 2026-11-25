import type { PreparedModelRuntimeInput } from "../../src/agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

type TurnRuntimeScope = {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
};

/**
 * The prepared runtime a protected turn requests for one model. The prepared-runtime owner keys on
 * every field here, so turns and the startup warm-up must build the request in this one place.
 */
export function protectedTurnRuntimeInput(
  scope: TurnRuntimeScope,
  provider: string,
  modelId: string,
): PreparedModelRuntimeInput {
  return {
    ...scope,
    allowGatewaySubagentBinding: false,
    runtimePluginSelections: [{ provider, modelId, runtime: "openclaw" }],
  };
}

const warmupBudgetMs = 60_000;

/**
 * Builds each model's runtime before the listener opens. The first request for a model otherwise
 * compiles its plugins on the main thread, which freezes every request in the process for seconds.
 * A build cannot be interrupted, so the budget is checked between models; list the most used first.
 * A failed or skipped warm-up costs only that model's first request, so it never stops startup.
 */
export async function warmProtectedTurnRuntimes(
  scope: TurnRuntimeScope,
  models: readonly { provider: string; id: string }[],
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<{ warmed: number; failed: number; skipped: number }> {
  const { budgetMs = warmupBudgetMs, now = () => performance.now() } = options;
  const startedAt = now();
  const result = { warmed: 0, failed: 0, skipped: 0 };
  for (const model of models) {
    if (now() - startedAt >= budgetMs) {
      result.skipped += 1;
      continue;
    }
    try {
      const { acquireAgentRunPreparedModelRuntime } =
        await import("../../src/agents/prepared-model-runtime.js");
      await using _ = await acquireAgentRunPreparedModelRuntime(
        protectedTurnRuntimeInput(scope, model.provider, model.id),
        { catalogMode: "static" },
      );
      result.warmed += 1;
    } catch (error) {
      result.failed += 1;
      process.stderr.write(
        `Protected runtime warm-up failed for ${model.provider} (${error instanceof Error ? error.name : "Error"}); its first request will build it.\n`,
      );
    }
  }
  console.info(
    "[protected-runtime-warmup]",
    JSON.stringify({ ...result, ms: Math.round(now() - startedAt) }),
  );
  return result;
}
