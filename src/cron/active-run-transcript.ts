import { createHash } from "node:crypto";
import {
  getCurrentCronActiveJobMarker,
  isCronActiveJobMarkerCurrent,
  type CronActiveJobMarker,
} from "./active-jobs.js";
import type { CronRunHistoryBinding, CronRunHistorySelector } from "./store/read-only.types.js";
import type { CronAgentExecutionStarted } from "./types.js";

export type CronActiveRunTranscript = CronRunHistoryBinding & {
  runIds: readonly string[];
  storePath?: string;
};

/** Runner-reported physical identity belongs to the receipt's existing live owner. */
export function bindActiveCronRunTranscript(
  marker: CronActiveJobMarker | undefined,
  execution: CronAgentExecutionStarted | undefined,
  runIds: readonly (string | undefined)[] = [],
): void {
  const authority = marker?.standingGrantAuthority;
  if (
    !marker ||
    !authority ||
    !isCronActiveJobMarkerCurrent(marker) ||
    execution?.jobId !== marker.jobId ||
    (execution.agentId !== undefined && execution.agentId !== authority.handle.agentId)
  ) {
    return;
  }
  if (!execution.sessionKey || !execution.sessionId) {
    marker.transcriptPreparation = {
      storePath: execution.storePath,
      sessionKey: execution.sessionKey,
      agentId: execution.agentId,
    };
    return;
  }
  const { handle } = authority;
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        "active-cron",
        handle.storeKey,
        handle.receiptId,
        handle.startedAtMs,
        execution.storePath,
        execution.sessionKey,
        execution.sessionId,
      ]),
    )
    .digest("base64url");
  if (marker.transcript?.binding === binding) {
    marker.transcriptPreparation = undefined;
    marker.transcript.runIds = [
      ...new Set([
        ...marker.transcript.runIds,
        ...[execution.runId, ...runIds].filter((id): id is string => Boolean(id)),
      ]),
    ];
    return;
  }
  marker.transcriptPreparation = undefined;
  marker.transcript = {
    binding,
    sessionKey: execution.sessionKey,
    sessionId: execution.sessionId,
    agentId: handle.agentId,
    storePath: execution.storePath,
    runIds: [...new Set([execution.runId, ...runIds].filter((id): id is string => Boolean(id)))],
  };
}

export async function acquireActiveCronRunTranscript(
  storeKey: string,
  jobId: string,
  selector: CronRunHistorySelector,
  signal?: AbortSignal,
) {
  const marker = getCurrentCronActiveJobMarker(jobId);
  const authority = marker?.standingGrantAuthority;
  const transcript = marker?.transcript;
  if (
    !marker ||
    !authority ||
    !transcript ||
    !transcript.storePath ||
    marker.transcriptPreparation !== undefined ||
    authority.handle.storeKey !== storeKey ||
    (selector.runAtMs !== undefined && authority.handle.startedAtMs !== selector.runAtMs) ||
    (selector.runId !== undefined && !transcript.runIds.includes(selector.runId)) ||
    (selector.runAtMs === undefined && selector.runId === undefined)
  ) {
    return undefined;
  }
  const assertOwnerCurrent = () => {
    if (
      !isCronActiveJobMarkerCurrent(marker) ||
      marker.standingGrantAuthority !== authority ||
      marker.transcript !== transcript ||
      marker.transcriptPreparation !== undefined ||
      marker.jobRemoved ||
      marker.cancellation?.kind === "requested"
    ) {
      throw new Error("The active cron transcript owner changed");
    }
    authority.assertCurrent();
  };
  assertOwnerCurrent();
  const use = await authority.acquireUse(assertOwnerCurrent, signal);
  const assertCurrent = () => {
    assertOwnerCurrent();
    use.assertCurrent();
  };
  try {
    assertCurrent();
    return { ...transcript, assertCurrent, release: use.release };
  } catch (error) {
    use.release();
    throw error;
  }
}
