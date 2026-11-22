import { Value } from "typebox/value";
import {
  ProtectedAutomationDraftSchema,
  type ProtectedAgentCatalogDto,
  type ProtectedAutomationCatalog,
  type ProtectedAutomationDraft,
  type ProtectedAutomationDraftValidation,
  type ProtectedModel,
} from "../../packages/gateway-protocol/src/protected.js";
import { MAX_DATE_TIMESTAMP_MS } from "../../packages/gateway-protocol/src/schema/cron-shared.js";

const limits = {
  definitionBytes: 32_768,
  nameCodeUnits: 80,
  instructionsBytes: 16_384,
  whenToNotifyBytes: 4_096,
  doneWhenCodeUnits: 2_000,
} as const;

function capabilities(persistenceAvailable: boolean) {
  return {
    catalog: true,
    draftValidation: true,
    list: persistenceAvailable,
    create: persistenceAvailable,
    scheduleControl: false,
    run: false,
    sharing: false,
    notifications: false,
  } as const;
}
const cronCatalog: NonNullable<ProtectedAutomationCatalog["schedule"]["cron"]> = {
  format: "5-field",
  repeats: ["daily", "weekdays", "saturday"],
  timeZones: ["America/Los_Angeles"],
  timePrecision: "minute",
  staggerMs: 0,
  daylightSaving: {
    nonexistentLocalTime: "skip",
    repeatedLocalTime: "first",
  },
};

const tooLongMessages: Record<string, string> = {
  name: "The name exceeds the character limit.",
  instructions: "Instructions exceed the byte limit.",
  whenToNotify: "The notification rule exceeds the byte limit.",
  doneWhen: "The completion rule exceeds the character limit.",
};

function isProtectedAutomationDraft(value: unknown): value is ProtectedAutomationDraft {
  return Value.Check(ProtectedAutomationDraftSchema, value);
}

function error(field: string, code: string, message: string) {
  return { field, code, message };
}

function schemaErrors(value: unknown) {
  const errorsByField = new Map<string, { field: string; code: string; message: string }>();
  for (const validationError of Value.Errors(ProtectedAutomationDraftSchema, value)) {
    const field = validationError.instancePath.split("/").filter(Boolean).join(".");
    const key = field || "draft";
    const tooLongMessage =
      validationError.keyword === "maxLength" ? tooLongMessages[key] : undefined;
    const issue = tooLongMessage
      ? error(key, "too_long", tooLongMessage)
      : error(key, "invalid_value", "Enter a valid value.");
    const previous = errorsByField.get(key);
    if (!previous || (previous.code !== "too_long" && issue.code === "too_long")) {
      errorsByField.set(key, issue);
    }
  }
  return [...errorsByField.values()];
}

export function createProtectedAutomationCatalog(input: {
  agents: ProtectedAgentCatalogDto;
  models: readonly ProtectedModel[];
  calendarDraftValidationAvailable?: boolean;
  persistenceAvailable?: boolean;
}): ProtectedAutomationCatalog | undefined {
  const sparky = input.models.find((model) => model.provider === "sparky");
  if (
    !sparky?.thinking ||
    sparky.thinking.levels.length === 0 ||
    !sparky.thinking.levels.includes(sparky.thinking.default)
  ) {
    return undefined;
  }
  return {
    capabilities: { automations: capabilities(input.persistenceAvailable ?? true) },
    defaultAgentId: input.agents.defaultAgentId,
    agents: input.agents.agents,
    models: [sparky],
    schedule: {
      kinds: input.calendarDraftValidationAvailable ? ["every", "cron"] : ["every"],
      everyMs: { minimum: 1, maximum: MAX_DATE_TIMESTAMP_MS },
      ...(input.calendarDraftValidationAvailable ? { cron: cronCatalog } : {}),
    },
    limits,
  };
}

export function validateProtectedAutomationDraft(
  input: unknown,
  catalog: ProtectedAutomationCatalog,
): ProtectedAutomationDraftValidation {
  const model = catalog.models[0];
  if (!model?.thinking) {
    return {
      valid: false,
      errors: [error("model", "catalog_unavailable", "The Sparky catalog is unavailable.")],
    };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      valid: false,
      errors: [error("draft", "invalid_value", "Enter a valid draft.")],
    };
  }

  const candidate: Record<string, unknown> = { ...input };
  if (
    typeof candidate.doneWhen === "string" &&
    candidate.doneWhen.trim() === "" &&
    candidate.doneWhen.length <= limits.doneWhenCodeUnits
  ) {
    delete candidate.doneWhen;
  }

  const errors = schemaErrors(candidate);
  if (
    typeof candidate.name === "string" &&
    candidate.name.length > limits.nameCodeUnits &&
    !errors.some((entry) => entry.field === "name")
  ) {
    errors.push(error("name", "too_long", "The name exceeds the character limit."));
  }
  if (
    typeof candidate.doneWhen === "string" &&
    candidate.doneWhen.length > limits.doneWhenCodeUnits &&
    !errors.some((entry) => entry.field === "doneWhen")
  ) {
    errors.push(error("doneWhen", "too_long", "The completion rule exceeds the character limit."));
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  if (
    typeof candidate.instructions === "string" &&
    Buffer.byteLength(candidate.instructions, "utf8") > limits.instructionsBytes
  ) {
    errors.push(error("instructions", "too_long", "Instructions exceed the byte limit."));
  }
  if (
    typeof candidate.whenToNotify === "string" &&
    Buffer.byteLength(candidate.whenToNotify, "utf8") > limits.whenToNotifyBytes
  ) {
    errors.push(error("whenToNotify", "too_long", "The notification rule exceeds the byte limit."));
  }

  const draft = isProtectedAutomationDraft(candidate) ? candidate : undefined;
  if (draft) {
    if (!catalog.agents.some((agent) => agent.id === draft.agentId)) {
      errors.push(error("agentId", "unsupported_agent", "Choose an available agent."));
    }
    if (draft.model.id !== model.id) {
      errors.push(error("model", "unsupported_model", "Choose the available Sparky model."));
    }
    if (draft.thinking && !model.thinking.levels.includes(draft.thinking)) {
      errors.push(error("thinking", "unsupported_thinking", "Choose a supported reasoning level."));
    }
  }
  const resolvedDraft = draft
    ? { ...draft, thinking: draft.thinking ?? model.thinking.default }
    : undefined;
  if (resolvedDraft) {
    const scheduleError = validateSchedule(resolvedDraft.schedule, catalog);
    if (scheduleError) {
      errors.push(scheduleError);
    }
  }
  if (
    resolvedDraft &&
    Buffer.byteLength(JSON.stringify(resolvedDraft), "utf8") > limits.definitionBytes
  ) {
    errors.push(error("draft", "too_large", "The draft exceeds the size limit."));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  if (!resolvedDraft) {
    return {
      valid: false,
      errors: [error("draft", "invalid_value", "Enter a valid draft.")],
    };
  }

  return {
    valid: true,
    draft: resolvedDraft,
  };
}

function validateSchedule(
  schedule: ProtectedAutomationDraft["schedule"],
  catalog: ProtectedAutomationCatalog,
) {
  if (schedule.kind === "every") {
    const every = catalog.schedule.everyMs;
    return catalog.schedule.kinds.includes("every") &&
      every !== undefined &&
      schedule.everyMs >= every.minimum &&
      schedule.everyMs <= every.maximum
      ? undefined
      : error("schedule", "unsupported_schedule", "Choose a supported schedule.");
  }

  const cron = catalog.schedule.cron;
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|6)$/u.exec(schedule.expr);
  if (!catalog.schedule.kinds.includes("cron") || !cron) {
    return error("schedule", "unsupported_schedule", "Choose a supported schedule.");
  }
  if (!match) {
    return error("schedule", "unsupported_schedule", "Choose a supported repeat option.");
  }
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) {
    return error("schedule", "invalid_value", "Enter a valid local time.");
  }
  if (!cron.timeZones.includes(schedule.tz)) {
    return error("schedule", "unsupported_schedule", "Choose a supported time zone.");
  }
  return undefined;
}
