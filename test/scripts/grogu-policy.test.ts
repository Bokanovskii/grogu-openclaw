import { describe, expect, it } from "vitest";
import { evaluatePolicy, type ModelPolicy } from "../../grogu/policy.js";
import {
  renderWorkerTriggerScript,
  workerTriggerScriptSha256,
  workerTriggerTemplateSchema,
} from "../../grogu/worker-trigger-templates.js";
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
    const template = workerTriggerTemplateSchema.parse({
      version: 1,
      templateId: "messages-metadata-v1",
      schemaSha256: "a".repeat(64),
      toolsAllow: ["seaglass__recent_messages"],
      args: { limit: 1, include_text: false },
      maxItems: 1,
      continuation: {
        delayMs: 60_000,
        intervalMs: 60_000,
        nativeSweepIntervalMs: 300_000,
        maxOpen: 8,
        maxFires: 2,
        ttlMs: 86_400_000,
      },
    });
    const script = renderWorkerTriggerScript(template);
    const contract = (
      jobId: string,
      marker:
        | "GROGU_PRIVATE_SIGNAL_V1"
        | "GROGU_DETERMINISTIC_POLL_V1"
        | "GROGU_GMAIL_AUTH_HEALTH_V1",
    ) => ({
      jobId,
      contractVersion: 1 as const,
      templateId: "messages-metadata-v1" as const,
      schemaSha256: template.schemaSha256,
      triggerSha256: workerTriggerScriptSha256(script),
      toolsAllow: [...template.toolsAllow],
      markers: [marker],
    });
    const privateSignal = agentJob("private-signal", automatic, undefined, {
      script,
    });
    privateSignal.payload.message = "GROGU_PRIVATE_SIGNAL_V1";
    privateSignal.payload.toolsAllow = [...template.toolsAllow];
    const polling = agentJob("polling", automatic);
    const violations = evaluatePolicy(compliantConfig(), [privateSignal, polling], {
      ...policy,
      workerContracts: [
        contract("private-signal", "GROGU_PRIVATE_SIGNAL_V1"),
        contract("polling", "GROGU_DETERMINISTIC_POLL_V1"),
        contract("missing", "GROGU_GMAIL_AUTH_HEALTH_V1"),
      ],
    });

    expect(violations.map((violation) => violation.where)).toEqual([
      "job:polling:contract",
      "job:missing:contract",
    ]);

    privateSignal.trigger = { script: "return { fire: true };" };
    expect(
      evaluatePolicy(compliantConfig(), [privateSignal], {
        ...policy,
        workerContracts: [contract("private-signal", "GROGU_PRIVATE_SIGNAL_V1")],
      }),
    ).toEqual([expect.objectContaining({ where: "job:private-signal:contract" })]);

    expect(
      evaluatePolicy(compliantConfig(), [privateSignal], {
        ...policy,
        workerContracts: [
          {
            ...contract("private-signal", "GROGU_PRIVATE_SIGNAL_V1"),
            schemaSha256: "a".repeat(64),
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ where: "job:private-signal:contract" })]);
  });

  it("keeps non-trigger worker marker contracts compatible", () => {
    const backup = agentJob("backup", automatic);
    backup.payload.message = "GROGU_BACKUP_OBSERVABILITY_V1";
    expect(
      evaluatePolicy(compliantConfig(), [backup], {
        ...policy,
        workerContracts: [
          {
            jobId: backup.id,
            contractVersion: 1,
            markers: ["GROGU_BACKUP_OBSERVABILITY_V1"],
            requireTrigger: false,
          },
        ],
      }),
    ).toEqual([]);
  });
});
