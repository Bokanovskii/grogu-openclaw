import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
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
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";
import {
  WORKER_TRIGGER_CONTRACT_VERSION,
  renderWorkerTriggerScript,
  workerTriggerTemplateSchema,
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
  return value.map((entry: unknown) => {
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
    const update = Value.Decode(CronUpdateParamsSchema, {
      id: entry.id,
      patch: { trigger: { script: renderWorkerTriggerScript(entry.template) } },
    });
    if (!update.patch.trigger) {
      throw new Error("Worker trigger binding must install a nonempty trigger script");
    }
    return {
      logicalName: entry.logicalName,
      id: entry.id,
      trigger: update.patch.trigger,
      contractVersion: WORKER_TRIGGER_CONTRACT_VERSION,
    };
  });
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

export async function reconcileWorkerTriggers(profile: OperatorProfile, apply = false) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const planned: {
    logicalName: string;
    update: ReturnType<typeof planManagedJobPatch>;
    rollback: { id: string; trigger: CronJob["trigger"] | null };
  }[] = [];
  for (const desired of managedWorkerTriggers(profile)) {
    const response = await callNative(profile, "cron.get", { id: desired.id }, directory);
    if (!Value.Check(CronJobSchema, response)) {
      throw new Error(`Native worker ${desired.logicalName} returned an invalid definition`);
    }
    planned.push({
      logicalName: desired.logicalName,
      update: planManagedJobPatch(desired.logicalName, response, {
        trigger: desired.trigger,
      }),
      rollback: { id: response.id, trigger: response.trigger ?? null },
    });
  }
  const planReceipt = await writePrivateReceipt(directory, "worker-bootstrap-plan.json", {
    apply,
    planned,
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
        throw new Error(`Native worker bootstrap ${item.logicalName} did not converge`);
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
