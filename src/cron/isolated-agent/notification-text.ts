import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronJob } from "../types.js";

/** Decides the notice-only contract from the job's own message, never the composed prompt. */
export function isCronNoticeOnlyJob(job: Pick<CronJob, "payload">): boolean {
  return (
    job.payload.kind === "agentTurn" &&
    job.payload.message
      .split(/\r?\n/)
      .some((line) => line.trim() === "Delivery contract: notice-only")
  );
}

// A fragment left when a stream splits the token, such as "NO" or "_REPLY". Case-sensitive
// and at least two characters, so ordinary replies like "No" or "Y" still deliver.
function isPartialSilentReplyToken(text: string): boolean {
  return (
    text.length >= 2 &&
    text !== SILENT_REPLY_TOKEN &&
    (SILENT_REPLY_TOKEN.startsWith(text) || SILENT_REPLY_TOKEN.endsWith(text))
  );
}

export const CRON_NOTIFICATION_GUIDANCE =
  "For automatic delivery, return exactly NO_REPLY when there is no notice. Otherwise put only the complete recipient-ready notice inside one <notification>...</notification> envelope. Text outside that envelope is private and will not be delivered. Keep ledger updates, checkpoints, selection rationale, and other internal status out of the notice. Do not send the notice with the message tool.";

type NotificationText =
  | { kind: "ready"; text: string | undefined }
  | { kind: "blocked"; reason: string };

/** Project recipient text without guessing where an internal preamble ends. */
export function projectCronNotificationText(
  text: string | undefined,
  requireEnvelope = false,
): NotificationText {
  const raw = text?.trim();
  if (!raw || isSilentReplyPayloadText(raw)) {
    return { kind: "ready", text };
  }
  const hasEnvelope = /<\/?notification\b/i.test(raw);
  let notice = raw;
  if (hasEnvelope) {
    const parts = raw.split(/(<notification>|<\/notification>)/);
    if (
      parts.length !== 5 ||
      parts[1] !== "<notification>" ||
      parts[3] !== "</notification>" ||
      /<\/?notification\b/i.test(parts[0]! + parts[2]! + parts[4]!)
    ) {
      return { kind: "blocked", reason: "malformed notification envelope" };
    }
    notice = parts[2]!.trim();
    if (!notice) {
      return { kind: "blocked", reason: "empty notification envelope" };
    }
  } else if (requireEnvelope) {
    return { kind: "blocked", reason: "missing notification envelope" };
  }
  if (isPartialSilentReplyToken(notice)) {
    return { kind: "blocked", reason: "partial silent reply token" };
  }
  if (
    /^(?:(?:ledger|ger|checkpoint|state|memory)\s+(?:updated|checkpointed|saved)\b|(?:internal|run)\s+(?:status|summary)\s*:)/i.test(
      notice,
    )
  ) {
    return { kind: "blocked", reason: "internal status preamble" };
  }
  return { kind: "ready", text: hasEnvelope ? notice : text };
}
