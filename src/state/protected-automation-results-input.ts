import type { PreparedProtectedAutomationFinishedResult } from "./protected-automation-results.types.js";

export function captureProtectedAutomationFinishedResult(
  input: PreparedProtectedAutomationFinishedResult,
): PreparedProtectedAutomationFinishedResult {
  const captured = structuredClone(input);
  // Text is stored verbatim: an empty string is a real empty result, but a missing or non-string
  // value would commit a row that can never be read back.
  if (
    typeof captured.privateFinalText !== "string" ||
    typeof captured.automationName !== "string" ||
    typeof captured.transcript?.sessionKey !== "string" ||
    typeof captured.transcript.sessionId !== "string"
  ) {
    throw new TypeError("Protected automation result has invalid private content.");
  }
  if (
    !captured.automationId ||
    !captured.centralOwnerProfileId ||
    !captured.jobId ||
    !captured.runId ||
    !captured.transcript.sessionKey ||
    !captured.transcript.sessionId ||
    !Number.isSafeInteger(captured.definitionRevision) ||
    captured.definitionRevision < 1 ||
    !Number.isSafeInteger(captured.runAtMs) ||
    captured.runAtMs < 0 ||
    !Number.isSafeInteger(captured.completedAtMs) ||
    captured.completedAtMs < 0
  ) {
    throw new TypeError("Protected automation result has an invalid native identity.");
  }
  return captured;
}
