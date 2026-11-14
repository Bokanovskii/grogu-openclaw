import { expect, it, vi } from "vitest";
import { extractAssistantVisibleText } from "../../agents/embedded-agent-utils.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams } from "./delivery-dispatch.test-fixtures.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import { readDescendantSubagentFallbackReply } from "./subagent-followup.runtime.js";

export function registerCurrentTargetDeliveryTests(fixture: {
  mockResolvedOutboundRoute: () => { sessionKey: string };
}) {
  it.each([
    ["\n\nNO", "_REPLY", undefined],
    ["Your flight ", "leaves at noon.", "Your flight leaves at noon."],
    ["\n\nLed", "ger checkpointed; one item qualifies.", undefined],
  ])(
    "delivers only complete public text after empty reasoning: %j + %j",
    async (head, tail, expected) => {
      const message = makeAgentAssistantMessage({
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: head },
          { type: "thinking", thinking: "\n" },
          { type: "text", text: tail },
        ],
      });
      const text = extractAssistantVisibleText(message);
      const outcome = resolveCronPayloadOutcome({
        payloads: [{ text }],
        finalAssistantVisibleText: text,
        preferFinalAssistantVisibleText: true,
      });
      const state = await dispatchCronDelivery({ ...makeBaseParams({}), ...outcome });
      if (expected) {
        expect(state.delivered).toBe(true);
        expect(deliverOutboundPayloads).toHaveBeenCalledWith(
          expect.objectContaining({ payloads: [{ text: expected }] }),
          undefined,
        );
      } else {
        expect(deliverOutboundPayloads).not.toHaveBeenCalled();
        expect(state.delivered).toBe(false);
        expect(state.outputText).toBe(text);
        if (head.includes("Led")) {
          expect(state.deliveryError).toContain("internal status preamble");
        }
      }
    },
  );

  it.each(["isolated", "current"])(
    "projects the notice before %s recipient delivery and transcript mirroring",
    async (sessionTarget) => {
      const notice = "Your flight leaves at noon.";
      const raw = `Ledger updated. One item qualifies.\n<notification>${notice}</notification>\nBelow-bar items stay internal.`;
      const params = makeBaseParams({ sessionTarget, synthesizedText: raw });
      params.job.payload = { kind: "agentTurn", message: "Delivery contract: notice-only" };
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).toBe(true);
      expect(state.outputText).toBe(raw);
      expect(deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({ payloads: [{ text: notice }] }),
        undefined,
      );
      expect(
        JSON.stringify(vi.mocked(appendAssistantMessageToSessionTranscript).mock.calls),
      ).not.toContain("Ledger");
      expect(JSON.stringify(vi.mocked(commitBackgroundResultToSession).mock.calls)).not.toContain(
        "Ledger",
      );
    },
  );

  it.each(["isolated", "current"])(
    "preserves %s failure notices outside the notice-only contract",
    async (sessionTarget) => {
      const text =
        "Internal status: provider unavailable; response had an incomplete <notification>.";
      const params = makeBaseParams({ sessionTarget, synthesizedText: text });
      params.job.payload = { kind: "agentTurn", message: "Delivery contract: notice-only" };
      params.deliveryPayloads = [{ text, isError: true }];
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).toBe(true);
      expect(state.outputText).toBe(text);
      expect(deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({ payloads: [{ text, isError: true }] }),
        undefined,
      );
    },
  );

  it.each(["hello", "Delivery contract: notice-only"])(
    "delivers a settled child's failure explanation for prompt %j",
    async (message) => {
      const text = "No shell tool is available in this run.";
      vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(
        `AUTOMATION_FAILED\n${text}`,
      );
      const params = makeBaseParams({ synthesizedText: "", spawnOnlyHandoff: true });
      params.job.payload = { kind: "agentTurn", message };
      params.synthesizedText = params.summary = params.outputText = undefined;
      params.deliveryPayloads = [];
      const state = await dispatchCronDelivery(params);
      expect(deliverOutboundPayloads).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ payloads: [{ text, isError: true }] }),
        undefined,
      );
      expect(state).toMatchObject({ delivered: true, agentReportedFailure: text, summary: text });
    },
  );

  it.each([
    ["_REPLY", "partial silent reply token", false],
    ["NO", "partial silent reply token", false],
    ["Ledger updated. One item qualifies.", "internal status preamble", false],
    ["Your flight leaves at noon.", "missing notification envelope", true],
    ["<notification>Partial", "malformed notification envelope", true],
    [
      "<notification>One</notification><notification>Two</notification>",
      "malformed notification envelope",
      true,
    ],
    ["<notification>Ledger checkpointed.</notification>", "internal status preamble", true],
  ])("keeps rejected notification %j in run history with a reason", async (raw, reason, strict) => {
    const params = makeBaseParams({ synthesizedText: raw });
    params.job.payload = {
      kind: "agentTurn",
      message: strict ? "Delivery contract: notice-only" : "hello",
    };
    const state = await dispatchCronDelivery(params);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(state.delivered).toBe(false);
    expect(state.outputText).toBe(raw);
    expect(state.deliveryError).toContain(reason);
  });

  it.each(["No", "no", "Y", "Reply"])("delivers the ordinary legacy reply %j", async (text) => {
    const state = await dispatchCronDelivery(makeBaseParams({ synthesizedText: text }));
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
      undefined,
    );
  });

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
