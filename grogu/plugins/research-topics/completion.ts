import { createHash, randomUUID } from "node:crypto";
import { executeSqliteQuerySync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { Records } from "./records.js";
import type {
  CompletionDestination,
  CompletionReceipt,
  LedgerOperations,
  Request,
} from "./schema.js";

type CompletionRequest = Extract<
  Request,
  {
    action: "complete" | "prepare_text" | "post_update" | "confirm_completion" | "finalize";
  }
>;

export function recordConfirmation(
  r: Records,
  destination: CompletionDestination,
  receipt: CompletionReceipt,
) {
  if (
    receipt.sessionKey !== destination.sessionKey ||
    receipt.sessionId !== destination.sessionId ||
    (destination.kind === "main"
      ? receipt.kind !== "owner_text" && receipt.kind !== "owner_inbox"
      : receipt.kind !== "session_message")
  ) {
    throw new Error("Native receipt does not match the completion destination.");
  }
  if (destination.receiptJson === null) {
    executeSqliteQuerySync(
      r.db,
      r.query
        .updateTable("completion_destinations")
        .set({ receiptJson: JSON.stringify(receipt) })
        .where("topicId", "=", destination.topicId)
        .where("destinationId", "=", destination.destinationId),
    );
  }
}

export function handleCompletion(
  r: Records,
  request: CompletionRequest,
  now: number,
  evidence: Pick<
    LedgerOperations["request"]["input"],
    "caller" | "mainSession" | "verifiedReceipt"
  >,
) {
  const topic = r.topic(request.id);
  r.expectRevision(topic, request.expectedRevision);
  if (request.action === "complete") {
    r.active(topic);
    if (!evidence.mainSession) {
      throw new Error(
        "Configure Research Topics delivery and an existing Main session before completion.",
      );
    }
    if (!topic.completionRule) {
      throw new Error("Record the topic's completionRule before completing its research.");
    }
    const destinations: CompletionDestination[] = [
      {
        topicId: topic.id,
        destinationId: "main",
        kind: "main",
        ...evidence.mainSession,
        receiptJson: null,
      },
    ];
    const sessions = new Map(
      r
        .links(topic.id)
        .sessionRefs.map((ref) => [JSON.stringify([ref.sessionKey, ref.sessionId]), ref]),
    );
    for (const [key, ref] of sessions) {
      destinations.push({
        topicId: topic.id,
        destinationId: `session:${createHash("sha256").update(key).digest("hex")}`,
        kind: "session",
        sessionKey: ref.sessionKey,
        sessionId: ref.sessionId,
        receiptJson: null,
      });
    }
    executeSqliteQuerySync(
      r.db,
      r.query.insertInto("completion_destinations").values(destinations),
    );
    return r.bump(topic, now, {
      status: "completion_pending",
      completionId: randomUUID(),
      completionReason: request.reason,
      ownerText: null,
      completedAtMs: now,
    });
  }
  if (topic.status !== "completion_pending" || topic.completionId !== request.completionId) {
    throw new Error("Research completion identity changed. Reread the pending topic.");
  }
  const destinations = r.destinations(topic.id);
  if (request.action === "prepare_text") {
    const main = destinations.find((item) => item.kind === "main");
    if (
      !main ||
      evidence.caller?.sessionKey !== main.sessionKey ||
      evidence.caller.sessionId !== main.sessionId
    ) {
      throw new Error("Only the recorded Main session can prepare the completion text.");
    }
    if (main.receiptJson !== null) {
      throw new Error("The completion text already has a native delivery receipt.");
    }
    return topic.ownerText === request.ownerText
      ? r.get(topic.id)
      : r.bump(topic, now, { ownerText: request.ownerText });
  }
  if (request.action === "confirm_completion" || request.action === "post_update") {
    const receipt = evidence.verifiedReceipt;
    const destination = destinations.find((item) =>
      request.action === "confirm_completion"
        ? item.kind === "main"
        : item.kind === "session" &&
          item.sessionKey === request.sessionKey &&
          item.sessionId === request.sessionId,
    );
    if (!destination) {
      throw new Error(
        "Unknown research completion destination. Use the pending topic's destinations.",
      );
    }
    if (!receipt || receipt.completedAtMs < (topic.completedAtMs ?? now)) {
      throw new Error(
        "A native receipt for this completion is required. No confirmation was written.",
      );
    }
    recordConfirmation(r, destination, receipt);
    return r.get(topic.id);
  }
  if (
    !destinations.some((destination) => destination.kind === "main") ||
    destinations.some((destination) => destination.receiptJson === null)
  ) {
    throw new Error(
      "Research completion is unconfirmed. Every destination, including Main owner text, must be verified before deletion.",
    );
  }
  return r.delete(topic.id);
}
