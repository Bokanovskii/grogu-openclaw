import type {
  CronFailureNotificationDetail,
  CronRunErrorClassification,
  CronTriggerFailureCode,
  CronTriggerSourceFailureKind,
} from "./types.js";

function classifyCronScriptFailure(code: CronTriggerFailureCode): CronRunErrorClassification {
  if (code === "timeout") {
    return { kind: "reason", reason: "timeout" };
  }
  if (code === "runtime_unavailable") {
    return { kind: "reason", reason: "server_error" };
  }
  return { kind: "permanent" };
}

/** Authors matched retry policy and safe notification detail from one closed code. */
export function cronScriptFailureMetadata(
  source: Extract<CronFailureNotificationDetail, { kind: "script-failure" }>["source"],
  code: CronTriggerFailureCode,
  sourceFailureKind?: CronTriggerSourceFailureKind,
) {
  const failureNotificationDetail: CronFailureNotificationDetail =
    source === "trigger" && sourceFailureKind
      ? { kind: "script-failure", source, code, sourceFailureKind }
      : { kind: "script-failure", source, code };
  return {
    errorClassification: classifyCronScriptFailure(code),
    failureNotificationDetail,
  };
}
