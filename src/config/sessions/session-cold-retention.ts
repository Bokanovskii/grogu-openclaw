import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type {
  SessionColdMutationResult,
  SessionColdRetentionProbe,
} from "./session-cold-storage.types.js";

// Archive bytes are immutable per digest, so an ineligible retention probe stays
// ineligible until the sweep cutoff passes its earliest expirable detail.
const retentionDeferredUntil = new Map<string, number>();
const MAX_RETENTION_DEFERRALS = 4096;

export function isSessionColdRetentionDeferred(
  sessionId: string,
  archiveSha256: string,
  cutoff: number,
) {
  const until = retentionDeferredUntil.get(`${sessionId}\0${archiveSha256}`);
  return until !== undefined && cutoff <= until;
}

/** Records a committed restore outcome; true means retention left the archive cold. */
export function recordSessionColdRetentionProbe(
  sessionId: string,
  archive: Pick<SessionColdArchive, "archive_sha256">,
  retention: SessionColdRetentionProbe | undefined,
  result: Pick<SessionColdMutationResult, "retentionEligible" | "retentionDetailAt">,
) {
  const key = `${sessionId}\0${archive.archive_sha256}`;
  retentionDeferredUntil.delete(key);
  if (!retention || result.retentionEligible !== false) {
    return false;
  }
  retentionDeferredUntil.set(key, result.retentionDetailAt ?? Number.POSITIVE_INFINITY);
  if (retentionDeferredUntil.size > MAX_RETENTION_DEFERRALS) {
    retentionDeferredUntil.delete(retentionDeferredUntil.keys().next().value!);
  }
  return true;
}
