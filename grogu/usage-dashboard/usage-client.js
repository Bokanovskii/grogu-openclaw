(() => {
  const data = JSON.parse(document.getElementById("dashboard-data").textContent);
  const summary = data.summary;
  const $ = (id) => document.getElementById(id);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const sum = (values) => {
    if (values.some((value) => !valid(value))) {
      return null;
    }
    const result = values.reduce((total, value) => total + value, 0);
    return valid(result) ? result : null;
  };
  const fmt = (value) =>
    !valid(value)
      ? "Unknown"
      : new Intl.NumberFormat("en-US", {
          notation: value >= 1_000_000 ? "compact" : "standard",
          maximumFractionDigits: 1,
        }).format(value);
  const full = (value) => (valid(value) ? value.toLocaleString("en-US") : "Unknown");
  const providerLabel = (provider) =>
    provider === "github-copilot"
      ? "GitHub Copilot"
      : provider === "sparky"
        ? "Sparky"
        : !provider || provider === "unknown"
          ? "Unknown provider"
          : provider;
  const dateLabel = (date, long = false) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(long ? { year: "numeric", weekday: "short" } : {}),
    }).format(new Date(`${date}T00:00:00Z`));
  const dates = [];
  for (
    let time = Date.parse(`${summary.range.startDate}T00:00:00Z`),
      end = Date.parse(`${summary.range.endDate}T00:00:00Z`);
    time <= end;
    time += 86_400_000
  ) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  const dailyAvailable = summary.daily && summary.daily.status !== "unavailable";
  const pageSize = 20;
  const metricNames = {
    totalTokens: "total tokens",
    inputTotal: "input tokens",
    cacheRead: "cached input",
    uncached: "uncached input",
    output: "output tokens",
    reasoning: "reasoning tokens",
    nonReasoning: "non-reasoning output",
  };
  let date = "";
  let metric = "totalTokens";
  let selected = null;
  let page = 0;
  let exploring = false;

  function matchingRows(rows) {
    const provider = $("provider-filter").value;
    const model = $("model-filter").value;
    return rows.filter(
      (row) =>
        (!provider || (row.provider || "unknown") === provider) && (!model || row.model === model),
    );
  }

  function metricValue(rows, field) {
    if (field === "reasoning") {
      return rows.every((row) => row.reasoningComplete)
        ? sum(rows.map((row) => row.reasoning ?? 0))
        : null;
    }
    if (field === "inputTotal") {
      return sum([
        sum(rows.map((row) => row.input)),
        sum(rows.map((row) => row.cacheRead)),
        sum(rows.map((row) => row.cacheWrite)),
      ]);
    }
    if (field === "uncached") {
      return sum([sum(rows.map((row) => row.input)), sum(rows.map((row) => row.cacheWrite))]);
    }
    if (field === "nonReasoning") {
      const output = metricValue(rows, "output");
      const reasoning = metricValue(rows, "reasoning");
      return valid(output) && valid(reasoning) && reasoning <= output ? output - reasoning : null;
    }
    return sum(rows.map((row) => row[field]));
  }

  function rowsForDay(day) {
    return matchingRows((summary.daily?.rows ?? []).filter((row) => row.date === day));
  }

  function unavailableDay(rows) {
    return date && summary.daily?.status !== "complete" && rows.length === 0;
  }

  function selectedRows() {
    return date ? rowsForDay(date) : matchingRows(summary.rows);
  }

  function setFact(label, value) {
    const item = node("div");
    item.append(node("dt", "", label), node("dd", "", value));
    $("range").append(item);
  }

  setFact("Period", `${dateLabel(summary.range.startDate)} – ${dateLabel(summary.range.endDate)}`);
  setFact(
    "Time zone",
    summary.range.timeZone === "America/Los_Angeles" ? "Pacific time" : summary.range.timeZone,
  );
  setFact(
    "Updated",
    summary.dataUpdatedAt
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: summary.range.timeZone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(summary.dataUpdatedAt))
      : "Unknown",
  );
  setFact("Coverage", summary.totalsCoverage === "complete" ? "Complete" : "Partial");

  const warnings = [];
  if (
    summary.sourceCoverage === "partial" ||
    (!summary.sourceCoverage && summary.totalsCoverage !== "complete")
  ) {
    warnings.push("Partial snapshot: some usage may still be missing.");
  }
  if (summary.modelCoverage === "partial") {
    warnings.push("Some usage cannot be attributed to an actual model and is not included below.");
  } else if (summary.modelCoverage === "unknown") {
    warnings.push("Model attribution could not be reconciled with the native usage total.");
  }
  if (summary.attributionCoverage === "partial") {
    warnings.push("Some model rows have no known provider; their usage remains in the totals.");
  }
  if (summary.sessionsCoverage !== "complete") {
    warnings.push("The session list may be incomplete; totals can include usage not listed below.");
  }
  $("coverage-notice").replaceChildren(...warnings.map((text) => node("p", "", text)));
  $("coverage-notice").hidden = warnings.length === 0;
  $("notice").hidden = !data.stale;
  for (const provider of new Set(summary.rows.map((row) => row.provider || "unknown"))) {
    const option = node("option", "", providerLabel(provider));
    option.value = provider;
    $("provider-filter").append(option);
  }
  for (const model of new Set(summary.rows.map((row) => row.model))) {
    const option = node("option", "", model);
    option.value = model;
    $("model-filter").append(option);
  }
  for (const day of dates) {
    const option = node("option", "", dateLabel(day, true));
    option.value = day;
    $("daily-date").append(option);
  }
  $("daily-date").disabled = !dailyAvailable;

  function setDate(nextDate, focusBar = false) {
    date = date === nextDate && focusBar ? "" : nextDate;
    $("daily-date").value = date;
    if (date && !dates.slice(-Number($("daily-window").value)).includes(date)) {
      $("daily-window").value = "30";
    }
    page = 0;
    selected = null;
    render();
    if (focusBar) {
      [...$("daily-bars").children]
        .find((button) => button.dataset.day === nextDate)
        ?.focus({ preventScroll: true });
    }
  }

  function renderDaily() {
    $("daily-empty").hidden = dailyAvailable;
    $("daily-plot").hidden = !dailyAvailable;
    $("daily-window").disabled = !dailyAvailable;
    document.querySelectorAll("[data-metric]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.metric === metric));
      button.disabled = !dailyAvailable;
    });
    if (!dailyAvailable) {
      $("daily-empty").textContent =
        summary.daily?.message || "Daily usage is unavailable in this snapshot.";
      $("daily-caption").textContent = "The period totals remain available.";
      return;
    }
    const visible = dates.slice(-Number($("daily-window").value));
    const days = visible.map((day) => {
      const rows = rowsForDay(day);
      return {
        date: day,
        value:
          rows.length === 0 && summary.daily.status !== "complete"
            ? null
            : metricValue(rows, metric),
        responses:
          rows.length === 0 && summary.daily.status !== "complete"
            ? null
            : sum(rows.map((row) => row.responses)),
      };
    });
    const largest = Math.max(1, ...days.map((day) => day.value ?? 0));
    const unit = 10 ** Math.floor(Math.log10(largest));
    const ceiling = Math.ceil(largest / unit) * unit;
    $("daily-axis").replaceChildren(
      ...[ceiling, Math.floor(ceiling / 2), 0].map((value) => node("span", "", fmt(value))),
    );
    const bars = $("daily-bars");
    bars.replaceChildren();
    bars.style.gridTemplateColumns = `repeat(${visible.length}, minmax(0, 1fr))`;
    for (const day of days) {
      const button = node("button", `daily-day${day.value === null ? " missing" : ""}`);
      button.type = "button";
      button.dataset.day = day.date;
      button.setAttribute("aria-pressed", String(day.date === date));
      button.setAttribute(
        "aria-label",
        `${dateLabel(day.date, true)}: ${full(day.value)} ${metricNames[metric]}, ${full(day.responses)} recorded responses`,
      );
      button.title = button.getAttribute("aria-label");
      const fill = node("span", "daily-fill");
      fill.style.height = `${day.value === null ? 0 : (100 * day.value) / ceiling}%`;
      button.append(fill);
      button.addEventListener("click", () => setDate(day.date, true));
      bars.append(button);
    }
    const ticks = [
      ...new Set(
        Array.from({ length: Math.min(5, visible.length) }, (_, index) =>
          Math.round((index * (visible.length - 1)) / Math.max(1, Math.min(5, visible.length) - 1)),
        ),
      ),
    ];
    $("daily-labels").replaceChildren(
      ...ticks.map((index) => {
        const tick = node("span", "", dateLabel(visible[index]));
        tick.style.left = `clamp(22px, ${(100 * (index + 0.5)) / visible.length}%, calc(100% - 22px))`;
        return tick;
      }),
    );
    $("daily-caption").textContent =
      `${summary.daily.message} ` +
      "The chart shows all displayed days for the selected provider and model; selecting a day filters the other sections.";
  }

  function stat(id, title, value, hint, segments) {
    const card = node("article", "stat");
    card.id = id;
    const number = node("strong", "", fmt(value));
    number.title = full(value);
    card.append(node("span", "", title), number);
    if (segments && segments.every(valid) && segments[0] + segments[1] > 0) {
      const split = node("div", "split");
      split.setAttribute("aria-hidden", "true");
      const first = node("span");
      const second = node("span");
      first.style.width = `${(100 * segments[0]) / (segments[0] + segments[1])}%`;
      second.style.width = `${(100 * segments[1]) / (segments[0] + segments[1])}%`;
      split.append(first, second);
      card.append(split);
    }
    card.append(node("small", "", hint));
    return card;
  }

  function renderStats(rows, sessionCount) {
    const unknown = unavailableDay(rows);
    const total = unknown ? null : metricValue(rows, "totalTokens");
    const input = unknown ? null : metricValue(rows, "inputTotal");
    const cached = unknown ? null : metricValue(rows, "cacheRead");
    const uncached = unknown ? null : metricValue(rows, "uncached");
    const output = unknown ? null : metricValue(rows, "output");
    const reasoning = unknown ? null : metricValue(rows, "reasoning");
    const reported = unknown
      ? null
      : rows.length === 0
        ? 0
        : rows.some((row) => row.reasoningReported !== undefined && valid(row.reasoning))
          ? sum(rows.map((row) => (row.reasoningReported === undefined ? 0 : (row.reasoning ?? 0))))
          : null;
    const final = unknown ? null : metricValue(rows, "nonReasoning");
    const responses = unknown ? null : sum(rows.map((row) => row.responses));
    const reasoningHint =
      reasoning === null
        ? reported === null
          ? "Reasoning and non-reasoning unknown"
          : `At least ${fmt(reported)} reasoning recorded · non-reasoning unknown`
        : `${fmt(reasoning)} reasoning · ${fmt(final)} non-reasoning`;
    $("stats").replaceChildren(
      stat("stat-total", "Total tokens", total, "Input, output, and cache"),
      stat(
        "stat-input",
        "Input tokens",
        input,
        `${fmt(cached)} cached · ${fmt(uncached)} uncached`,
        [cached, uncached],
      ),
      stat("stat-output", "Output tokens", output, reasoningHint, [reasoning, final]),
      stat("stat-responses", "Recorded responses", responses, `${sessionCount} matching sessions`),
    );
  }

  function renderBars(id, rows, field) {
    const target = $(id);
    const filter = $(field === "provider" ? "provider-filter" : "model-filter");
    const groups = new Map();
    for (const row of rows) {
      const key = row[field] || "unknown";
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const values = [...groups].map(([key, group]) => ({
      key,
      group,
      value: metricValue(group, metric),
    }));
    values.sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
    const maximum = Math.max(1, ...values.map((entry) => entry.value ?? 0));
    target.replaceChildren();
    if (!values.length) {
      target.append(node("p", "empty", "No recorded rows match these filters."));
    }
    for (const value of values) {
      const active = filter.value === value.key;
      const button = node("button", "bar-row");
      button.type = "button";
      button.dataset.value = value.key;
      button.setAttribute("aria-pressed", String(active));
      const label = node("div", "bar-label");
      label.append(
        node("span", "", field === "provider" ? providerLabel(value.key) : value.key),
        node("b", "", fmt(value.value)),
      );
      button.append(label);
      if (field === "model") {
        button.append(
          node(
            "span",
            "bar-sub",
            [...new Set(value.group.map((row) => providerLabel(row.provider)))].join(" · "),
          ),
        );
      } else if (value.group.some((row) => row.attribution === "mapped")) {
        button.append(node("span", "bar-sub", "Includes mapped provider attribution"));
      }
      const track = node("div", `track${value.value === null ? " unknown" : ""}`);
      const fill = node("div", "fill");
      fill.style.width = value.value === null ? "0" : `${(100 * value.value) / maximum}%`;
      track.append(fill);
      button.append(track);
      button.addEventListener("click", () => {
        filter.value = active ? "" : value.key;
        resetPage();
        [...target.querySelectorAll("button")]
          .find((candidate) => candidate.dataset.value === value.key)
          ?.focus({ preventScroll: true });
      });
      target.append(button);
    }
  }

  function renderDetails(item) {
    const details = $("details");
    details.replaceChildren(node("h2", "", "Session details"));
    if (!item) {
      details.append(
        node("p", "", "Select a session to see its recorded models and token counts."),
      );
      return;
    }
    details.append(node("h3", "", item.session.label));
    if (
      item.session.linkKind === "canonical" &&
      typeof item.session.url === "string" &&
      /^https?:\/\//i.test(item.session.url)
    ) {
      const link = node("a", "chat-link", "Open chat in new tab");
      link.href = item.session.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      details.append(link);
    }
    if (date) {
      details.append(node("p", "", `Usage on ${dateLabel(date, true)}`));
      if (item.session.dailyCoverage !== "complete") {
        details.append(node("p", "", "Daily usage for this session is incomplete."));
      }
    }
    for (const row of item.rows) {
      const block = node("div", "detail-row");
      block.append(
        node("strong", "", row.model),
        node("p", "", `${providerLabel(row.provider)} · ${row.attribution}`),
      );
      const facts = node("dl");
      const reasoning = row.reasoningComplete
        ? (row.reasoning ?? 0)
        : row.reasoningReported === undefined
          ? null
          : row.reasoning;
      const nonReasoning =
        row.reasoningComplete && valid(row.output) && valid(reasoning)
          ? row.output - reasoning
          : null;
      for (const [label, value] of [
        ["Total tokens", row.totalTokens],
        ["Input, uncached", sum([row.input, row.cacheWrite])],
        ["Input, cached", row.cacheRead],
        ["Output", row.output],
        ["Reasoning reported", reasoning],
        ["Non-reasoning output", nonReasoning],
        ["Recorded responses", row.responses],
      ]) {
        facts.append(node("dt", "", label), node("dd", "", full(value)));
      }
      block.append(facts);
      details.append(block);
    }
  }

  function render() {
    renderDaily();
    const rows = selectedRows();
    const query = $("session-search").value.toLowerCase();
    const missingDaily = date
      ? data.sessions.filter((session) => session.dailyCoverage !== "complete").length
      : 0;
    const sessions = data.sessions
      .map((session, index) => ({
        session,
        index,
        rows: matchingRows(
          date ? (session.dailyRows ?? []).filter((row) => row.date === date) : session.rows,
        ),
      }))
      .filter((item) => item.rows.length && item.session.label.toLowerCase().includes(query))
      .toSorted(
        (left, right) =>
          (metricValue(right.rows, metric) ?? -1) - (metricValue(left.rows, metric) ?? -1),
      );
    page = Math.min(page, Math.max(0, Math.ceil(sessions.length / pageSize) - 1));
    const start = page * pageSize;
    const visible = sessions.slice(start, start + pageSize);
    renderStats(rows, sessions.length);
    renderBars("providers", rows, "provider");
    renderBars("models", rows, "model");
    const filters = [
      date ? dateLabel(date, true) : "all days",
      $("provider-filter").value && providerLabel($("provider-filter").value),
      $("model-filter").value,
    ].filter(Boolean);
    $("filter-status").textContent =
      `Showing ${filters.join(" · ")}. Session search only filters the session list.` +
      (date && summary.daily?.status !== "complete" ? " Daily coverage is partial." : "");
    $("count").textContent =
      `${sessions.length} matching sessions` +
      (missingDaily ? ` · ${missingDaily} lack complete daily details` : "");
    $("usage-page-status").textContent = sessions.length
      ? `${start + 1}–${start + visible.length} of ${sessions.length}`
      : "0 sessions";
    $("usage-prev").disabled = page === 0;
    $("usage-next").disabled = start + pageSize >= sessions.length;
    const list = $("session-list");
    list.replaceChildren();
    if (!visible.length) {
      list.append(node("p", "empty", "No sessions match these filters."));
    }
    for (const item of visible) {
      const button = node("button", "session");
      button.type = "button";
      button.dataset.sessionIndex = String(item.index);
      button.setAttribute("aria-pressed", String(selected === item.index));
      const label = node("div");
      label.append(
        node("strong", "", item.session.label),
        node(
          "div",
          "models",
          [...new Set(item.rows.map((row) => row.model))].join(" · ") +
            (date && item.session.dailyCoverage !== "complete" ? " · partial daily usage" : ""),
        ),
      );
      const value = node("div", "numeric", fmt(metricValue(item.rows, metric)));
      value.append(node("small", "", metricNames[metric]));
      button.append(label, value);
      button.addEventListener("click", () => {
        selected = item.index;
        render();
        [...list.querySelectorAll("button")]
          .find((candidate) => candidate.dataset.sessionIndex === String(item.index))
          ?.focus({ preventScroll: true });
        if (innerWidth < 900) {
          $("details").scrollIntoView({ block: "nearest" });
        }
      });
      list.append(button);
    }
    renderDetails(visible.find((item) => item.index === selected));
  }

  function resetPage() {
    page = 0;
    selected = null;
    render();
  }

  $("jump").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-target]");
    if (!button) {
      return;
    }
    const target = $(button.dataset.target);
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  });
  $("full-explorer").addEventListener("click", () => {
    exploring = !exploring;
    $("overview").hidden = exploring;
    $("jump").hidden = exploring;
    $("full-explorer").textContent = exploring ? "Show summary" : "Focus on sessions";
    $("full-explorer").setAttribute("aria-pressed", String(exploring));
    if (exploring) {
      $("session-search").focus({ preventScroll: true });
    }
  });
  for (const id of ["provider-filter", "model-filter"]) {
    $(id).addEventListener("change", resetPage);
  }
  $("daily-date").addEventListener("change", () => setDate($("daily-date").value));
  $("daily-window").addEventListener("change", renderDaily);
  document.querySelectorAll("[data-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      metric = button.dataset.metric;
      resetPage();
    });
  });
  $("session-search").addEventListener("input", resetPage);
  $("usage-prev").addEventListener("click", () => {
    page = Math.max(0, page - 1);
    render();
  });
  $("usage-next").addEventListener("click", () => {
    page += 1;
    render();
  });
  $("reset").addEventListener("click", () => {
    $("provider-filter").value = "";
    $("model-filter").value = "";
    $("session-search").value = "";
    date = "";
    $("daily-date").value = "";
    resetPage();
  });
  render();
})();
