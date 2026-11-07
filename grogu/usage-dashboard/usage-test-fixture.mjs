import { usageParameters } from "./usage-data.mjs";

export function usageFixture() {
  const now = new Date("2026-11-06T12:00:00Z");
  const parameters = usageParameters(now);
  const catalog = [
    { providerId: "provider-a", modelIds: ["model-a", "shared-model"] },
    { providerId: "provider-b", modelIds: ["shared-model"] },
  ];
  const firstDay = {
    date: "2026-11-05",
    model: "model-a",
    provider: "***",
    count: 1,
    tokens: 100,
    totals: {
      input: 50,
      output: 20,
      cacheRead: 20,
      cacheWrite: 10,
      reasoning: 8,
      reasoningReportedEntries: 1,
      totalTokens: 100,
    },
  };
  const secondDay = {
    date: "2026-11-06",
    model: "model-a",
    provider: "***",
    count: 1,
    tokens: 160,
    totals: {
      input: 80,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      reasoning: 20,
      reasoningReportedEntries: 1,
      totalTokens: 160,
    },
  };
  const sharedDay = {
    date: "2026-11-06",
    model: "shared-model",
    count: 1,
    tokens: 40,
    totals: {
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 5,
      reasoningReportedEntries: 1,
      totalTokens: 40,
    },
  };
  const modelA = {
    model: "model-a",
    provider: "***",
    count: 2,
    totals: {
      input: 130,
      output: 70,
      cacheRead: 40,
      cacheWrite: 20,
      reasoning: 28,
      reasoningReportedEntries: 2,
      totalTokens: 260,
    },
  };
  const shared = { model: "shared-model", count: 1, totals: { ...sharedDay.totals } };
  return {
    now,
    parameters,
    catalog,
    data: {
      updatedAt: now.getTime(),
      cacheStatus: { status: "fresh" },
      totals: { totalTokens: 300 },
      aggregates: {
        sessionCount: 2,
        byModel: [modelA, shared],
        modelDaily: [firstDay, secondDay, sharedDay],
      },
      sessions: [
        {
          key: "agent:main:session:synthetic-a",
          label: "Alpha chat",
          usage: { modelUsage: [modelA], dailyModelUsage: [firstDay, secondDay] },
        },
        {
          key: "agent:main:session:synthetic-b",
          label: "Beta chat",
          usage: { modelUsage: [shared], dailyModelUsage: [sharedDay] },
        },
      ],
    },
  };
}
