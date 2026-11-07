import { readFileSync } from "node:fs";

const style = readFileSync(new URL("./usage.css", import.meta.url), "utf8");
const client = readFileSync(new URL("./usage-client.js", import.meta.url), "utf8");

function serialized(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function usageHtml(summary, sessions, now = new Date(), stale = false) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: summary.range.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const data = { summary, sessions, stale, today };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model and provider usage</title><style>${style}</style></head>
<body><main class="app">
  <header class="top">
    <div><p class="eyebrow">Personal workspace / Usage</p>
      <h1>Where your tokens go.</h1>
      <p>Explore recorded usage by day, provider, model, and session.</p>
      <dl class="facts" id="range" aria-label="Snapshot details"></dl>
    </div>
    <button class="primary" id="full-explorer" type="button" aria-pressed="false">Focus on sessions</button>
  </header>
  <div class="notice" id="notice" role="status" hidden>Refresh unavailable. Showing the last verified snapshot.</div>
  <div class="notice" id="coverage-notice" role="status" hidden></div>
  <nav class="jump" id="jump" aria-label="Usage sections">
    <button type="button" data-target="stats">Summary</button>
    <button type="button" data-target="daily-chart">By day</button>
    <button type="button" data-target="breakdown">Providers &amp; models</button>
    <button type="button" data-target="sessions">Sessions</button>
  </nav>
  <section class="filterbar" aria-label="Usage filters">
    <label>Provider<select id="provider-filter"><option value="">All providers</option></select></label>
    <label>Model<select id="model-filter"><option value="">All models</option></select></label>
    <label>Date<select id="daily-date"><option value="">All days</option></select></label>
    <button class="clear" id="reset" type="button">Clear filters</button>
    <p class="filter-status" id="filter-status" role="status" aria-live="polite"></p>
  </section>
  <div id="overview">
    <section class="stats" id="stats" aria-label="Usage summary" tabindex="-1"></section>
    <section class="card daily-chart" id="daily-chart" aria-labelledby="daily-heading" tabindex="-1">
      <div class="section-head"><div><h2 id="daily-heading">Usage by day</h2>
        <p>Choose a day to filter the whole dashboard.</p></div>
        <label>Chart range<select id="daily-window"><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      </div>
      <div class="metric-controls" role="group" aria-label="Chart metric">
        <button type="button" data-metric="totalTokens">Total</button>
        <button type="button" data-metric="inputTotal">Input</button>
        <button type="button" data-metric="cacheRead">Cached</button>
        <button type="button" data-metric="uncached">Uncached</button>
        <button type="button" data-metric="output">Output</button>
        <button type="button" data-metric="reasoning">Reasoning</button>
        <button type="button" data-metric="nonReasoning">Non-reasoning</button>
      </div>
      <div class="daily-empty" id="daily-empty" hidden></div>
      <div class="daily-plot" id="daily-plot">
        <div class="daily-axis" id="daily-axis" aria-hidden="true"></div>
        <div class="daily-bars" id="daily-bars" role="group" aria-label="Daily usage"></div>
        <div class="daily-labels" id="daily-labels" aria-hidden="true"></div>
      </div>
      <p class="daily-caption" id="daily-caption" role="status"></p>
    </section>
    <section class="charts" id="breakdown" aria-label="Providers and models" tabindex="-1">
      <article class="card"><h2>By provider</h2><p class="hint">Select a row to filter.</p><div id="providers"></div></article>
      <article class="card"><h2>By actual model</h2><p class="hint">The model that answered, not the selected model.</p><div id="models"></div></article>
    </section>
  </div>
  <section class="bottom" id="sessions" aria-label="Sessions" tabindex="-1">
    <div class="card"><div class="section-head"><div><h2>Sessions</h2><p id="count"></p></div>
      <label class="search-label">Find a session<input id="session-search" type="search" placeholder="Search sessions"></label></div>
      <div class="session-list" id="session-list"></div>
      <nav class="pagination" aria-label="Session pages"><button id="usage-prev" type="button">Previous</button>
        <span id="usage-page-status" role="status" aria-live="polite"></span><button id="usage-next" type="button">Next</button></nav>
    </div>
    <aside class="card details" id="details" aria-label="Session usage details" aria-live="polite"></aside>
  </section>
  <footer class="notes"><h2>Reading these numbers</h2>
    <p>Responses are recorded model outputs, not necessarily billable requests. Input includes cache reads and writes.
    Reasoning is a subset of output. Missing counters and unreported reasoning stay unknown.
    Provider labels marked “mapped” use actual model IDs and do not prove billing identity.</p>
  </footer>
  <noscript><p class="notice">JavaScript is required to explore this usage snapshot.</p></noscript>
</main><script id="dashboard-data" type="application/json">${serialized(data)}</script>
<script>${client}</script></body></html>`;
}
