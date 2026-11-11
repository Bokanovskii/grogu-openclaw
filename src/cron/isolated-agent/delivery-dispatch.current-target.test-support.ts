import { expect, it, vi } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams } from "./delivery-dispatch.test-fixtures.js";

export function registerCurrentTargetDeliveryTests(fixture: {
  mockResolvedOutboundRoute: () => { sessionKey: string };
}) {
  it.each([false, true])(
    "refuses a current-target completion with archived=%s",
    async (archived) => {
      const params = makeBaseParams({
        synthesizedText: "must not escape before commit",
        sessionTarget: "current",
      });
      const queueSourceAwareness = vi.fn().mockResolvedValue(undefined);
      const error = archived
        ? "source session was archived"
        : "current cron delivery is missing its source session generation";
      if (archived) {
        vi.mocked(commitBackgroundResultToSession).mockResolvedValueOnce({
          ok: false,
          reason: error,
        });
        params.queueSourceSessionMessageToolAwareness = queueSourceAwareness;
      } else {
        params.sourceSessionGeneration = undefined;
      }
      const state = await dispatchCronDelivery(params);
      expect(state).toMatchObject({
        delivered: false,
        deliveryAttempted: true,
        deliveryError: error,
      });
      if (archived) {
        expect(queueSourceAwareness).toHaveBeenCalledOnce();
      } else {
        expect(commitBackgroundResultToSession).not.toHaveBeenCalled();
      }
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "mirrors current-target delivery to its recipient only when distinct from source=%s",
    async (sameConversation) => {
      const source = sameConversation
        ? "agent:main:telegram:direct:123456"
        : "agent:main:dashboard:shopping";
      const route = fixture.mockResolvedOutboundRoute();
      const params = makeBaseParams({
        synthesizedText: "A verified useful update.",
        sessionTarget: "current",
      });
      params.job.sessionKey = source;
      params.sourceSessionKey = source;
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).toBe(true);
      expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(commitBackgroundResultToSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: source, text: "A verified useful update." }),
      );
      if (sameConversation) {
        expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      } else {
        expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
        expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: route.sessionKey,
            text: "A verified useful update.",
          }),
        );
      }
    },
  );

  it.each([undefined, "telegram"])(
    "commits current-session output with unresolved channel=%s",
    async (channel) => {
      const params = makeBaseParams({
        synthesizedText: channel ? "Committed report" : "scheduled dashboard report",
        sessionTarget: "current",
        runStartedAt: channel ? 1_500 : 1_000,
      });
      const dashboardSessionKey = "agent:main:dashboard:c5557dcf-54bf-46b0-9bf2-a1f6ad1d0667";
      if (!channel) {
        params.job.sessionKey = dashboardSessionKey;
        params.sourceSessionKey = dashboardSessionKey;
      }
      params.resolvedDelivery = {
        ok: false,
        channel,
        mode: "implicit",
        error: new Error(channel ? "Target is required" : "No configured channels detected"),
      };
      const state = await dispatchCronDelivery(params);
      expect(state.disposition).toBeUndefined();
      expect(state).toMatchObject({ delivered: !channel, deliveryAttempted: true });
      expect(state.deliveryError).toBe(channel ? "Target is required" : undefined);
      if (channel) {
        expect(commitBackgroundResultToSession).toHaveBeenCalledTimes(1);
      } else {
        expect(commitBackgroundResultToSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: dashboardSessionKey,
            text: "scheduled dashboard report",
          }),
        );
      }
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    },
  );
}
