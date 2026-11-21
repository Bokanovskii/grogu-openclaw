import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";

export type { ProtectedAccessRequest } from "../../src/state/protected-admission.js";

export function submitProtectedAccessRequest(
  stateDir: string,
  input: { email: string; name: string; note: string },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.submit",
      input: { ...input, now: Date.now() },
    },
  );
}

export function readProtectedAccessRequest(stateDir: string, receipt: string) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedAccess.read", input: { receipt } },
  );
}

export function editProtectedAccessRequest(
  stateDir: string,
  input: { receipt: string; name: string; note: string },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.edit",
      input: { ...input, now: Date.now() },
    },
  );
}

export function listProtectedAccessRequests(stateDir: string) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedAccess.list", input: undefined },
  );
}

export function setProtectedRequestStatus(
  stateDir: string,
  input: {
    id: string;
    status: "approved" | "denied" | "removed" | "withdrawn";
    issuer: string;
  },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.setStatus",
      input: { ...input, now: Date.now() },
    },
  );
}

export function migrateProtectedSubjects(
  stateDir: string,
  input: { subjects: readonly string[]; issuer: string },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.migrate",
      input: { ...input, now: Date.now() },
    },
  );
}

export function bindProtectedAdmission(
  stateDir: string,
  input: { issuer: string; email: string; subject: string },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.bind",
      input: { ...input, now: Date.now() },
    },
  );
}

export function listProtectedAdmissions(stateDir: string) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { type: "protectedAccess.listAdmissions", input: undefined },
  );
}

export function bindProtectedProfile(
  stateDir: string,
  input: { issuer: string; subject: string; profileId: string },
) {
  return executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.bindProfile",
      input: { ...input, now: Date.now() },
    },
  );
}
