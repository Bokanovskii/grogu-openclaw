import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerJobDefinitionPreserved,
  bootstrapGroguWidgetSandbox,
  parseManagedWorkerTriggers,
  planManagedJobPatch,
  readWorkerSchemaPin,
  readUpdatedManagedJob,
  workerJobDefinitionSha256,
} from "../../grogu/bootstrap.js";
import type { OperatorProfile } from "../../grogu/operator.js";
import {
  inspectRenderedWorkerTriggerScript,
  workerTriggerScriptSha256,
} from "../../grogu/worker-trigger-templates.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../grogu/operator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../grogu/operator.js")>()),
  callNative: native.call,
  createPrivateArtifactDirectory: async () => "/synthetic/recovery/attempt",
  writePrivateReceipt: async () => "/synthetic/recovery/attempt/plan.json",
}));

const schemaSha256 = "16f483176747c72d4e27fe9c8cd4c645c48d4f6aa6aadaded3bdbe2ca89495b1";
const approvedTools = [
  "gmail__gmail_search",
  "seaglass__recent_messages",
  "icloud_calendar_events",
  "sessions_search",
];
const job = {
  id: "synthetic-job",
  name: "Watchdog",
  enabled: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  configRevision: "synthetic-revision",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic prompt.", model: "synthetic/model" },
  state: {},
} satisfies CronJob;

const workerBindings = [
  {
    logicalName: "gmail",
    id: "job-gmail",
    template: {
      version: 1,
      templateId: "gmail-metadata-v1",
      schemaSha256,
      toolsAllow: approvedTools,
      args: {
        query: "newer_than:1d",
        max: 1,
        include_body: false,
        sanitize_content: true,
      },
      maxItems: 1,
      continuation: {
        delayMs: 60_000,
        intervalMs: 60_000,
        nativeSweepIntervalMs: 300_000,
        maxOpen: 8,
        maxFires: 2,
        ttlMs: 86_400_000,
      },
    },
  },
  {
    logicalName: "messages",
    id: "job-messages",
    template: {
      version: 1,
      templateId: "messages-metadata-v1",
      schemaSha256,
      toolsAllow: approvedTools,
      args: { limit: 50, offset: 0, include_text: false },
      maxItems: 50,
      continuation: {
        delayMs: 60_000,
        intervalMs: 60_000,
        nativeSweepIntervalMs: 300_000,
        maxOpen: 8,
        maxFires: 2,
        ttlMs: 86_400_000,
      },
    },
  },
];

describe("revision-checked metadata bootstrap", () => {
  it("accepts only explicit deterministic worker trigger bindings", () => {
    const parsed = parseManagedWorkerTriggers(workerBindings);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      logicalName: "gmail",
      id: "job-gmail",
      contractVersion: 1,
      templateId: "gmail-metadata-v1",
      toolsAllow: approvedTools,
      trigger: { script: expect.stringContaining("MCP.gmail.gmailSearch") },
      triggerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() =>
      parseManagedWorkerTriggers([
        {
          logicalName: "gmail",
          id: "job-gmail",
          trigger: { script: "return { fire: false };" },
        },
      ]),
    ).toThrow(/Invalid or duplicate/);
    expect(() => parseManagedWorkerTriggers([])).toThrow(/exactly the two existing jobs/);
    expect(() => parseManagedWorkerTriggers([parsed[0]])).toThrow();
  });

  it("reads exact schema pins only from native MCP probe metadata", () => {
    expect(
      readWorkerSchemaPin(
        {
          toolSchemas: {
            gmail__gmail_search: {
              inputSchema: { type: "object" },
              schemaFormat: "openclaw-effective-input-schema/v1",
              schemaSha256,
            },
          },
        },
        "gmail__gmail_search",
      ),
    ).toBe(schemaSha256);
    expect(() =>
      readWorkerSchemaPin({ tools: ["gmail__gmail_search"] }, "gmail__gmail_search"),
    ).toThrow(/toolSchemas/);
  });

  it("is idempotent and patches only changed fields while preserving a manual pause and model", () => {
    const before = structuredClone(job);
    expect(planManagedJobPatch("watchdog", job, { name: job.name })).toBeNull();
    expect(planManagedJobPatch("watchdog", job, { description: "New description" })).toEqual({
      id: job.id,
      expectedConfigRevision: job.configRevision,
      patch: { description: "New description" },
    });
    expect(job).toEqual(before);
  });

  it("refuses active work or missing revision evidence instead of guessing or canceling", () => {
    expect(() =>
      planManagedJobPatch(
        "watchdog",
        {
          ...job,
          state: { runningAtMs: 1 },
        },
        { name: "Renamed" },
      ),
    ).toThrow(/running/);
    expect(() =>
      planManagedJobPatch(
        "watchdog",
        {
          ...job,
          configRevision: undefined,
        },
        { name: "Renamed" },
      ),
    ).toThrow(/revision/);
  });

  it("accepts a committed update with a native delivery preview without widening job validation", () => {
    const updated = readUpdatedManagedJob({
      ...job,
      description: "Updated description",
      deliveryPreview: { label: "Unresolved route", detail: "Synthetic delivery diagnostic." },
    });
    expect(
      planManagedJobPatch("watchdog", updated, { description: "Updated description" }),
    ).toBeNull();
    expect(() =>
      readUpdatedManagedJob({ ...job, deliveryPreview: { label: "Incomplete" } }),
    ).toThrow();
    expect(() => readUpdatedManagedJob({ ...job, unexpected: true })).toThrow();
  });

  it("plans a trigger update for a worker still holding an older rendered script", () => {
    for (const worker of parseManagedWorkerTriggers(workerBindings)) {
      const { script } = worker.trigger;
      const olderScript = `${script.slice(0, script.indexOf("\n"))}\nreturn { fire: false };`;
      const older: CronJob = { ...job, trigger: { script: olderScript } };
      const current: CronJob = { ...job, trigger: worker.trigger };

      // Policy pins the rendered script hash, so an older script is also a policy drift.
      expect(() => inspectRenderedWorkerTriggerScript(olderScript)).toThrow(/tracked renderer/);
      expect(workerTriggerScriptSha256(olderScript)).not.toBe(worker.triggerSha256);
      expect(planManagedJobPatch(worker.logicalName, older, { trigger: worker.trigger })).toEqual({
        id: job.id,
        expectedConfigRevision: job.configRevision,
        patch: { trigger: worker.trigger },
      });

      expect(inspectRenderedWorkerTriggerScript(script).templateId).toBe(worker.templateId);
      expect(workerTriggerScriptSha256(script)).toBe(worker.triggerSha256);
      expect(
        planManagedJobPatch(worker.logicalName, current, { trigger: worker.trigger }),
      ).toBeNull();
    }
  });

  it("proves trigger-only updates preserve the complete worker definition", () => {
    const updated = {
      ...job,
      updatedAtMs: 2,
      configRevision: "next-revision",
      trigger: { script: "return { fire: false };" },
    } satisfies CronJob;
    expect(() => assertWorkerJobDefinitionPreserved("watchdog", job, updated)).not.toThrow();
    expect(workerJobDefinitionSha256(updated)).toBe(workerJobDefinitionSha256(job));

    expect(() =>
      assertWorkerJobDefinitionPreserved("watchdog", job, {
        ...updated,
        payload: {
          ...updated.payload,
          toolsAllow: ["gmail__gmail_search"],
        },
      }),
    ).toThrow(/non-trigger job configuration/);
  });
});

describe("Grogu widget sandbox bootstrap", () => {
  const profile: OperatorProfile = {
    runtime: { node: "/synthetic/node", cli: "/synthetic/openclaw" },
    stateDir: "/synthetic/state",
    configFile: "/synthetic/config.json",
    oauthDir: "/synthetic/oauth",
    recoveryDir: "/synthetic/recovery",
    releasesDir: "/synthetic/releases",
    gatewayPort: 18789,
    gatewayUrl: "ws://127.0.0.1:18789",
    profileFile: "/synthetic/profile.json",
  };
  beforeEach(() => {
    native.call.mockReset();
  });

  it.each([
    { current: undefined, apply: false, writes: false },
    { current: undefined, apply: true, writes: true },
    { current: false, apply: true, writes: false },
    { current: true, apply: true, writes: false },
  ])(
    "defaults only an unset value through the native configuration owner: %j",
    async ({ current, apply, writes }) => {
      native.call
        .mockResolvedValueOnce({
          valid: true,
          hash: "observed-config-revision",
          config: { mcp: { apps: { sameOriginSandbox: current } } },
        })
        .mockResolvedValueOnce({
          ok: true,
          config: { mcp: { apps: { sameOriginSandbox: true } } },
        });
      const result = await bootstrapGroguWidgetSandbox(profile, apply);
      expect(result).toMatchObject({
        mode: apply ? "applied" : "preview",
        sameOriginSandbox: current ?? true,
        changed: current === undefined,
      });
      expect(native.call).toHaveBeenCalledTimes(writes ? 2 : 1);
      if (writes) {
        expect(native.call.mock.calls[1]?.slice(1, 3)).toEqual([
          "config.patch",
          expect.objectContaining({
            baseHash: "observed-config-revision",
            raw: JSON.stringify({ mcp: { apps: { sameOriginSandbox: true } } }),
          }),
        ]);
      }
    },
  );

  it("does not replay the default over a concurrent operator choice", async () => {
    native.call
      .mockResolvedValueOnce({
        valid: true,
        hash: "old-revision",
        config: {},
      })
      .mockRejectedValueOnce(new Error("config changed; re-run config.get"));
    await expect(bootstrapGroguWidgetSandbox(profile, true)).rejects.toThrow("config changed");
    expect(native.call).toHaveBeenCalledTimes(2);
  });
});
