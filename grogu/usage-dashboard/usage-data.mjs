const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const UNKNOWN_PROVIDER = /^(?:\*+|\[?redacted\]?|unknown|n\/a)$/i;

function bounded(value, length = 100) {
  return (
    String(value)
      // oxlint-disable-next-line eslint/no-control-regex -- Labels must not contain control characters.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, length)
  );
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sum(values) {
  if (values.some((value) => value === null)) {
    return null;
  }
  return counter(values.reduce((total, value) => total + value, 0));
}

export function usageParameters(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const endDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate,
    mode: "specific",
    timeZone,
    groupBy: "family",
    limit: 1000,
    agentScope: "all",
  };
}

function modelProviders(catalog) {
  if (!Array.isArray(catalog)) {
    throw new Error("Model catalog unavailable");
  }
  const matches = new Map();
  for (const entry of catalog) {
    if (typeof entry.providerId !== "string" || !Array.isArray(entry.modelIds)) {
      throw new Error("Model catalog unavailable");
    }
    for (const modelId of entry.modelIds) {
      if (typeof modelId !== "string") {
        continue;
      }
      const providers = matches.get(modelId) ?? new Set();
      providers.add(entry.providerId);
      matches.set(modelId, providers);
    }
  }
  return matches;
}

function isBookkeeping(entry) {
  return entry.provider === "openclaw" || entry.model === "delivery-mirror";
}

function modelRow(entry, providers) {
  const model = typeof entry.model === "string" && entry.model.trim() ? entry.model : null;
  const reported =
    typeof entry.provider === "string" &&
    entry.provider.trim() &&
    !UNKNOWN_PROVIDER.test(entry.provider.trim())
      ? entry.provider
      : null;
  const configured = model ? providers.get(model) : null;
  const mapped = !reported && configured?.size === 1 ? [...configured][0] : null;
  const totals = entry.totals ?? {};
  const responses = counter(entry.count);
  const output = counter(totals.output);
  const reasoning = counter(totals.reasoning);
  const reasoningReported = counter(totals.reasoningReportedEntries);
  return {
    model: model ? bounded(model, 180) : "Unknown actual model",
    provider: reported ? bounded(reported) : mapped ? bounded(mapped) : null,
    attribution: reported ? "reported" : mapped ? "mapped" : "unknown",
    mappingReason: reported
      ? "Native usage-event provider"
      : mapped
        ? "Actual model ID uniquely matches the current provider catalog"
        : "The actual model ID does not uniquely identify a provider",
    responses,
    input: counter(totals.input),
    output,
    cacheRead: counter(totals.cacheRead),
    cacheWrite: counter(totals.cacheWrite),
    reasoning,
    reasoningReported,
    reasoningComplete:
      responses !== null &&
      reasoningReported === responses &&
      output !== null &&
      (reasoning ?? 0) <= output,
    totalTokens: counter(totals.totalTokens),
  };
}

function reconcileModelRows(left, right) {
  const grouped = (rows) => {
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.provider, row.model]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return groups;
  };
  const expected = grouped(left);
  const actual = grouped(right);
  if (expected.size !== actual.size) {
    return false;
  }
  for (const [key, values] of expected) {
    const others = actual.get(key);
    if (!others) {
      return false;
    }
    for (const field of ["totalTokens", "responses"]) {
      const a = sum(values.map((row) => row[field]));
      const b = sum(others.map((row) => row[field]));
      if (a === null || b === null || a !== b) {
        return false;
      }
    }
  }
  return true;
}

function sessionCoverage(data, providers, parameters, periodRows) {
  if (!Array.isArray(data.sessions)) {
    return "partial";
  }
  const rows = data.sessions.flatMap((session) =>
    Array.isArray(session.usage?.modelUsage)
      ? session.usage.modelUsage
          .filter((entry) => !isBookkeeping(entry))
          .map((entry) => modelRow(entry, providers))
      : [],
  );
  const reportedSessionCount = counter(data.aggregates?.sessionCount);
  const limited =
    data.sessions.length >= parameters.limit ||
    (reportedSessionCount !== null && reportedSessionCount > data.sessions.length);
  return !limited &&
    !data.sessions.some((session) => session.computing || !session.usage) &&
    reconcileModelRows(periodRows, rows)
    ? "complete"
    : "partial";
}

export function summarizeUsage(data, catalog, parameters) {
  if (!Array.isArray(data?.aggregates?.byModel)) {
    throw new Error("Usage source unavailable");
  }
  const providers = modelProviders(catalog);
  const rows = data.aggregates.byModel
    .filter((entry) => !isBookkeeping(entry))
    .map((entry) => modelRow(entry, providers))
    .toSorted(
      (a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1) || a.model.localeCompare(b.model),
    );
  const nativeTotal = counter(data.totals?.totalTokens);
  const attributedTotal = sum(
    data.aggregates.byModel.map((entry) => counter(entry.totals?.totalTokens)),
  );
  const modelCoverage =
    nativeTotal === null || attributedTotal === null
      ? "unknown"
      : nativeTotal === attributedTotal
        ? "complete"
        : "partial";
  const sourceCoverage = data.cacheStatus?.status === "fresh" ? "complete" : "partial";
  const totalsPartial = sourceCoverage !== "complete" || modelCoverage !== "complete";
  if (!rows.length && totalsPartial) {
    throw new Error("Usage source is not ready");
  }
  const updatedAt = Number.isFinite(data.updatedAt) ? new Date(data.updatedAt) : null;
  return {
    range: {
      startDate: parameters.startDate,
      endDate: parameters.endDate,
      timeZone: parameters.timeZone,
    },
    dataUpdatedAt:
      updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : null,
    totalsCoverage: totalsPartial ? "partial" : "complete",
    sourceCoverage,
    modelCoverage,
    attributionCoverage: rows.some((row) => row.attribution === "unknown") ? "partial" : "complete",
    sessionsCoverage: sessionCoverage(data, providers, parameters, rows),
    reportedProviderRows: rows.filter((row) => row.attribution === "reported").length,
    mappedProviderRows: rows.filter((row) => row.attribution === "mapped").length,
    unknownProviderRows: rows.filter((row) => row.attribution === "unknown").length,
    excludedBookkeepingRows: data.aggregates.byModel.filter(isBookkeeping).length,
    rows,
  };
}

function dailyModelRow(entry, providers) {
  return {
    date: entry.date,
    ...modelRow(
      {
        ...entry,
        totals: { ...entry.totals, totalTokens: entry.tokens },
      },
      providers,
    ),
  };
}

function validDate(value, parameters) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value &&
    value >= parameters.startDate &&
    value <= parameters.endDate
  );
}

export function summarizeDailyUsage(data, catalog, parameters) {
  const unavailable = (message) => ({ status: "unavailable", message, rows: [] });
  if (!Array.isArray(data?.aggregates?.modelDaily)) {
    return unavailable("Daily usage is unavailable in this snapshot.");
  }
  const providers = modelProviders(catalog);
  const entries = data.aggregates.modelDaily.filter((entry) => !isBookkeeping(entry));
  if (entries.some((entry) => !validDate(entry.date, parameters))) {
    return unavailable("The usage source returned an invalid or out-of-range day.");
  }
  const rows = entries
    .map((entry) => dailyModelRow(entry, providers))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const period = summarizeUsage(data, catalog, parameters);
  const reconciled = reconcileModelRows(period.rows, rows);
  const complete =
    period.totalsCoverage === "complete" &&
    reconciled &&
    rows.every((row) => row.totalTokens !== null && row.responses !== null);
  return {
    status: complete ? "complete" : "partial",
    message: !reconciled
      ? "Some recorded usage cannot yet be assigned to these calendar days."
      : complete
        ? "Recorded usage by calendar day. Today is still in progress."
        : "Partial snapshot: missing daily values are unknown, not zero.",
    rows,
  };
}

export function sessionUsageLinks(data, catalog, parameters, usageUrl, buildSessionPath) {
  if (typeof buildSessionPath !== "function") {
    throw new Error("Canonical session route builder unavailable");
  }
  const providers = modelProviders(catalog);
  return (data.sessions ?? []).flatMap((session) => {
    const recordedRows = session.usage?.modelUsage;
    if (!Array.isArray(recordedRows)) {
      return [];
    }
    const rows = recordedRows
      .filter((entry) => !isBookkeeping(entry))
      .map((entry) => modelRow(entry, providers));
    if (!rows.length) {
      return [];
    }
    const route = buildSessionPath({
      namespace: "chat",
      sessionKey: session.key,
      exactKey: true,
    });
    if (!route) {
      throw new Error("Native usage session has no supported session route");
    }
    const daily = session.usage?.dailyModelUsage;
    const dailyRows =
      Array.isArray(daily) && daily.every((entry) => validDate(entry.date, parameters))
        ? daily
            .filter((entry) => !isBookkeeping(entry))
            .map((entry) => dailyModelRow(entry, providers))
        : null;
    return [
      {
        label: bounded(session.label || session.key, 90),
        url: new URL(route, usageUrl).href,
        linkKind: "canonical",
        rows,
        dailyRows,
        dailyCoverage:
          dailyRows === null
            ? "unavailable"
            : reconcileModelRows(rows, dailyRows)
              ? "complete"
              : "partial",
      },
    ];
  });
}
