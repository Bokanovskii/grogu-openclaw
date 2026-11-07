import assert from "node:assert/strict";
import test from "node:test";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import {
  sessionUsageLinks,
  summarizeDailyUsage,
  summarizeUsage,
  usageParameters,
} from "./usage-data.mjs";
import { usageHtml } from "./usage-html.mjs";
import { usageFixture } from "./usage-test-fixture.mjs";

test("uses Pacific calendar boundaries rather than the machine's time zone", () => {
  const before = usageParameters(new Date("2026-03-08T07:59:00Z"));
  const after = usageParameters(new Date("2026-03-08T08:01:00Z"));
  assert.equal(before.endDate, "2026-03-07");
  assert.equal(after.endDate, "2026-03-08");
  assert.equal(after.startDate, "2026-02-07");
});

test("summarizes daily categories and maps only unambiguous actual model providers", () => {
  const { data, catalog, parameters } = usageFixture();
  const summary = summarizeUsage(data, catalog, parameters);
  const daily = summarizeDailyUsage(data, catalog, parameters);
  assert.equal(summary.totalsCoverage, "complete");
  assert.equal(summary.sessionsCoverage, "complete");
  assert.equal(summary.attributionCoverage, "partial");
  assert.deepEqual(
    summary.rows.map(({ model, provider, attribution, reasoningComplete }) => ({
      model,
      provider,
      attribution,
      reasoningComplete,
    })),
    [
      { model: "model-a", provider: "provider-a", attribution: "mapped", reasoningComplete: true },
      { model: "shared-model", provider: null, attribution: "unknown", reasoningComplete: true },
    ],
  );
  assert.equal(daily.status, "complete");
  const first = daily.rows.find((row) => row.date === "2026-11-05");
  assert.deepEqual(
    [first.input, first.cacheRead, first.cacheWrite, first.output, first.reasoning],
    [50, 20, 10, 20, 8],
  );
  const sessions = sessionUsageLinks(
    data,
    catalog,
    parameters,
    "https://example.test/usage",
    buildControlUiSessionPath,
  );
  assert.equal(sessions[0].url, "https://example.test/chat/main/session/synthetic-a");
  assert.equal(sessions[0].dailyCoverage, "complete");
  assert.deepEqual(
    sessions[0].dailyRows.map(({ date, totalTokens }) => [date, totalTokens]),
    [
      ["2026-11-05", 100],
      ["2026-11-06", 160],
    ],
  );
});

test("retains missing token categories and old reasoning coverage as unknown", () => {
  const { data, catalog, parameters } = usageFixture();
  delete data.aggregates.byModel[0].totals.input;
  delete data.aggregates.byModel[0].totals.reasoningReportedEntries;
  delete data.aggregates.modelDaily[0].totals;
  const summary = summarizeUsage(data, catalog, parameters);
  const daily = summarizeDailyUsage(data, catalog, parameters);
  const first = daily.rows.find((row) => row.date === "2026-11-05");
  assert.equal(summary.rows[0].input, null);
  assert.equal(summary.rows[0].reasoningComplete, false);
  assert.equal(first.totalTokens, 100);
  assert.equal(first.input, null);
  assert.equal(first.reasoning, null);
  assert.equal(first.reasoningComplete, false);
  assert.equal(daily.status, "complete");
});

test("marks missing daily session rows and capped lists without assigning lifetime totals to a day", () => {
  const { data, catalog, parameters } = usageFixture();
  delete data.sessions[0].usage.dailyModelUsage;
  const sessions = sessionUsageLinks(
    data,
    catalog,
    parameters,
    "https://example.test/usage",
    buildControlUiSessionPath,
  );
  assert.equal(sessions[0].dailyRows, null);
  assert.equal(sessions[0].dailyCoverage, "unavailable");
  assert.equal(
    summarizeUsage(data, catalog, { ...parameters, limit: 2 }).sessionsCoverage,
    "partial",
  );

  const second = usageFixture();
  second.data.sessions[0].usage.dailyModelUsage = [second.data.aggregates.modelDaily[0]];
  assert.equal(
    sessionUsageLinks(
      second.data,
      second.catalog,
      second.parameters,
      "https://example.test/usage",
      buildControlUiSessionPath,
    )[0].dailyCoverage,
    "partial",
  );
});

test("does not claim complete daily coverage when model attribution fails to reconcile", () => {
  const { data, catalog, parameters } = usageFixture();
  data.aggregates.modelDaily[0] = {
    ...data.aggregates.modelDaily[0],
    model: "shared-model",
  };
  assert.equal(summarizeDailyUsage(data, catalog, parameters).status, "partial");
});

test("rejects invalid daily dates and reports missing native model attribution", () => {
  const { data, catalog, parameters } = usageFixture();
  data.aggregates.modelDaily[0] = { ...data.aggregates.modelDaily[0], date: "2026-02-31" };
  assert.equal(summarizeDailyUsage(data, catalog, parameters).status, "unavailable");
  data.totals.totalTokens = 301;
  const summary = summarizeUsage(data, catalog, parameters);
  assert.equal(summary.modelCoverage, "partial");
  assert.equal(summary.totalsCoverage, "partial");
});

test("escapes embedded data so session titles cannot break out of the widget", () => {
  const { data, catalog, parameters, now } = usageFixture();
  data.sessions[0].label = "</script><script>window.injected=true</script>";
  const summary = {
    ...summarizeUsage(data, catalog, parameters),
    daily: summarizeDailyUsage(data, catalog, parameters),
  };
  const html = usageHtml(
    summary,
    sessionUsageLinks(
      data,
      catalog,
      parameters,
      "https://example.test/usage",
      buildControlUiSessionPath,
    ),
    now,
  );
  assert.doesNotMatch(html, /<\/script><script>window\.injected/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test("uses canonical literal routes rather than shortening or discarding session-key segments", () => {
  const { data, catalog, parameters } = usageFixture();
  data.sessions[0].key = "agent:main:12345678";
  data.sessions[1].key = "agent:main:main:child";
  const sessions = sessionUsageLinks(
    data,
    catalog,
    parameters,
    "https://example.test/usage",
    buildControlUiSessionPath,
  );
  assert.equal(sessions[0].url, "https://example.test/chat/main/~key/12345678");
  assert.equal(sessions[1].url, "https://example.test/chat/main/main/child");
  assert.ok(sessions.every((session) => session.linkKind === "canonical"));
});
