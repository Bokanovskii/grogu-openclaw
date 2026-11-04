import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronRunErrorClassification } from "./types.js";

/** Exact local admission failures emitted before Sparky provider dispatch. */
export function resolveSparkyLocalAdmissionFailureReason(
  error: unknown,
): Extract<FailoverReason, "overloaded" | "timeout"> | undefined {
  if (error === "Sparky request queue is full; retry after current work finishes") {
    return "overloaded";
  }
  if (
    error === "Sparky local queue deadline expired before request dispatch" ||
    error === "Sparky local queue deadline expired"
  ) {
    return "timeout";
  }
  return undefined;
}

/** Resolve one cron-owned classification before falling back to provider error inference. */
export function resolveCronRunErrorReason(
  error: unknown,
  provider?: string,
  classification?: CronRunErrorClassification,
): FailoverReason | undefined {
  if (classification?.kind === "permanent") {
    return undefined;
  }
  if (classification?.kind === "reason") {
    return classification.reason;
  }
  return (
    resolveSparkyLocalAdmissionFailureReason(error) ??
    resolveFailoverReasonFromError(error, provider) ??
    undefined
  );
}
