/** Confirmed usage and a separate projection of unfinished model responses. */
type AgentRunUsage = {
  outputTokens: number;
  outputTokensEstimate?: number;
  modelProgress?: true;
};

type RecordAgentRunOutputTokensParams = {
  runId: string;
  lifecycleGeneration: string;
  outputTokens: number;
  update?:
    | { type: "estimate"; responseId: symbol; outputTokens: number }
    | { type: "complete"; responseId: symbol };
  emit: (usage: AgentRunUsage) => boolean;
};

type RunUsageState = {
  outputTokens: number;
  estimates: Map<symbol, number>;
};

const usageByRun = new Map<string, Map<string, RunUsageState>>();

/** Publishes a generation-scoped projection without charging estimates as usage. */
export function recordAgentRunOutputTokens(
  params: RecordAgentRunOutputTokensParams,
): AgentRunUsage | undefined {
  const outputTokens = Math.floor(params.outputTokens);
  if (!Number.isFinite(outputTokens) || outputTokens < 0 || (!outputTokens && !params.update)) {
    return undefined;
  }
  const usageByGeneration = usageByRun.get(params.runId) ?? new Map<string, RunUsageState>();
  const previous = usageByGeneration.get(params.lifecycleGeneration);
  const estimates = new Map(previous?.estimates);
  if (params.update?.type === "estimate") {
    const estimate = Math.floor(params.update.outputTokens);
    if (
      !Number.isFinite(estimate) ||
      estimate <= 0 ||
      estimates.get(params.update.responseId) === estimate
    ) {
      return undefined;
    }
    estimates.set(params.update.responseId, estimate);
  } else if (params.update?.type === "complete") {
    estimates.delete(params.update.responseId);
  }
  const confirmed = (previous?.outputTokens ?? 0) + outputTokens;
  let projected = confirmed;
  for (const estimate of estimates.values()) {
    projected += estimate;
  }
  const usage: AgentRunUsage = {
    outputTokens: confirmed,
    ...(estimates.size > 0 ? { outputTokensEstimate: projected } : {}),
    ...(params.update?.type === "estimate" ? { modelProgress: true } : {}),
  };
  if (!params.emit(usage)) {
    return undefined;
  }
  usageByGeneration.set(params.lifecycleGeneration, { outputTokens: confirmed, estimates });
  usageByRun.set(params.runId, usageByGeneration);
  return usage;
}

export function clearAgentRunUsage(runId: string, lifecycleGeneration?: string): void {
  if (lifecycleGeneration === undefined) {
    usageByRun.delete(runId);
    return;
  }
  const usageByGeneration = usageByRun.get(runId);
  usageByGeneration?.delete(lifecycleGeneration);
  if (usageByGeneration?.size === 0) {
    usageByRun.delete(runId);
  }
}

export function resetAgentRunUsageForTest(): void {
  usageByRun.clear();
}
