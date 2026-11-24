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

void test("returns calendar schedules in canonical form without leading zeros", () => {
  const catalog = createProtectedAutomationCatalog({
    agents,
    models: [model],
    calendarDraftValidationAvailable: true,
  });
  assert.ok(catalog);

  for (const [expr, canonical] of [
    ["00 06 * * *", "0 6 * * *"],
    ["05 07 * * 1-5", "5 7 * * 1-5"],
    ["30 18 * * 6", "30 18 * * 6"],
  ] as const) {
    const result = validateProtectedAutomationDraft(
      { ...baseDraft, schedule: { kind: "cron", expr, tz: "America/Los_Angeles" } },
      catalog,
    );
    assert.equal(result.valid, true, expr);
    if (result.valid) {
      assert.deepEqual(result.draft.schedule, {
        kind: "cron",
        expr: canonical,
        tz: "America/Los_Angeles",
      });
    }
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

void test("paced drafts require an advertised interval and an in-bounds fallback", () => {
  const catalog = createProtectedAutomationCatalog({
    agents,
    models: [model],
    calendarDraftValidationAvailable: true,
  });
  assert.ok(catalog);
  const paced = {
    ...catalog,
    schedule: { ...catalog.schedule, pacing: { minimumMs: 60_000, maximumMs: 2_592_000_000 } },
  };
  const draft = {
    ...baseDraft,
    schedule: { kind: "every", everyMs: 90_000 },
    pacing: { minMs: 60_000, maxMs: 120_000 },
  };
  assert.equal(validateProtectedAutomationDraft(draft, catalog).valid, false);
  assert.equal(validateProtectedAutomationDraft(draft, paced).valid, true);
  for (const candidate of [
    { ...draft, schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/Los_Angeles" } },
    { ...draft, pacing: { minMs: 1, maxMs: 120_000 } },
    { ...draft, pacing: { minMs: 120_000, maxMs: 180_000 } },
    { ...draft, pacing: { minMs: 60_000, maxMs: 80_000 } },
    { ...draft, pacing: { minMs: 60_000.5, maxMs: 120_000 } },
    { ...draft, pacing: { minMs: 60_000, maxMs: 2_592_000_001 } },
  ]) {
    assert.equal(validateProtectedAutomationDraft(candidate, paced).valid, false);
  }
});
