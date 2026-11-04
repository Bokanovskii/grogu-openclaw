import { z } from "zod";

export const WORKER_TRIGGER_CONTRACT_VERSION = 1;
const MAX_TOOL_ARGS_BYTES = 4 * 1024;
const MAX_CONTINUATIONS = 8;
const MAX_CONTINUATION_FIRES = 3;
const MAX_CONTINUATION_TTL_MS = 24 * 60 * 60_000;

const safeName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/);
const safePath = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine(
    (value) =>
      !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)),
  );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const sourceSchema = z.enum(["gmail", "messages", "calendar"]);
const fieldSelectorsSchema = z
  .object({
    id: safePath,
    timestamp: safePath,
    secondaryId: safePath.optional(),
    start: safePath.optional(),
    end: safePath.optional(),
    status: safePath.optional(),
  })
  .strict();

export const workerTriggerTemplateSchema = z
  .object({
    version: z.literal(WORKER_TRIGGER_CONTRACT_VERSION),
    source: sourceSchema,
    tool: z
      .object({
        server: safeName,
        name: safeName,
        schemaSha256: sha256,
        args: z.record(z.string(), z.unknown()),
      })
      .strict(),
    result: z
      .object({
        complete: safePath,
        completeValue: scalarSchema.default(true),
        guards: z
          .array(z.object({ path: safePath, equals: scalarSchema }).strict())
          .max(8)
          .default([]),
        items: safePath,
        cursor: safePath.optional(),
        failure: safePath.optional(),
        fields: fieldSelectorsSchema,
      })
      .strict(),
    maxItems: z.number().int().min(1).max(100).default(50),
    continuation: z
      .object({
        delayMs: z.number().int().min(60_000).max(MAX_CONTINUATION_TTL_MS),
        intervalMs: z.number().int().min(60_000).max(MAX_CONTINUATION_TTL_MS),
        maxOpen: z.number().int().min(1).max(MAX_CONTINUATIONS).default(MAX_CONTINUATIONS),
        maxFires: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTINUATION_FIRES)
          .default(MAX_CONTINUATION_FIRES),
        ttlMs: z
          .number()
          .int()
          .min(60_000)
          .max(MAX_CONTINUATION_TTL_MS)
          .default(MAX_CONTINUATION_TTL_MS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value.tool.args), "utf8") > MAX_TOOL_ARGS_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool", "args"],
        message: "worker trigger tool args exceed 4 KiB",
      });
    }
    if (
      value.source === "calendar" &&
      (value.result.fields.start === undefined || value.result.fields.end === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result", "fields"],
        message: "calendar adapters require start and end selectors",
      });
    }
    const argKeys = Object.keys(value.tool.args);
    if (
      value.source === "gmail" &&
      (value.tool.server !== "gmail" ||
        value.tool.name !== "gmail_search" ||
        value.tool.args.include_body !== false ||
        value.tool.args.sanitize_content !== true ||
        typeof value.tool.args.query !== "string" ||
        typeof value.tool.args.max !== "number" ||
        !Number.isSafeInteger(value.tool.args.max) ||
        value.tool.args.max < 1 ||
        value.tool.args.max > 100 ||
        value.result.complete !== "structuredContent.exit_code" ||
        value.result.completeValue !== 0 ||
        ![
          ["isError", false],
          ["structuredContent.tool", "gmail_search"],
          ["structuredContent.risk", "read"],
        ].every(([path, equals]) =>
          value.result.guards.some((guard) => guard.path === path && guard.equals === equals),
        ) ||
        argKeys.some((key) => !["query", "max", "include_body", "sanitize_content"].includes(key)))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "gmail adapter requires the reviewed metadata-only gmail_search contract",
      });
    }
    if (
      value.source === "messages" &&
      (value.tool.name !== "recent_messages" ||
        value.tool.args.include_text !== false ||
        (value.tool.args.limit !== undefined &&
          (typeof value.tool.args.limit !== "number" ||
            !Number.isSafeInteger(value.tool.args.limit) ||
            value.tool.args.limit < 1 ||
            value.tool.args.limit > 100)) ||
        (value.tool.args.offset !== undefined &&
          (typeof value.tool.args.offset !== "number" ||
            !Number.isSafeInteger(value.tool.args.offset) ||
            value.tool.args.offset < 0)) ||
        argKeys.some(
          (key) => !["since_ts", "before_ts", "limit", "offset", "include_text"].includes(key),
        ))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "messages adapter requires the reviewed metadata-only recent_messages contract",
      });
    }
    if (
      value.source === "calendar" &&
      (value.tool.name !== "icloud_calendar_events" ||
        typeof value.tool.args.from !== "string" ||
        typeof value.tool.args.to !== "string" ||
        typeof value.tool.args.calendar !== "string" ||
        typeof value.tool.args.limit !== "number" ||
        !Number.isSafeInteger(value.tool.args.limit) ||
        value.tool.args.limit < 1 ||
        value.tool.args.limit > 100 ||
        argKeys.some((key) => !["from", "to", "calendar", "limit"].includes(key)))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "calendar adapter requires the reviewed icloud_calendar_events contract",
      });
    }
  });

export type WorkerTriggerTemplate = z.infer<typeof workerTriggerTemplateSchema>;

type WorkerTriggerInput = {
  template: WorkerTriggerTemplate;
  observation: unknown;
  previousState: unknown;
  nowMs: number;
};

/** Pure source adapter used both by synthetic proof and the rendered headless trigger. */
export function evaluateWorkerTrigger(input: WorkerTriggerInput) {
  const contractVersion = 1;
  const maxStateBytes = 16 * 1024;
  const { template, observation, nowMs } = input;
  const readPath = (value: unknown, selector: string): unknown => {
    let current = value;
    for (const part of selector.split(".")) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };
  const scalar = (value: unknown, label: string): string | number | null => {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    throw new Error(`worker_source_malformed:${label}`);
  };
  const previous =
    input.previousState &&
    typeof input.previousState === "object" &&
    !Array.isArray(input.previousState) &&
    (input.previousState as { version?: unknown }).version === contractVersion
      ? (input.previousState as {
          version: 1;
          sources?: Record<
            string,
            { fingerprint?: string; cursor?: string | number | null; lastSuccessAt?: number }
          >;
          continuations?: Array<{
            id: string;
            source: string;
            dueAt: number;
            expiresAt: number;
            fires: number;
          }>;
        })
      : { version: 1 as const, sources: {}, continuations: [] };
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("worker_source_malformed:root");
  }
  const complete = readPath(observation, template.result.complete);
  const guardsPass = template.result.guards.every(
    (guard) => readPath(observation, guard.path) === guard.equals,
  );
  if (complete !== template.result.completeValue || !guardsPass) {
    const failure = template.result.failure
      ? readPath(observation, template.result.failure)
      : undefined;
    const kind =
      failure &&
      typeof failure === "object" &&
      !Array.isArray(failure) &&
      typeof (failure as { kind?: unknown }).kind === "string"
        ? (failure as { kind: string }).kind
        : "incomplete";
    throw new Error(`worker_source_failure:${kind}`);
  }
  const items = readPath(observation, template.result.items);
  if (!Array.isArray(items) || items.length > template.maxItems) {
    throw new Error("worker_source_malformed:items");
  }
  const fields = template.result.fields;
  const normalized = items.map((item, index) => {
    const base: Record<string, string | number | null> = {
      id: scalar(readPath(item, fields.id), `items.${index}.id`),
      timestamp: scalar(readPath(item, fields.timestamp), `items.${index}.timestamp`),
    };
    if (fields.secondaryId) {
      base.secondaryId = scalar(readPath(item, fields.secondaryId), `items.${index}.secondaryId`);
    }
    if (fields.start) {
      base.start = scalar(readPath(item, fields.start), `items.${index}.start`);
    }
    if (fields.end) {
      base.end = scalar(readPath(item, fields.end), `items.${index}.end`);
    }
    if (fields.status) {
      base.status = scalar(readPath(item, fields.status), `items.${index}.status`);
    }
    return base;
  });
  const fingerprint = JSON.stringify(normalized);
  if (new TextEncoder().encode(fingerprint).byteLength > maxStateBytes / 2) {
    throw new Error("worker_source_malformed:fingerprint");
  }
  const cursor = template.result.cursor
    ? scalar(readPath(observation, template.result.cursor), "cursor")
    : null;
  const priorSource = previous.sources?.[template.source];
  const baseline = priorSource?.fingerprint === undefined;
  const changed = !baseline && priorSource.fingerprint !== fingerprint;
  const sources = {
    ...previous.sources,
    [template.source]: { fingerprint, cursor, lastSuccessAt: nowMs },
  };
  let continuations = (previous.continuations ?? []).filter(
    (entry) =>
      entry &&
      typeof entry.id === "string" &&
      entry.source === template.source &&
      Number.isFinite(entry.dueAt) &&
      Number.isFinite(entry.expiresAt) &&
      Number.isSafeInteger(entry.fires) &&
      entry.expiresAt > nowMs &&
      entry.fires < template.continuation.maxFires,
  );
  const terminal = normalized.some((item) =>
    ["cancelled", "deleted", "completed", "closed", "terminal"].includes(
      typeof item.status === "string" ? item.status.toLowerCase() : "",
    ),
  );
  if (terminal) {
    continuations = [];
  }
  if (changed && !terminal) {
    const id = `${template.source}:${nowMs}:${fingerprint.length}`;
    continuations = [
      ...continuations.filter((entry) => entry.id !== id),
      {
        id,
        source: template.source,
        dueAt: nowMs + template.continuation.delayMs,
        expiresAt: nowMs + template.continuation.ttlMs,
        fires: 0,
      },
    ].slice(-template.continuation.maxOpen);
  }
  const dueIndex = continuations.findIndex((entry) => entry.dueAt <= nowMs);
  let message: string | undefined;
  if (changed) {
    message = JSON.stringify({
      version: contractVersion,
      kind: "source_delta",
      source: template.source,
      cursor,
      items: normalized,
    });
  } else if (dueIndex >= 0) {
    const due = continuations[dueIndex]!;
    const nextFires = due.fires + 1;
    if (nextFires >= template.continuation.maxFires) {
      continuations.splice(dueIndex, 1);
    } else {
      continuations[dueIndex] = {
        ...due,
        fires: nextFires,
        dueAt: nowMs + template.continuation.intervalMs,
      };
    }
    message = JSON.stringify({
      version: contractVersion,
      kind: "continuation_due",
      source: template.source,
      checkpointId: due.id,
      attempt: nextFires,
    });
  }
  const state = {
    version: contractVersion,
    sources,
    continuations,
  };
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > maxStateBytes) {
    throw new Error("worker_source_malformed:state");
  }
  return message ? { fire: true, message, state } : { fire: false, state };
}

export function renderWorkerTriggerScript(value: unknown): string {
  const template = workerTriggerTemplateSchema.parse(value);
  const embedded = JSON.stringify(template);
  return `const template = ${embedded};
const observation = await MCP[template.tool.server][template.tool.name](template.tool.args);
const evaluate = ${evaluateWorkerTrigger.toString()};
return evaluate({ template, observation, previousState: trigger.state, nowMs: Date.now() });`;
}
