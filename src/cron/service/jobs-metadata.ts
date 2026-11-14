import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronJobPatch, CronStoredJob } from "../types.js";

/** Omitted patch fields preserve metadata; explicit blank values clear it. */
export function applyCronGroupMetadata(job: CronStoredJob, patch: CronJobPatch): void {
  for (const field of ["groupId", "notificationDescription"] as const) {
    if (!(field in patch)) {
      continue;
    }
    const value = normalizeOptionalString(patch[field]);
    if (value) {
      job[field] = value;
    } else {
      delete job[field];
    }
  }
}
