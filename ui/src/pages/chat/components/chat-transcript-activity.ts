import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { readMessageWidgetDraft } from "../../../lib/chat/widget-draft.ts";
import { type resolveTurnRecap, sumRunOutputUsage } from "../chat-progress.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import {
  getChatItemsGeneration,
  type buildCachedChatItems,
  type coalesceAgentRunFrames,
} from "../chat-thread.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import type { projectTranscriptChain } from "./chat-transcript-message-index.ts";

const workingIndicators = createTranscriptMemo<
  Extract<ChatItem, { kind: "reading-indicator" }> | undefined
>();
const activityGroups = createTranscriptMemo<string | undefined>();

export function projectTranscriptActivity(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  props: Pick<ChatThreadProps, "runId" | "runActive" | "runUsageById" | "runReasoningById">,
) {
  const generation = getChatItemsGeneration(chatItems);
  const workingIndicator = workingIndicators(chatItems, [generation], () =>
    chatItems.find((item) => item.kind === "reading-indicator"),
  );
  const activityRunId = workingIndicator?.runId ?? props.runId;
  const activityGroupKey = activityGroups(
    chatItems,
    [generation, activityRunId, props.runActive],
    () =>
      props.runActive && activityRunId
        ? chatItems.findLast(
            (item) =>
              item.kind === "group" &&
              item.messages.some(
                ({ message }) =>
                  transcriptRunId(message) === activityRunId &&
                  readPreparedActivity(message).some(
                    (activity) =>
                      !activity.hideFromChannelProgress && !activity.suppressChannelProgress,
                  ),
              ),
          )?.key
        : undefined,
  );
  // A run that resumed a handoff counts on from the runs before it. Its own
  // run id and first usage report may not have arrived yet.
  const earlierRunIds = workingIndicator?.request?.runIds ?? [];
  const runOutputUsage =
    sumRunOutputUsage(
      props.runUsageById,
      workingIndicator?.runId ? [...earlierRunIds, workingIndicator.runId] : [],
    ) ?? sumRunOutputUsage(props.runUsageById, earlierRunIds);
  const runReasoning = workingIndicator?.runId
    ? props.runReasoningById?.get(workingIndicator.runId)
    : undefined;
  return { workingIndicator, activityRunId, activityGroupKey, runOutputUsage, runReasoning };
}

export function createTranscriptActivitySignature(params: {
  workingUsageKey: string;
  recapForGroup: (key: string) => ReturnType<typeof resolveTurnRecap> | undefined;
  latestAssistantItemKey: string | null;
  continuations: ReturnType<typeof projectTranscriptChain>["continuations"];
  searchFiltering: boolean;
}) {
  const { workingUsageKey, recapForGroup, latestAssistantItemKey, continuations, searchFiltering } =
    params;
  return (item: ReturnType<typeof coalesceAgentRunFrames>[number]): string => {
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group" && item.kind !== "agent-run-frame") {
      return "";
    }
    const recap = recapForGroup(item.key);
    const recapKey = recap
      ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}:${Boolean(recap.outputTokensEstimated)}`
      : "";
    const statusKey = `${recapKey}|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${statusKey}`;
    }
    const continuation = continuations.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    return `${continuationKey}|${statusKey}|${searchFiltering ? "search-result" : ""}`;
  };
}

// A silent show_widget call replaces the generic working label for its run.
export function buildingWidgetLabel(
  toolMessages: readonly unknown[],
  runId: string | null | undefined,
): string | undefined {
  const building =
    runId &&
    toolMessages.some(
      (message) =>
        transcriptRunId(message) === runId &&
        readMessageWidgetDraft(message)?.status === "building",
    );
  return building ? t("chat.toolCards.widgetDraft.building") : undefined;
}
