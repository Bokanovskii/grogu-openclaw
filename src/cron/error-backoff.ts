import { expectDefined } from "@openclaw/normalization-core";

/** Default retry delays applied after consecutive cron execution errors. */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

/** Resolves the retry backoff delay for a one-based consecutive error count. */
export function errorBackoffMs(
  consecutiveErrors: number,
  scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
  return expectDefined(scheduleMs[Math.max(0, idx)], "schedule ms entry at math.max(0, idx)");
}
