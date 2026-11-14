import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_CRON_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function resolveCronDetailRetentionMs(cfg: OpenClawConfig): number | undefined {
  const value = cfg.cron?.runDetailRetention;
  return value === false
    ? undefined
    : value === undefined
      ? DEFAULT_CRON_DETAIL_RETENTION_MS
      : parseDurationMs(value, { defaultUnit: "d" });
}
