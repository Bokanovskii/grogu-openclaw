import { describe, expect, it } from "vitest";
import { evaluatePolicy, type ModelPolicy } from "../../grogu/policy.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";

const automatic = "local/automatic-model";
const policy: ModelPolicy = {
  automaticModel: automatic,
  ownerOverrides: { configPaths: [], jobIds: [] },
};

function compliantConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: automatic, fallbacks: [] as string[] },
        utilityModel: automatic,
        decisionModel: "",
        compaction: { model: automatic },
        imageModel: { primary: automatic, fallbacks: [], timeoutSeconds: 30 },
        models: { "hosted/picker-model": { agentRuntime: { id: "hosted" } } },
        modelPolicy: { allow: [automatic, "hosted/picker-model"] },
      },
      entries: { main: { model: automatic } },
    },
    plugins: { entries: { memory: { config: { dreaming: { execution: { model: automatic } } } } } },
    messages: { queue: { byChannel: { telegram: "followup" } } },
  };
}

function agentJob(
  id: string,
  model?: string,
  fallbacks?: string[],
  trigger?: CronJob["trigger"],
): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Synthetic.",
      ...(model ? { model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
    },
    ...(trigger ? { trigger } : {}),
    state: {},
  };
}

describe("automatic routing and queue policy", () => {
  it("accepts automatic routes while ignoring owner picker catalogs and allowlists", () => {
    expect(
      evaluatePolicy(
        compliantConfig(),
        [agentJob("inherits"), agentJob("pinned", automatic, [])],
        policy,
      ),
    ).toEqual([]);
  });

  it("reports drift in nested selectors, fallbacks, plugin models and job routes", () => {
    const config = compliantConfig();
    config.agents.defaults.model.fallbacks = ["hosted/fallback-model"];
    config.agents.entries.main.model = "hosted/agent-model";
    config.plugins.entries.memory.config.dreaming.execution.model = "hosted/dream-model";
    const violations = evaluatePolicy(
      config,
      [agentJob("job-a", "hosted/job-model"), agentJob("job-b", automatic, ["hosted/job-fb"])],
      policy,
    );
    expect(violations.map((violation) => [violation.where, violation.found])).toEqual([
      ["config.agents.defaults.model.fallbacks[0]", "hosted/fallback-model"],
      ["config.agents.entries.main.model", "hosted/agent-model"],
      ["config.plugins.entries.memory.config.dreaming.execution.model", "hosted/dream-model"],
      ["job:job-a", "hosted/job-model"],
      ["job:job-b", "hosted/job-fb"],
    ]);
  });

  it("honors explicit owner overrides and requires the Telegram FIFO queue mode", () => {
    const config = compliantConfig();
    config.agents.entries.main.model = "hosted/agent-model";
    config.messages.queue.byChannel.telegram = "steer";
    const violations = evaluatePolicy(config, [agentJob("chosen", "hosted/job-model")], {
      automaticModel: automatic,
      ownerOverrides: { configPaths: ["agents.entries.main.model"], jobIds: ["chosen"] },
    });
    expect(violations).toEqual([
      {
        where: "config.messages.queue.byChannel.telegram",
        found: "steer",
        expected: "followup",
      },
    ]);
  });

  it("requires declared private-signal and deterministic-poll worker contracts", () => {
    const privateSignal = agentJob("private-signal", automatic, undefined, {
      script: "return { fire: false };",
    });
    privateSignal.payload.message = "GROGU_PRIVATE_SIGNAL_V1";
    const polling = agentJob("polling", automatic);
    const violations = evaluatePolicy(compliantConfig(), [privateSignal, polling], {
      ...policy,
      workerContracts: [
        { jobId: "private-signal", markers: ["GROGU_PRIVATE_SIGNAL_V1"] },
        { jobId: "polling", markers: ["GROGU_DETERMINISTIC_POLL_V1"] },
        { jobId: "missing", markers: ["GROGU_GMAIL_AUTH_HEALTH_V1"] },
      ],
    });

    expect(violations).toEqual([
      {
        where: "job:polling:contract",
        found: {
          missingMarkers: ["GROGU_DETERMINISTIC_POLL_V1"],
          trigger: false,
        },
        expected: {
          markers: ["GROGU_DETERMINISTIC_POLL_V1"],
          trigger: true,
        },
      },
      {
        where: "job:missing:contract",
        found: null,
        expected: {
          markers: ["GROGU_GMAIL_AUTH_HEALTH_V1"],
          trigger: true,
        },
      },
    ]);
  });
});
