import {
  listProtectedAutomationRunRecords,
  readProtectedAutomationRunRecord,
  type ProtectedAutomationResultReadAuthority,
} from "./automation-results-read.js";

const runsPath = /^\/automations\/([^/]+)\/runs$/u;
const runPath = /^\/automations\/([^/]+)\/runs\/([^/]+)$/u;

/**
 * Domain handler for the owner-private run routes under `/api/protected/v1`. The HTTP owner
 * authenticates, supplies the profile authority, and wraps `status`/`body` and `ProtectedError`.
 * Returns undefined for any request it does not own.
 */
export async function handleProtectedAutomationResultsRoute(
  stateDir: string,
  request: { method: string; pathname: string },
  authority: ProtectedAutomationResultReadAuthority,
): Promise<{ status: 200; body: unknown } | undefined> {
  if (request.method !== "GET") {
    return undefined;
  }
  const list = runsPath.exec(request.pathname);
  if (list) {
    return {
      status: 200,
      body: await listProtectedAutomationRunRecords(stateDir, list[1]!, authority),
    };
  }
  const detail = runPath.exec(request.pathname);
  if (detail) {
    return {
      status: 200,
      body: await readProtectedAutomationRunRecord(
        stateDir,
        { automationId: detail[1]!, id: detail[2]! },
        authority,
      ),
    };
  }
  return undefined;
}
