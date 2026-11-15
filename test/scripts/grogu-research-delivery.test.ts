import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import plugin from "../../grogu/plugins/research-topics/index.js";
import { createSessionEntryWithTranscript } from "../../src/config/sessions/session-accessor.js";
import type { PluginHookHandlerMap } from "../../src/plugins/hook-types.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

it("stores real thread updates and deletes completed topics only after a matching Main delivery receipt", async () => {
  const state = await createOpenClawTestState({ prefix: "research-delivery-" });
  const first = { sessionKey: "agent:grogu:chat:first", sessionId: "first-incarnation" };
  const main = { sessionKey: "global", sessionId: "main-incarnation" };
  const route = { channel: "telegram", target: "telegram:synthetic-owner" };
  const registered = vi.fn<OpenClawPluginApi["registerTool"]>();
  const hooks = vi.fn<OpenClawPluginApi["on"]>();
  const services = vi.fn<OpenClawPluginApi["registerService"]>();
  const api = createTestPluginApi({
    id: "research-topics",
    config: {
      session: { scope: "global" },
    },
    runtimeSource: fileURLToPath(
      new URL("../../grogu/plugins/research-topics/index.ts", import.meta.url),
    ),
    pluginConfig: { delivery: { agentId: "grogu", ...route } },
    runtime: createPluginRuntime(),
    registerTool: registered,
    registerService: services,
    on: hooks,
  });
  api.runtime.state.resolveStateDir = () => state.stateDir;
  let stop: (() => Promise<void>) | undefined;
  try {
    for (const session of [first, main]) {
      await createSessionEntryWithTranscript({ agentId: "grogu", ...session }, () => ({
        ok: true,
        entry: { sessionId: session.sessionId, updatedAt: Date.now() },
      }));
    }
    plugin.register?.(api);
    const factory = registered.mock.calls[0]?.[0];
    if (
      !factory ||
      typeof factory !== "object" ||
      !("contextVersion" in factory) ||
      factory.contextVersion !== 2
    ) {
      throw new Error("Expected an authority-bound tool factory");
    }
    const makeTool = (session: typeof first) => {
      const tool = factory.create({
        ...session,
        agentId: "grogu",
        assertInvocationCurrent: () => {},
      });
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected the registered research tool");
      }
      return tool;
    };
    const source = makeTool(first);
    const coordinator = makeTool(main);
    const cleanup = services.mock.calls[0]?.[0].stop;
    if (!cleanup) {
      throw new Error("Expected plugin cleanup");
    }
    stop = async () => {
      await cleanup({
        config: {},
        stateDir: state.stateDir,
        logger: api.logger,
        scheduler: createTestPluginServiceScheduler(),
      });
    };
    const hook = hooks.mock.calls.find(([name]) => name === "after_tool_call");
    if (!hook) {
      throw new Error("Expected native message receipt observer");
    }
    // The registration name selects this handler from the generic hook map.
    const observe = hook[1] as PluginHookHandlerMap["after_tool_call"];
    const beforeHook = hooks.mock.calls.find(([name]) => name === "before_tool_call");
    if (!beforeHook) {
      throw new Error("Expected completion binding before native sends");
    }
    const begin = beforeHook[1] as PluginHookHandlerMap["before_tool_call"];
    await coordinator.execute("main-topic", {
      action: "add",
      id: "main-topic",
      title: "A goal from global Main",
    });
    await coordinator.execute("main-update", {
      action: "post_update",
      id: "main-topic",
      expectedRevision: 1,
      ...main,
      message: "A finding for the original global conversation.",
      operationId: "main-finding",
    });
    expect(
      await readVisibleSessionTranscriptMessageEntries({ agentId: "grogu", ...main }),
    ).toHaveLength(1);
    await source.execute("add", {
      action: "add",
      id: "question",
      title: "A synthetic question",
      purpose: "answer",
      completionRule: "A supported answer resolves the question",
    });
    const update = {
      action: "post_update",
      id: "question",
      expectedRevision: 1,
      ...first,
      message: "A new source answers the question.",
      operationId: "finding",
    };
    await source.execute("post", update);
    await source.execute("replay", update);
    const entries = await readVisibleSessionTranscriptMessageEntries({
      agentId: "grogu",
      ...first,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: update.message }],
    });
    await expect(
      source.execute("unlinked", {
        ...update,
        ...main,
        operationId: "unlinked",
      }),
    ).rejects.toThrow("recorded source conversation");
    const completed = (
      await source.execute("complete", {
        action: "complete",
        id: "question",
        expectedRevision: 1,
        reason: "The answer is supported",
      })
    ).details;
    if (
      !completed ||
      typeof completed !== "object" ||
      !("completionId" in completed) ||
      typeof completed.completionId !== "string"
    ) {
      throw new Error("Expected a pending completion");
    }
    const completionId = completed.completionId;
    const ownerText = "The question is answered. I have closed its research.";
    const prepare = {
      action: "prepare_text",
      id: "question",
      expectedRevision: 2,
      completionId,
      ownerText,
    };
    await expect(source.execute("not-main", prepare)).rejects.toThrow("Only configured Main");
    expect((await coordinator.execute("prepare", prepare)).details).toMatchObject({
      topic: { revision: 3, ownerText },
      route,
    });
    const finalize = { action: "finalize", id: "question", expectedRevision: 3, completionId };
    await expect(coordinator.execute("too-early", finalize)).rejects.toThrow("unconfirmed");
    await source.execute("closing-update", {
      ...update,
      expectedRevision: 3,
      completionId,
      operationId: "closing",
      message: "Research is complete. The answer is supported.",
    });
    await expect(
      coordinator.execute("forged", {
        action: "confirm_completion",
        id: "question",
        expectedRevision: 3,
        completionId,
        toolCallId: "forged",
        receipt: { delivered: true },
      }),
    ).rejects.toThrow("Invalid research_topics");
    const sendParams = { action: "send", ...route, message: ownerText };
    const nativeResult = {
      details: {
        messageDelivery: {
          status: "settled",
          partialDelivery: false,
          primaryPlatformMessageId: "provider-message-1",
          createdThreadIds: [],
        },
      },
    };
    for (const event of [
      {
        params: sendParams,
        result: { details: { messageDelivery: { status: "settled", partialDelivery: true } } },
      },
      { params: { ...sendParams, target: "telegram:someone-else" }, result: nativeResult },
      { params: { ...sendParams, message: "An unrelated message" }, result: nativeResult },
      { params: { ...sendParams, dryRun: true }, result: nativeResult },
    ]) {
      await begin(
        { toolName: "message", toolCallId: "message-call", params: event.params },
        { toolName: "message", ...main, agentId: "grogu" },
      );
      await observe(
        { toolName: "message", toolCallId: "message-call", ...event },
        { toolName: "message", ...main, agentId: "grogu" },
      );
      await expect(coordinator.execute("not-confirmed", finalize)).rejects.toThrow("unconfirmed");
    }
    await begin(
      { toolName: "message", toolCallId: "message-call", params: sendParams },
      { toolName: "message", ...first, agentId: "grogu" },
    );
    await observe(
      { toolName: "message", toolCallId: "message-call", params: sendParams, result: nativeResult },
      { toolName: "message", ...first, agentId: "grogu" },
    );
    await expect(coordinator.execute("wrong-session", finalize)).rejects.toThrow("unconfirmed");
    await begin(
      { toolName: "message", toolCallId: "old-call", params: sendParams },
      { toolName: "message", ...main, agentId: "grogu" },
    );
    await source.execute("reopen", { action: "reopen", id: "question", expectedRevision: 3 });
    const newer = (
      await source.execute("new-completion", {
        action: "complete",
        id: "question",
        expectedRevision: 4,
        reason: "Additional evidence confirms the answer",
      })
    ).details;
    if (
      !newer ||
      typeof newer !== "object" ||
      !("completionId" in newer) ||
      typeof newer.completionId !== "string"
    ) {
      throw new Error("Expected a new completion identity");
    }
    const newCompletionId = newer.completionId;
    await coordinator.execute("new-prepare", {
      ...prepare,
      expectedRevision: 5,
      completionId: newCompletionId,
    });
    await expect(
      observe(
        {
          toolName: "message",
          toolCallId: "old-call",
          params: sendParams,
          result: nativeResult,
        },
        { toolName: "message", ...main, agentId: "grogu" },
      ),
    ).rejects.toThrow("revision changed");
    const newFinalize = { ...finalize, expectedRevision: 6, completionId: newCompletionId };
    await expect(coordinator.execute("stale-receipt", newFinalize)).rejects.toThrow("unconfirmed");
    await source.execute("new-closing-update", {
      ...update,
      expectedRevision: 6,
      completionId: newCompletionId,
      operationId: "new-closing",
      message: "Additional evidence confirms completion.",
    });
    await begin(
      { toolName: "message", toolCallId: "message-call", params: sendParams },
      { toolName: "message", ...main, agentId: "grogu" },
    );
    await observe(
      { toolName: "message", toolCallId: "message-call", params: sendParams, result: nativeResult },
      { toolName: "message", ...main, agentId: "grogu" },
    );
    expect((await coordinator.execute("finalize", newFinalize)).details).toEqual({
      id: "question",
      deleted: true,
    });
    await expect(source.execute("get", { action: "get", id: "question" })).rejects.toThrow(
      "Unknown research topic",
    );
    expect(
      await readVisibleSessionTranscriptMessageEntries({ agentId: "grogu", ...first }),
    ).toHaveLength(3);
    await source.execute("race-topic", {
      action: "add",
      id: "race-topic",
      title: "Original constraints",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const append = transcriptRuntime.appendSessionTranscriptMessageByIdentityStrict;
    const pausedAppend = vi
      .spyOn(transcriptRuntime, "appendSessionTranscriptMessageByIdentityStrict")
      .mockImplementationOnce(async (input) => {
        entered.resolve();
        await release.promise;
        return append(input);
      });
    const publishing = source.execute("race-publication", {
      ...update,
      id: "race-topic",
      message: "A finding using the original constraints.",
    });
    let correcting: ReturnType<typeof source.execute> | undefined;
    try {
      await entered.promise;
      correcting = source.execute("race-correction", {
        action: "update",
        id: "race-topic",
        expectedRevision: 1,
        changes: { title: "Corrected constraints" },
      });
      expect(
        (
          await source.execute("read-during-publication", {
            action: "get",
            id: "race-topic",
          })
        ).details,
      ).toMatchObject({ revision: 1, title: "Original constraints" });
    } finally {
      release.resolve();
      await Promise.all([publishing, correcting]);
      pausedAppend.mockRestore();
    }
    expect(
      (
        await source.execute("read-after-publication", {
          action: "get",
          id: "race-topic",
        })
      ).details,
    ).toMatchObject({ revision: 2, title: "Corrected constraints" });
  } finally {
    await stop?.();
    await state.cleanup();
  }
});
