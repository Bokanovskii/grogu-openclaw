import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { z } from "zod";
import {
  CronAddJobResultSchema,
  CronJobSchema,
  CronUpdateParamsSchema,
} from "../packages/gateway-protocol/src/schema/cron.js";
import type {
  CronJob,
  CronUpdateParams,
} from "../packages/gateway-protocol/src/schema/cron.types.js";
import { readGroguPrivateProfileDocument } from "../src/agents/grogu-private-profile.js";
import {
  callNative,
  createPrivateArtifactDirectory,
  runNative,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";
import {
  renderWorkerTriggerScript,
  workerTriggerScriptSha256,
  workerTriggerTemplateSchema,
  type WorkerTriggerTemplateId,
} from "./worker-trigger-templates.js";

type ManagedJob = Readonly<{
  logicalName: string;
  id: string;
  patch: CronUpdateParams["patch"];
}>;

type ManagedWorkerTrigger = Readonly<{
  logicalName: string;
  id: string;
  trigger: NonNullable<CronUpdateParams["patch"]["trigger"]>;
  contractVersion: 1;
  templateId: WorkerTriggerTemplateId;
  schemaSha256: string;
  toolsAllow: string[];
  triggerSha256: string;
}>;

function managedJobs(profile: OperatorProfile): ManagedJob[] {
  const document = readGroguPrivateProfileDocument(profile.profileFile);
  const native = document?.native;
  if (!native || typeof native !== "object" || !("jobs" in native) || !Array.isArray(native.jobs)) {
    throw new Error("Private native.jobs bindings are required for bootstrap");
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  return native.jobs.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("logicalName" in entry) ||
      typeof entry.logicalName !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(entry.logicalName) ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("patch" in entry) ||
      !Value.Check(CronUpdateParamsSchema, { id: entry.id, patch: entry.patch }) ||
      names.has(entry.logicalName) ||
      ids.has(entry.id)
    ) {
      throw new Error("Invalid or duplicate private native job binding");
    }
    names.add(entry.logicalName);
    ids.add(entry.id);
    const update = Value.Decode(CronUpdateParamsSchema, { id: entry.id, patch: entry.patch });
    if (
      Object.keys(update.patch).some((key) => !["name", "displayName", "description"].includes(key))
    ) {
      throw new Error(
        "Bootstrap preserves live job state, enabled/model/delivery choices and schedules; migrate these explicitly",
      );
    }
    return { logicalName: entry.logicalName, id: entry.id, patch: update.patch };
  });
}

export function parseManagedWorkerTriggers(value: unknown): ManagedWorkerTrigger[] {
  if (!Array.isArray(value)) {
    throw new Error("Private native.workerTriggers bindings are required for worker bootstrap");
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  const managed = value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("logicalName" in entry) ||
      typeof entry.logicalName !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(entry.logicalName) ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("template" in entry) ||
      !workerTriggerTemplateSchema.safeParse(entry.template).success ||
      !Value.Check(CronUpdateParamsSchema, {
        id: entry.id,
        patch: { trigger: { script: renderWorkerTriggerScript(entry.template) } },
      }) ||
      names.has(entry.logicalName) ||
      ids.has(entry.id)
    ) {
      throw new Error("Invalid or duplicate private native worker trigger binding");
    }
    names.add(entry.logicalName);
    ids.add(entry.id);
    const template = workerTriggerTemplateSchema.parse(entry.template);
    const script = renderWorkerTriggerScript(template);
    const update = Value.Decode(CronUpdateParamsSchema, {
      id: entry.id,
      patch: { trigger: { script } },
    });
    if (!update.patch.trigger) {
      throw new Error("Worker trigger binding must install a nonempty trigger script");
    }
    return {
      logicalName: entry.logicalName,
      id: entry.id,
      trigger: update.patch.trigger,
      contractVersion: 1 as const,
      templateId: template.templateId,
      schemaSha256: template.schemaSha256,
      toolsAllow: [...template.toolsAllow],
      triggerSha256: workerTriggerScriptSha256(script),
    };
  });
  if (managed.length !== 2 || new Set(managed.map((entry) => entry.templateId)).size !== 2) {
    throw new Error(
      "Managed worker triggers must bind exactly the two existing jobs to one Gmail and one Messages collector",
    );
  }
  return managed;
}

function managedWorkerTriggers(profile: OperatorProfile): ManagedWorkerTrigger[] {
  const document = readGroguPrivateProfileDocument(profile.profileFile);
  const native = document?.native;
  return parseManagedWorkerTriggers(
    native && typeof native === "object" && "workerTriggers" in native
      ? native.workerTriggers
      : undefined,
  );
}

const mcpProbeSchema = z
  .object({
    toolSchemas: z.record(
      z.string().min(1),
      z
        .object({
          schemaFormat: z.literal("openclaw-effective-input-schema/v1"),
          schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function readWorkerSchemaPin(probe: unknown, publicToolName: string): string {
  const parsed = mcpProbeSchema.parse(probe);
  const schema = parsed.toolSchemas[publicToolName];
  if (!schema) {
    throw new Error(`Native MCP probe did not publish schema metadata for ${publicToolName}`);
  }
  return schema.schemaSha256;
}

async function verifyWorkerSchemaPins(
  profile: OperatorProfile,
  desired: readonly ManagedWorkerTrigger[],
  directory: string,
) {
  const verified: Record<string, string> = {};
  for (const worker of desired) {
    const publicToolName =
      worker.templateId === "gmail-metadata-v1"
        ? "gmail__gmail_search"
        : "seaglass__recent_messages";
    const serverName = publicToolName.split("__", 1)[0];
    if (!serverName) {
      throw new Error(`Native worker ${worker.logicalName} has an invalid collector tool`);
    }
    const probe = await runNative(profile, ["mcp", "probe", serverName, "--json"], directory);
    const actual = readWorkerSchemaPin(probe, publicToolName);
    if (actual !== worker.schemaSha256) {
      throw new Error(
        `Native worker ${worker.logicalName} schema pin does not match the live MCP catalog`,
      );
    }
    verified[publicToolName] = actual;
  }
  return verified;
}

export function planManagedJobPatch(
  logicalName: string,
  current: CronJob,
  desired: CronUpdateParams["patch"],
) {
  if (current.state.runningAtMs !== undefined) {
    throw new Error(
      `Managed job ${logicalName} is running; bootstrap never cancels productive work`,
    );
  }
  if (!current.configRevision) {
    throw new Error(`Managed job ${logicalName} has no native configuration revision`);
  }
  const entries = Object.entries(desired).filter(
    ([key, value]) => !isDeepStrictEqual(current[key as keyof CronJob], value),
  );
  return entries.length
    ? {
        id: current.id,
        expectedConfigRevision: current.configRevision,
        patch: Object.fromEntries(entries),
      }
    : null;
}

export function readUpdatedManagedJob(response: unknown): CronJob {
  if (!Value.Check(CronAddJobResultSchema, response)) {
    throw new Error("Native bootstrap returned an invalid update receipt");
  }
  return response;
}

function preservedWorkerJobDefinition(job: CronJob) {
  return {
    declarationKey: job.declarationKey,
    displayName: job.displayName,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    schedule: job.schedule,
    pacing: job.pacing,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    delivery: job.delivery,
    failureAlert: job.failureAlert,
  };
}

export function workerJobDefinitionSha256(job: CronJob): string {
  return createHash("sha256")
    .update(stableStringify(preservedWorkerJobDefinition(job)))
    .digest("hex");
}

export function assertWorkerJobDefinitionPreserved(
  logicalName: string,
  before: CronJob,
  after: CronJob,
): void {
  if (
    !isDeepStrictEqual(preservedWorkerJobDefinition(before), preservedWorkerJobDefinition(after))
  ) {
    throw new Error(`Native worker bootstrap ${logicalName} changed non-trigger job configuration`);
  }
}

export async function reconcileManagedJobs(profile: OperatorProfile, apply = false) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const planned: { logicalName: string; update: ReturnType<typeof planManagedJobPatch> }[] = [];
  for (const desired of managedJobs(profile)) {
    const response = await callNative(profile, "cron.get", { id: desired.id }, directory);
    if (!Value.Check(CronJobSchema, response)) {
      throw new Error(`Native managed job ${desired.logicalName} returned an invalid definition`);
    }
    planned.push({
      logicalName: desired.logicalName,
      update: planManagedJobPatch(desired.logicalName, response, desired.patch),
    });
  }
  const planReceipt = await writePrivateReceipt(directory, "bootstrap-plan.json", {
    planned,
    apply,
  });
  for (const item of planned) {
    if (apply && item.update) {
      const response = await callNative(profile, "cron.update", item.update, directory);
      const remaining = planManagedJobPatch(
        item.logicalName,
        readUpdatedManagedJob(response),
        item.update.patch,
      );
      if (remaining) {
        throw new Error(`Native bootstrap ${item.logicalName} did not converge`);
      }
    }
  }
  return {
    mode: apply ? "applied" : "preview",
    jobs: planned.map((item) => ({ logicalName: item.logicalName, changed: item.update !== null })),
    planReceipt,
    privateReceipts: directory,
  };
}

export async function bootstrapGroguWidgetSandbox(profile: OperatorProfile, apply = false) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const configuration = z.object({
    mcp: z
      .object({
        apps: z.object({ sameOriginSandbox: z.boolean().optional() }).optional(),
      })
      .optional(),
  });
  const snapshot = z
    .object({
      valid: z.literal(true),
      hash: z.string().min(1),
      config: configuration,
    })
    .parse(await callNative(profile, "config.get", {}, directory));
  const current = snapshot.config.mcp?.apps?.sameOriginSandbox;
  const changed = current === undefined;
  const planReceipt = await writePrivateReceipt(directory, "widget-sandbox-plan.json", {
    apply,
    changed,
    sameOriginSandbox: current ?? true,
    restartRequired: changed,
  });
  if (apply && changed) {
    const result = z.object({ ok: z.literal(true), config: configuration }).parse(
      await callNative(
        profile,
        "config.patch",
        {
          baseHash: snapshot.hash,
          raw: JSON.stringify({ mcp: { apps: { sameOriginSandbox: true } } }),
          note: "Enable Grogu's single-origin widget sandbox",
        },
        directory,
      ),
    );
    if (result.config.mcp?.apps?.sameOriginSandbox !== true) {
      throw new Error("Native configuration did not enable the widget sandbox");
    }
  }
  return {
    mode: apply ? "applied" : "preview",
    sameOriginSandbox: current ?? true,
    changed,
    restartRequired: changed,
    planReceipt,
    privateReceipts: directory,
  };
}

export async function reconcileWorkerTriggers(profile: OperatorProfile, apply = false) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const desiredWorkers = managedWorkerTriggers(profile);
  const schemaPins = await verifyWorkerSchemaPins(profile, desiredWorkers, directory);
  const planned: {
    logicalName: string;
    update: ReturnType<typeof planManagedJobPatch>;
    rollback: { id: string; trigger: CronJob["trigger"] | null };
    preservedConfigSha256: string;
    before: CronJob;
  }[] = [];
  for (const desired of desiredWorkers) {
    const response = await callNative(profile, "cron.get", { id: desired.id }, directory);
    if (!Value.Check(CronJobSchema, response)) {
      throw new Error(`Native worker ${desired.logicalName} returned an invalid definition`);
    }
    if (
      response.payload.kind !== "agentTurn" ||
      !isDeepStrictEqual(response.payload.toolsAllow ?? [], desired.toolsAllow)
    ) {
      throw new Error(
        `Native worker ${desired.logicalName} toolsAllow does not match the reviewed collector contract`,
      );
    }
    planned.push({
      logicalName: desired.logicalName,
      update: planManagedJobPatch(desired.logicalName, response, {
        trigger: desired.trigger,
      }),
      rollback: { id: response.id, trigger: response.trigger ?? null },
      preservedConfigSha256: workerJobDefinitionSha256(response),
      before: response,
    });
  }
  const planReceipt = await writePrivateReceipt(directory, "worker-bootstrap-plan.json", {
    apply,
    schemaPins,
    planned: planned.map(({ before: _before, ...item }) => item),
  });
  const applied: {
    logicalName: string;
    preservedConfigSha256: string;
  }[] = [];
  for (const item of planned) {
    if (apply && item.update) {
      const response = await callNative(profile, "cron.update", item.update, directory);
      const updated = readUpdatedManagedJob(response);
      assertWorkerJobDefinitionPreserved(item.logicalName, item.before, updated);
      const remaining = planManagedJobPatch(item.logicalName, updated, item.update.patch);
      if (remaining) {
        throw new Error(`Native worker bootstrap ${item.logicalName} did not converge`);
      }
      applied.push({
        logicalName: item.logicalName,
        preservedConfigSha256: workerJobDefinitionSha256(updated),
      });
    }
  }
  const resultReceipt = await writePrivateReceipt(directory, "worker-bootstrap-result.json", {
    apply,
    schemaPins,
    applied,
  });
  return {
    mode: apply ? "applied" : "preview",
    jobs: planned.map((item) => ({ logicalName: item.logicalName, changed: item.update !== null })),
    schemaPins,
    planReceipt,
    resultReceipt,
    privateReceipts: directory,
  };
}
