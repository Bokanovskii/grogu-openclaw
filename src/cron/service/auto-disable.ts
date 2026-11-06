/** Shared state and owner-notification policy for cron auto-disable transitions. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import { resolveCronExecutionRetryHint } from "../retry-hint.js";
import { isSystemMonitorDeclaration } from "../system-owned-declaration.js";
import type { CronJob, CronJobState, CronRunErrorClassification } from "../types.js";
import { cronNotificationJob } from "./notification-intents.js";
import type { DeferredCronNotifications } from "./state.js";

type CronAutoDisableReason = NonNullable<CronJobState["autoDisabled"]>["reason"];

/**
 * Run failures get more room than schedule errors (10 vs. 3) because provider
 * and network errors are often transient, and restart-interrupted runs count too.
 */
const MAX_CONSECUTIVE_RUN_FAILURES = 10;

function autoDisableReasonLabel(reason: CronAutoDisableReason): string {
  return reason === "consecutive-failures" ? "run failures" : "schedule errors";
}

/** Records one canonical auto-disable fact and queues its owning-agent notification. */
export function autoDisableCronJob(params: {
  job: CronJob;
  reason: CronAutoDisableReason;
  atMs: number;
  consecutiveErrors: number;
  deferredNotifications: DeferredCronNotifications;
}): boolean {
  const { job } = params;
  // Gateway convergence owns these jobs; clients cannot re-enable them, so failures stay visible while they retry on schedule.
  if (isSystemMonitorDeclaration(job.declarationKey)) {
    return false;
  }
  if (!job.enabled || job.state.autoDisabled) {
    return false;
  }

  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  job.state.autoDisabled = {
    reason: params.reason,
    atMs: params.atMs,
    consecutiveErrors: params.consecutiveErrors,
  };

  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  const errorReason =
    params.reason === "consecutive-failures" ? job.state.lastErrorReason : undefined;
  const text = [
    `⚠️ Automation "${name}" was auto-disabled after ${params.consecutiveErrors} consecutive ${autoDisableReasonLabel(params.reason)}.`,
    ...cronFailureDetailLines(errorReason),
    `Fix the underlying cause, then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
  ].join("\n");
  params.deferredNotifications.push({ kind: "auto-disabled", job: cronNotificationJob(job), text });
  return true;
}

/**
 * Recurring jobs are never switched off for run failures: a broken source or tool can heal
 * on its own, and a permanently disabled automation fails silently. Once a non-retryable
 * streak reaches the limit, the owning agent is told once and the job stays on its capped
 * error backoff (hourly at worst), so it resumes by itself when the cause clears.
 * Returns true when that notice was queued, so it owns this failure's notification.
 */
export function notifyCronFailureStreak(params: {
  job: CronJob;
  atMs: number;
  errorClassification?: CronRunErrorClassification;
  deferredNotifications: DeferredCronNotifications;
}): boolean {
  const consecutiveErrors = params.job.state.consecutiveErrors ?? 0;
  const retryable =
    params.errorClassification?.kind === "permanent"
      ? false
      : resolveCronExecutionRetryHint({
          error: params.job.state.lastError,
          classifiedReason:
            params.errorClassification?.kind === "reason"
              ? params.errorClassification.reason
              : params.job.state.lastErrorReason,
        }).retryable;
  const { job } = params;
  if (
    (job.schedule.kind !== "cron" && job.schedule.kind !== "every") ||
    consecutiveErrors !== MAX_CONSECUTIVE_RUN_FAILURES ||
    retryable ||
    isSystemMonitorDeclaration(job.declarationKey)
  ) {
    return false;
  }
  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  const text = [
    `⚠️ Automation "${name}" has failed ${consecutiveErrors} times in a row. It stays enabled and keeps retrying on its error backoff (at most hourly).`,
    ...cronFailureDetailLines(job.state.lastErrorReason),
    "Fix the underlying cause; the next successful run clears the failure streak.",
  ].join("\n");
  // Reuses the owner-queue route of auto-disable notices; the job itself is left enabled.
  params.deferredNotifications.push({ kind: "auto-disabled", job: cronNotificationJob(job), text });
  return true;
}
