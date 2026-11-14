import type { CronCompactJob, CronJob, CronJobsListResult } from "../api/types.ts";
import type { CronFormState } from "../lib/cron/types.ts";

export function cronJobsListResponse(
  jobs: CronJob[] = [],
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "cron-jobs-fixture",
    groups: [],
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

export function compactCronJobFixture(job: CronJob): CronCompactJob {
  return {
    id: job.id,
    name: job.name,
    displayName: job.displayName,
    groupId: job.groupId,
    notificationDescription: job.notificationDescription,
    agentId: job.agentId,
    enabled: job.enabled,
    updatedAtMs: job.updatedAtMs,
    scheduleKind: job.schedule.kind,
    ...(job.schedule.kind === "at" || job.schedule.kind === "every" || job.schedule.kind === "cron"
      ? { schedule: job.schedule }
      : {}),
    nextRunAt:
      job.state.nextRunAtMs === undefined ? null : new Date(job.state.nextRunAtMs).toISOString(),
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    lastRunAt:
      job.state.lastRunAtMs === undefined ? null : new Date(job.state.lastRunAtMs).toISOString(),
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    runningAtMs: job.state.runningAtMs,
    autoDisabled: job.state.autoDisabled,
  };
}

type CronListFixtureInput = Omit<CronJobsListResult, "groups"> &
  Partial<Pick<CronJobsListResult, "groups">>;

type CronListFixtureCase = {
  match?: Record<string, unknown>;
  response: CronListFixtureInput;
};

export function cronListResponseFixture(input: CronListFixtureInput | CronListFixtureCase[]) {
  const cases: CronListFixtureCase[] = Array.isArray(input) ? input : [{ response: input }];
  return {
    cases: cases.flatMap((entry) => [
      {
        match: { ...entry.match, compact: true },
        response: {
          groups: [],
          ...entry.response,
          jobs: entry.response.jobs.map(compactCronJobFixture),
        },
      },
      { ...entry, response: { groups: [], ...entry.response } },
    ]),
  };
}

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  displayName: "",
  groupId: "",
  notificationDescription: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: false,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};
