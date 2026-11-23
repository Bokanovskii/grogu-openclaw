import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import type { AdminTelemetryQuery } from "../../src/state/protected-feedback-telemetry.js";
import type {
  ProtectedFeedbackCategory,
  ProtectedFeedbackRating,
  ProtectedFeedbackStatus,
  ProtectedProducedFile,
  ProtectedReportRecord,
  ProtectedReportSummary,
  ProtectedTelemetryRun,
  ProtectedStoredDataEntry,
  ProtectedTurnTelemetryInput,
} from "../../src/state/protected-feedback.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type {
  ProtectedProducedFile,
  ProtectedReportRecord,
  ProtectedReportSummary,
  ProtectedTelemetryRun,
  ProtectedTurnTelemetryInput,
};

export function listProtectedFeedback(stateDir: string, profileId: string, chatId: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.listRatings",
    input: { profileId, chatId },
  });
}

export function setProtectedFeedback(
  stateDir: string,
  input: {
    profileId: string;
    chatId: string;
    responseId: string;
    rating: ProtectedFeedbackRating | null;
    now: number;
    storageOverheadBytes: number;
  },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.setRating",
    input,
  });
}

export function findProtectedFeedbackSubmission(
  stateDir: string,
  profileId: string,
  submissionId: string,
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.findSubmission",
    input: { profileId, submissionId },
  });
}

export function findProtectedFeedbackForResponse(
  stateDir: string,
  profileId: string,
  chatId: string,
  responseId: string,
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.findForResponse",
    input: { profileId, chatId, responseId },
  });
}

export function submitProtectedFeedbackReport(
  stateDir: string,
  input: {
    profileId: string;
    memberLabel: string;
    chatId: string;
    responseId: string;
    submissionId: string;
    category: ProtectedFeedbackCategory;
    description: string;
    now: number;
    storageOverheadBytes: number;
  },
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.submitReport",
    input,
  });
}

export function listProtectedFeedbackReports(stateDir: string, status: "open" | "all") {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.listReports",
    input: { status },
  });
}

export function readProtectedFeedbackReport(stateDir: string, id: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.readReport",
    input: { id },
  });
}

export function setProtectedFeedbackReportStatus(
  stateDir: string,
  id: string,
  status: ProtectedFeedbackStatus,
  now: number,
) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.setReportStatus",
    input: { id, status, now },
  });
}

export function removeProtectedChatFeedback(stateDir: string, profileId: string, chatId: string) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.removeChat",
    input: { profileId, chatId },
  });
}

export function readProtectedFeedbackStorageUsage(
  stateDir: string,
  overheadBytes: number,
  assertCurrent: () => void,
): Promise<ProtectedStoredDataEntry[]> {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.storageUsage",
    input: { overheadBytes },
  }).then((entries) => {
    assertCurrent();
    return entries;
  });
}

export function listProtectedTelemetry(stateDir: string, input: AdminTelemetryQuery) {
  return executeOpenClawStateWorker(captureProtectedStateWorkerContext(stateDir), {
    type: "protectedFeedback.telemetry.list",
    input,
  });
}
