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

type ManagedJob = Readonly<{
  logicalName: string;
  id: string;
  patch: CronUpdateParams["patch"];
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
