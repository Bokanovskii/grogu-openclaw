import { protectedStorageValueContext } from "../../../storage/sqlite-encryption.js";

export function acpParentStreamEventStorageContext(
  sessionId: string,
  runId: string,
  seq: number,
): string {
  return protectedStorageValueContext("acp_parent_stream_events", "event_json", [
    sessionId,
    runId,
    seq,
  ]);
}
