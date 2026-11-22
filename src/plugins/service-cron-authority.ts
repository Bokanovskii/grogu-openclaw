import type { CronJobExecutionAuthority } from "../cron/service/state.js";
import { PLUGIN_SERVICE_CRON_JOB_PREFIX, type CronJob } from "../cron/types.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginServiceSchedulerOwner } from "./service-scheduler.js";
import type { PluginServicesHandle } from "./services.js";
import type { OpenClawPluginServiceContext } from "./types.js";

export type OwnedPluginService = {
  owner: PluginServicesOwner;
  id: string;
  pluginId: string;
  registration: PluginServiceRegistration;
  registry: PluginRegistry;
  diagnosticsExporter: boolean;
  stop?: () => unknown;
  startup?: Promise<void>;
  startupConsumer?: PluginInstanceConsumer;
  stopping?: Promise<unknown>;
  reloading?: Promise<void>;
  cleaned: boolean;
  cleanupErrors: unknown[];
  cleanupReporting?: Promise<unknown>;
  stopRequested: boolean;
  stopNodeInvocations?: () => void;
  health: NonNullable<OpenClawPluginServiceContext["serviceHealth"]>;
  lease: PluginRuntimeCapabilityLease;
  scheduling: PluginServiceSchedulerOwner;
  authorizeCronJob?: (job: CronJob) => Promise<CronJobExecutionAuthority>;
  assertInstanceCurrent?: () => void;
};

export type PluginServicesOwner = {
  services: OwnedPluginService[];
  attempts: WeakMap<PluginServiceRegistration, OwnedPluginService>;
  registrations: Set<PluginServiceRegistration>;
  stopped: Set<PluginServiceRegistration>;
  closed: boolean;
};

export const serviceOwners = new WeakMap<PluginServicesHandle, PluginServicesOwner>();

export function cronJobPrefix(entry: Pick<PluginServiceRegistration, "pluginId" | "id">) {
  return `${PLUGIN_SERVICE_CRON_JOB_PREFIX}${encodeURIComponent(entry.pluginId)}:${encodeURIComponent(entry.id)}:`;
}

/** Dispatch uses the current service owner; a stored namespace is routing, never authority. */
export async function resolvePluginServiceCronExecutionAuthority(
  handle: PluginServicesHandle | null | undefined,
  job: CronJob,
): Promise<CronJobExecutionAuthority | undefined> {
  if (!job.declarationKey?.startsWith(PLUGIN_SERVICE_CRON_JOB_PREFIX)) {
    return undefined;
  }
  if (job.payload.kind !== "agentTurn") {
    throw new Error("Plugin-service execution authority requires a native agentTurn job.");
  }
  const owner = handle && serviceOwners.get(handle);
  const entry = owner?.services.find(
    (candidate) =>
      candidate.owner === owner &&
      job.declarationKey?.startsWith(cronJobPrefix(candidate.registration)),
  );
  const authorize = entry?.authorizeCronJob;
  if (!owner || !entry || !authorize) {
    throw new Error("Native job execution authority service is unavailable.");
  }
  const assertServiceCurrent = () => {
    entry.assertInstanceCurrent?.();
    entry.lease.assertActive("cron execution authority");
    const currentOwner = entry.owner;
    if (
      currentOwner.closed ||
      entry.stopRequested ||
      entry.startup ||
      !currentOwner.registrations.has(entry.registration) ||
      currentOwner.stopped.has(entry.registration)
    ) {
      throw new Error("Native job execution authority service is not current.");
    }
  };
  assertServiceCurrent();
  const authority = await authorize(job);
  assertServiceCurrent();
  authority.assertInvocationCurrent();
  return {
    toolsAllow: authority.toolsAllow,
    toolBindings: authority.toolBindings,
    assertInvocationCurrent: () => {
      assertServiceCurrent();
      authority.assertInvocationCurrent();
      assertServiceCurrent();
    },
  };
}
