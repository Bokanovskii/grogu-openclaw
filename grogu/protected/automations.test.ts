import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  ProtectedAutomationCatalogSchema,
  type ProtectedAgentCatalogDto,
  type ProtectedModel,
} from "../../packages/gateway-protocol/src/protected.js";
import {
  createProtectedAutomationCatalog,
  validateProtectedAutomationDraft,
} from "./automations.js";

const agents: ProtectedAgentCatalogDto = {
  defaultAgentId: "travel",
  agents: [{ id: "travel", name: "Travel", description: "Synthetic agent", tools: [] }],
};
const model: ProtectedModel = {
  provider: "sparky",
  id: "synthetic-sparky",
  label: "Synthetic Sparky",
  thinking: { levels: ["ultra"], default: "ultra" },
};
const baseDraft = {
  name: "Synthetic schedule",
  instructions: "Summarize public project updates.",
  whenToNotify: "Only when there is a meaningful update.",
  agentId: "travel",
  model: { provider: "sparky", id: "synthetic-sparky" },
};

void test("validates only the advertised local calendar schedules", () => {
  const catalog = createProtectedAutomationCatalog({
    agents,
    models: [model],
    calendarDraftValidationAvailable: true,
  });
  assert.ok(catalog);
  assert.equal(Value.Check(ProtectedAutomationCatalogSchema, catalog), true);
  assert.deepEqual(catalog.schedule, {
    kinds: ["every", "cron"],
    everyMs: { minimum: 1, maximum: 8_640_000_000_000_000 },
    cron: {
      format: "5-field",
      repeats: ["daily", "weekdays", "saturday"],
      timeZones: ["America/Los_Angeles"],
      timePrecision: "minute",
      staggerMs: 0,
      daylightSaving: {
        nonexistentLocalTime: "skip",
        repeatedLocalTime: "first",
      },
    },
  });

  for (const expr of ["0 7 * * *", "0 7 * * 1-5", "0 7 * * 6"]) {
    const result = validateProtectedAutomationDraft(
      {
        ...baseDraft,
        schedule: { kind: "cron", expr, tz: "America/Los_Angeles" },
      },
      catalog,
    );
    assert.equal(result.valid, true, expr);
  }
});

void test("rejects ambiguous, unsupported, or invalid calendar schedules", () => {
  const catalog = createProtectedAutomationCatalog({
    agents,
    models: [model],
    calendarDraftValidationAvailable: true,
  });
  assert.ok(catalog);

  for (const schedule of [
    { kind: "cron", expr: "0 7,19 * * *", tz: "America/Los_Angeles" },
    { kind: "cron", expr: "0 7 * * 0", tz: "America/Los_Angeles" },
    { kind: "cron", expr: "60 7 * * *", tz: "America/Los_Angeles" },
    { kind: "cron", expr: "0 7 * * *", tz: "America/New_York" },
  ]) {
    const result = validateProtectedAutomationDraft({ ...baseDraft, schedule }, catalog);
    assert.equal(result.valid, false, JSON.stringify(schedule));
    if (!result.valid) {
      assert.ok(result.errors.some((entry) => entry.field === "schedule"));
    }
  }
});

void test("retains only the saved resolvable agent when it leaves new-agent discovery", () => {
  const catalog = createProtectedAutomationCatalog({ agents, models: [model] });
  assert.ok(catalog);
  const draft = { ...baseDraft, schedule: { kind: "every", everyMs: 60_000 } };
  for (const [agentId, retainedAgent, valid] of [
    ["general", undefined, false],
    ["general", { id: "general" }, true],
    ["research", { id: "general" }, false],
    ["travel", { id: "general" }, true],
  ] as const) {
    const result = validateProtectedAutomationDraft({ ...draft, agentId }, catalog, retainedAgent);
    assert.equal(result.valid, valid, `${agentId} with saved ${retainedAgent?.id ?? "none"}`);
    if (!result.valid) {
      assert.ok(result.errors.some((entry) => entry.code === "unsupported_agent"));
    }
  }
});
