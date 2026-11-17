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
import { jsonResult } from "../../src/agents/tools/tool-results.js";
import { createSessionEntryWithTranscript } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PluginHookHandlerMap } from "../../src/plugins/hook-types.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const first = { sessionKey: "agent:grogu:chat:first", sessionId: "first-incarnation" };
const main = { sessionKey: "global", sessionId: "main-incarnation" };
const route = { channel: "telegram", target: "telegram:synthetic-owner" };

async function openHarness(options: { accountId?: string } = {}) {
  const state = await createOpenClawTestState({ prefix: "research-delivery-" });
  const registered = vi.fn<OpenClawPluginApi["registerTool"]>();
  const hooks = vi.fn<OpenClawPluginApi["on"]>();
  const services = vi.fn<OpenClawPluginApi["registerService"]>();
  // Stands in for the Gateway, which serves Main's native history only for Main's own session key.
  const history: unknown[] = [];
  const base = createPluginRuntime();
  const liveConfig: OpenClawConfig = {
    agents: {
      defaults: { model: "shared/default-model" },
      entries: { grogu: { model: { primary: "automatic/worker-model" } } },
    },
  };
  const run = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["run"]>(async (request) => ({
    runId: "handoff-run",
    sessionKey: request.sessionKey,
  }));
  const api = createTestPluginApi({
    id: "research-topics",
    config: {
      session: { scope: "global" },
    },
    runtimeSource: fileURLToPath(
      new URL("../../grogu/plugins/research-topics/index.ts", import.meta.url),
    ),
    pluginConfig: { delivery: { agentId: "grogu", ...route, ...options } },
    runtime: createPluginRuntime({
      subagent: {
        ...base.subagent,
        run,
        getSessionMessages: async ({ sessionKey }) => ({
          messages: sessionKey === main.sessionKey ? [...history] : [],
        }),
      },
    }),
    registerTool: registered,
    registerService: services,
    on: hooks,
  });
  api.runtime.config.current = () => liveConfig;
  api.runtime.state.resolveStateDir = () => state.stateDir;
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
    const stopService = services.mock.calls[0]?.[0].stop;
    if (!stopService) {
      throw new Error("Expected plugin cleanup");
    }
    const afterHook = hooks.mock.calls.find(([name]) => name === "after_tool_call");
    if (!afterHook) {
      throw new Error("Expected native message receipt observer");
    }
    const beforeHook = hooks.mock.calls.find(([name]) => name === "before_tool_call");
    if (!beforeHook) {
      throw new Error("Expected completion binding before native sends");
    }
    return {
      source: makeTool(first),
      coordinator: makeTool(main),
      history,
      run,
      liveConfig,
      // The registration name selects each handler from the generic hook map.
      observe: afterHook[1] as PluginHookHandlerMap["after_tool_call"],
      begin: beforeHook[1] as PluginHookHandlerMap["before_tool_call"],
      close: async () => {
        try {
          await stopService({
            config: {},
            stateDir: state.stateDir,
            logger: api.logger,
            scheduler: createTestPluginServiceScheduler(),
          });
        } finally {
          await state.cleanup();
        }
      },
    };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}

type Harness = Awaited<ReturnType<typeof openHarness>>;

it("hands findings to Main with its configured model instead of the saved chat model", async () => {
  const harness = await openHarness();
  const { source, run, liveConfig } = harness;
  try {
    await source.execute("add", { action: "add", id: "question", title: "A synthetic question" });
    const request = {
      action: "notify_main",
      id: "question",
      expectedRevision: 1,
      message: "A supported finding.",
      operationId: "first-finding",
    };
    await source.execute("notify", request);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: main.sessionKey,
      model: "automatic/worker-model",
      deliver: false,
    });
    liveConfig.agents = { defaults: { model: "shared/new-model" } };
    await source.execute("notify-again", { ...request, operationId: "second-finding" });
    expect(run.mock.calls[1]?.[0].model).toBe("shared/new-model");
    delete liveConfig.agents;
    await expect(
      source.execute("missing-model", { ...request, operationId: "third-finding" }),
    ).rejects.toThrow("configured primary model");
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    await harness.close();
  }
});

function completionIdOf(details: unknown) {
  if (
    !details ||
    typeof details !== "object" ||
    !("completionId" in details) ||
    typeof details.completionId !== "string"
  ) {
    throw new Error("Expected a pending completion");
  }
  return details.completionId;
}

// Adds a topic and completes it, which leaves Main's text receipt pending.
async function completeTopic({ source }: Harness, id: string) {
  await source.execute("add", {
    action: "add",
    id,
    title: `A synthetic ${id} question`,
    purpose: "answer",
    completionRule: "A supported answer resolves the question",
  });
  return completionIdOf(
    (
      await source.execute("complete", {
        action: "complete",
        id,
        expectedRevision: 1,
        reason: "The answer is supported",
      })
    ).details,
  );
}

// Takes a topic to the point where only Main's text receipt is missing.
async function prepareClosing(harness: Harness, id: string, ownerText: string) {
  const { source, coordinator } = harness;
  const completionId = await completeTopic(harness, id);
  const prepare = { action: "prepare_text", id, expectedRevision: 2, completionId, ownerText };
  const prepared = (await coordinator.execute("prepare", prepare)).details;
  await source.execute("closing-update", {
    action: "post_update",
    id,
    expectedRevision: 3,
    ...first,
    completionId,
    operationId: "closing",
    message: "Research is complete. The answer is supported.",
  });
  return {
    prepared,
    prepare,
    finalize: { action: "finalize", id, expectedRevision: 3, completionId },
  };
}

it("stores real thread updates and deletes completed topics only after a matching Main delivery receipt", async () => {
  const { source, coordinator, begin, observe, close } = await openHarness();
  try {
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
    const completionId = completionIdOf(
      (
        await source.execute("complete", {
          action: "complete",
          id: "question",
          expectedRevision: 1,
          reason: "The answer is supported",
        })
      ).details,
    );
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
    const newCompletionId = completionIdOf(
      (
        await source.execute("new-completion", {
          action: "complete",
          id: "question",
          expectedRevision: 4,
          reason: "Additional evidence confirms the answer",
        })
      ).details,
    );
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
    await close();
  }
});

it("records Main's receipt from a plugin-handled send that omits the channel and account", async () => {
  const harness = await openHarness({ accountId: "default" });
  const { coordinator, begin, observe, close } = harness;
  try {
    const context = { toolName: "message", ...main, agentId: "grogu" };
    const send = async (args: Record<string, unknown>, result: unknown) => {
      await begin({ toolName: "message", toolCallId: "message-call", params: args }, context);
      await observe(
        { toolName: "message", toolCallId: "message-call", params: args, result },
        context,
      );
    };
    // Telegram returns only its own success envelope here; core adds no `messageDelivery` fact.
    const delivered = jsonResult({
      ok: true,
      messageId: "261",
      chatId: "synthetic-owner",
      receipt: {},
    });

    const ownerText = "The question is answered. I have closed its research.";
    const { finalize } = await prepareClosing(harness, "question", ownerText);
    const sendParams = { action: "send", target: route.target, message: ownerText };
    for (const attempt of [
      { args: { ...sendParams, channel: "signal" }, result: delivered },
      { args: { ...sendParams, accountId: "other" }, result: delivered },
      { args: sendParams, result: jsonResult({ ok: true }) },
    ]) {
      await send(attempt.args, attempt.result);
      await expect(coordinator.execute("not-confirmed", finalize)).rejects.toThrow("unconfirmed");
    }
    await send(sendParams, delivered);
    expect((await coordinator.execute("finalize", finalize)).details).toEqual({
      id: "question",
      deleted: true,
    });

    const secondText = "A second answer is ready. I closed that research too.";
    const second = await prepareClosing(harness, "second", secondText);
    expect(second.prepared).toMatchObject({ route: { ...route, accountId: "default" } });
    await send({ action: "send", ...route, accountId: "default", message: secondText }, delivered);
    expect((await coordinator.execute("finalize-second", second.finalize)).details).toEqual({
      id: "second",
      deleted: true,
    });
  } finally {
    await close();
  }
});

it("recovers a missed Main receipt from recent history without a tool-call id", async () => {
  const harness = await openHarness({ accountId: "default" });
  const { coordinator, history, close } = harness;
  try {
    const ownerText = "The question is answered. I have closed its research.";
    const { prepare, finalize } = await prepareClosing(harness, "question", ownerText);
    const confirm = { ...finalize, action: "confirm_completion" };
    const at = Date.now();
    const sendParams = { action: "send", target: route.target, message: ownerText };
    const delivered = { ok: true, messageId: "261", chatId: "synthetic-owner", receipt: {} };
    // One native exchange: the model's call, then its persisted result.
    const exchange = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      result: { details: Record<string, unknown>; isError?: boolean; at?: number },
    ) => [
      { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError: result.isError ?? false,
        details: result.details,
        timestamp: result.at ?? at,
      },
    ];
    // Core persists no topic for a result over 8 KiB, which a large topic's preparation exceeds.
    const preparation = (
      id: string,
      change: { args?: Record<string, unknown>; isError?: boolean } = {},
    ) =>
      exchange(id, "research_topics", change.args ?? prepare, {
        details: {
          persistedDetailsTruncated: true,
          originalDetailsBytes: 20_000,
          originalDetailKeys: ["topic", "route"],
        },
        isError: change.isError,
      });
    // Each send is the good one except for the single property it changes.
    const sent = (
      id: string,
      change: {
        args?: Record<string, unknown>;
        details?: Record<string, unknown>;
        isError?: boolean;
        at?: number;
      } = {},
    ) =>
      exchange(id, "message", change.args ?? sendParams, {
        details: change.details ?? delivered,
        isError: change.isError,
        at: change.at,
      });
    history.push(
      ...sent("before-preparation"),
      ...preparation("failed-preparation", { isError: true }),
      ...preparation("other-topic", { args: { ...prepare, id: "elsewhere" } }),
      ...preparation("other-completion", { args: { ...prepare, completionId: "an-older-one" } }),
      ...preparation("other-text", { args: { ...prepare, ownerText: "An unrelated message" } }),
      ...sent("after-other-preparations"),
    );
    await expect(coordinator.execute("unprepared", confirm)).rejects.toThrow(
      "No successful native text",
    );
    const unpreparedCompletion = await completeTopic(harness, "unprepared");
    await expect(
      coordinator.execute("no-wording", {
        action: "confirm_completion",
        id: "unprepared",
        expectedRevision: 2,
        completionId: unpreparedCompletion,
      }),
    ).rejects.toThrow("No completion text is prepared");

    history.push(
      ...preparation("prepare"),
      ...sent("other-wording", { args: { ...sendParams, message: "An unrelated message" } }),
      ...sent("other-target", { args: { ...sendParams, target: "telegram:someone-else" } }),
      ...sent("failed", {
        details: { ok: false, error: "Telegram rejected the message" },
        isError: true,
      }),
      ...sent("before-completion", { at: 1 }),
    );
    await expect(coordinator.execute("nothing-sent", confirm)).rejects.toThrow(
      "No successful native text",
    );

    history.push(...sent("good"));
    await expect(
      coordinator.execute("other-call", { ...confirm, toolCallId: "other-call" }),
    ).rejects.toThrow("No successful native text");
    await coordinator.execute("recover", confirm);
    expect(
      (await coordinator.execute("get", { action: "get", id: "question" })).details,
    ).toMatchObject({
      destinations: expect.arrayContaining([
        expect.objectContaining({
          kind: "main",
          receipt: expect.objectContaining({
            ...main,
            kind: "owner_text",
            messageId: "261",
            toolCallId: "good",
          }),
        }),
      ]),
    });
    expect((await coordinator.execute("finalize", finalize)).details).toEqual({
      id: "question",
      deleted: true,
    });
  } finally {
    await close();
  }
});
