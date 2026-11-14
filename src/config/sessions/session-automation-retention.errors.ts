import { isRecord } from "@openclaw/normalization-core/record-coerce";

const AUTOMATION_RETENTION_DEFERRED_CODE = "automation-retention-deferred";

export class AutomationRetentionDeferredError extends Error {
  readonly code = AUTOMATION_RETENTION_DEFERRED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AutomationRetentionDeferredError";
  }
}

export function isAutomationRetentionDeferredError(error: unknown) {
  return (
    isRecord(error) &&
    error.name === "AutomationRetentionDeferredError" &&
    error.code === AUTOMATION_RETENTION_DEFERRED_CODE
  );
}
