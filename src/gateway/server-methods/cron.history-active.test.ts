import { writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as historyWorkers from "../../config/sessions/session-history-worker-runtime.js";
import { readCronTranscriptOwnership } from "../../cron/active-jobs.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent/run.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import * as outcomeEvents from "../../cron/service/timer-outcome-events.js";
import * as cronReadOnly from "../../cron/store/read-only.js";
import * as receiptAuthority from "../../cron/store/receipt-authority-owner.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { cronHistoryHandler } from "./cron-history.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

function writeReadTurn(response: ServerResponse, turn: number, filePath: string) {
  const reasoningText = `Checking source ${turn}.`;
  const outputText = `Finding ${turn}.`;
  const thinking = {
    type: "reasoning",
    id: `reasoning-${turn}`,
    summary: [{ type: "summary_text", text: reasoningText }],
  };
  const message = {
    type: "message",
    id: `message-${turn}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: outputText, annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: `function-${turn}`,
    call_id: `read-${turn}`,
    name: "read",
    arguments: JSON.stringify({ path: filePath }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...thinking, summary: [] },
    },
    {
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      item_id: thinking.id,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: thinking.id,
      summary_index: 0,
      delta: reasoningText,
    },
    { type: "response.output_item.done", output_index: 0, item: thinking },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...message, content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 1,
      item_id: message.id,
      content_index: 0,
      delta: outputText,
    },
    { type: "response.output_item.done", output_index: 1, item: message },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { ...call, arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: call.id,
      arguments: call.arguments,
    },
    { type: "response.output_item.done", output_index: 2, item: call },
    {
      type: "response.completed",
      response: {
        id: `response-${turn}`,
        status: "completed",
        output: [thinking, message, call],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

it("reads and refreshes the real in-progress cron transcript, then releases its receipt", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-active-history" }, async (state) => {
    const firstWritten = createDeferred();
    const secondWritten = createDeferred();
    const continueRun = createDeferred();
    const finishRun = createDeferred();
    const sourcePath = path.join(state.workspaceDir, "source.txt");
    await writeFile(sourcePath, "Synthetic source evidence.");
    let requestCount = 0;
    const provider = await startOpenAiResponsesModelServer({
      modelId: "history-fixture",
      bindError: "Cron history provider fixture did not bind",
      async onRequest(request, response) {
        await text(request);
        requestCount += 1;
        if (requestCount === 1) {
          writeReadTurn(response, 1, sourcePath);
        } else if (requestCount === 2) {
          firstWritten.resolve();
          await continueRun.promise;
          writeReadTurn(response, 2, sourcePath);
        } else {
          secondWritten.resolve();
          await finishRun.promise;
          writeOpenAiResponsesText(response, {
            text: "Research finished.",
            messageId: "final-message",
            responseId: "final-response",
          });
        }
      },
    });
    const cfg = createOpenAiResponsesModelConfig({
      baseUrl: provider.baseUrl,
      providerId: "history-provider",
      modelId: "history-fixture",
      reasoning: true,
      toolProfile: "full",
    });
    cfg.plugins = { enabled: false };
    cfg.models = { ...cfg.models, catalogRefresh: { enabled: false } };
    cfg.agents = {
      ...cfg.agents,
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: { ...cfg.agents?.defaults, workspace: state.workspaceDir },
    };
    await state.writeConfig(cfg);
    const storePath = state.statePath("cron", "jobs.json");
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob: (request) =>
        runCronIsolatedAgentTurn({
          ...request,
          cfg,
          deps: {},
          agentId: "main",
          sessionKey: `cron:${request.job.id}`,
          lane: "cron",
        }),
    });
    let running: ReturnType<CronService["run"]> | undefined;
    try {
      const created = await cron.add(
        {
          name: "Active history",
          agentId: "main",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: "Read the source twice, then report.",
            timeoutSeconds: 0,
            toolsAllow: ["read"],
          },
          delivery: { mode: "none" },
        },
        { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      );
      const job = "job" in created ? created.job : created;
      const oldScope = {
        agentId: "main",
        sessionKey: `agent:main:cron:${job.id}`,
        sessionId: "previous-generation",
      };
      await upsertSessionEntryCore(oldScope, { sessionId: oldScope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(oldScope, {
        message: { role: "assistant", content: "Previous run, not the selected occurrence." },
      });
      running = cron.run(job.id, "force");
      await withinTest(
        awaitGateBeforeSettlement(
          firstWritten.promise,
          running,
          "Cron ended before its tool result",
        ),
        signal,
      );
      const runAtMs = expectDefined(cron.getJob(job.id)?.state.runningAtMs, "active occurrence");
      expect(readCronTranscriptOwnership()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "bound",
            agentId: "main",
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          }),
        ]),
      );
      let historyConfig = cfg;
      const context = await createHistoryReadContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => historyConfig,
      });
      const query = async () => {
        const respond = vi.fn<RespondFn>();
        const params = { id: job.id, runAtMs };
        await withinTest(
          Promise.resolve(
            cronHistoryHandler({
              req: { type: "req", id: "active-history", method: "cron.history", params },
              params,
              client: null,
              context,
              respond,
              signal,
              isWebchatConnect: () => false,
            }),
          ),
          signal,
        );
        return respond;
      };
      const read = async () => {
        const respond = await query();
        expect(respond.mock.calls, JSON.stringify(respond.mock.calls)).toMatchObject([
          [true, { messages: expect.any(Array) }],
        ]);
        return respond.mock.calls[0]?.[1];
      };
      const first = await read();
      expect(first).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "thinking", thinking: "Checking source 1." }),
              { type: "text", text: "Finding 1." },
              expect.objectContaining({ type: "toolCall", name: "read" }),
            ]),
          }),
          expect.objectContaining({
            role: "toolResult",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Synthetic source evidence."),
              }),
            ]),
          }),
        ]),
      });
      expect(JSON.stringify(first)).not.toContain("Previous run, not the selected occurrence.");
      historyConfig = { ...cfg, session: { store: state.statePath("replacement.sqlite") } };
      expect((await query()).mock.calls).toMatchObject([
        [false, undefined, { code: "UNAVAILABLE" }],
      ]);
      historyConfig = cfg;
      continueRun.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          secondWritten.promise,
          running,
          "Cron ended before its second tool result",
        ),
        signal,
      );
      expect(JSON.stringify(await read())).toContain("Finding 2.");
      expect(cron.getJob(job.id)?.state.runningAtMs).toBe(runAtMs);
      const historyHeld = createDeferred();
      const releaseHistory = createDeferred();
      const writerQueued = createDeferred();
      const originalRead = historyWorkers.readSessionHistoryPageInWorker;
      const historySpy = vi
        .spyOn(historyWorkers, "readSessionHistoryPageInWorker")
        .mockImplementationOnce(async (...args) => {
          const page = await originalRead(...args);
          historyHeld.resolve();
          await releaseHistory.promise;
          return page;
        });
      const overlappingHistory = read();
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            historyHeld.promise,
            overlappingHistory,
            "History ended before retaining its receipt",
          ),
          signal,
        );
        const originalMutation = receiptAuthority.withCronReceiptAuthorityMutation;
        const mutationSpy = vi
          .spyOn(receiptAuthority, "withCronReceiptAuthorityMutation")
          .mockImplementation((...args) => {
            const mutation = originalMutation(...args);
            writerQueued.resolve();
            return mutation;
          });
        try {
          const update = cron.update(job.id, { displayName: "History remains available" });
          await withinTest(
            awaitGateBeforeSettlement(
              writerQueued.promise,
              update,
              "Cron update ended before its authority mutation",
            ),
            signal,
          );
          releaseHistory.resolve();
          const [page] = await withinTest(Promise.all([overlappingHistory, update]), signal);
          expect(JSON.stringify(page)).toContain("Finding 2.");
        } finally {
          mutationSpy.mockRestore();
        }
      } finally {
        releaseHistory.resolve();
        historySpy.mockRestore();
      }
      // The recorded row lands before finalization clears the active marker.
      const selectHeld = createDeferred();
      const recorded = createDeferred();
      const transcriptRead = createDeferred();
      const releaseFinalization = createDeferred();
      const originalSelect = cronReadOnly.readCronRunHistoryBinding;
      const selectSpy = vi
        .spyOn(cronReadOnly, "readCronRunHistoryBinding")
        .mockImplementationOnce(async (...args) => {
          selectHeld.resolve();
          await recorded.promise;
          return await originalSelect(...args);
        });
      const originalEmit = outcomeEvents.emitCronOutcomeForJob;
      const emitSpy = vi
        .spyOn(outcomeEvents, "emitCronOutcomeForJob")
        .mockImplementationOnce(async (...args) => {
          await originalEmit(...args);
          recorded.resolve();
          await releaseFinalization.promise;
        });
      const transcriptSpy = vi
        .spyOn(historyWorkers, "readSessionHistoryPageInWorker")
        .mockImplementationOnce(async (...args) => {
          transcriptRead.resolve();
          return await originalRead(...args);
        });
      try {
        const finalizingHistory = read();
        await withinTest(
          awaitGateBeforeSettlement(
            selectHeld.promise,
            finalizingHistory,
            "History ended before selecting its run",
          ),
          signal,
        );
        finishRun.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            transcriptRead.promise,
            finalizingHistory,
            "History ended before reading the recorded transcript",
          ),
          signal,
        );
        expect(
          readCronTranscriptOwnership().some(
            (owner) => owner.ownerId.startsWith(`${job.id}:`) && owner.sessionId !== undefined,
          ),
        ).toBe(true);
        releaseFinalization.resolve();
        expect(JSON.stringify(await withinTest(finalizingHistory, signal))).toContain(
          "Research finished.",
        );
      } finally {
        recorded.resolve();
        releaseFinalization.resolve();
        selectSpy.mockRestore();
        emitSpy.mockRestore();
        transcriptSpy.mockRestore();
      }
      expect(await withinTest(running, signal)).toMatchObject({ ok: true, ran: true });
      expect(
        readCronTranscriptOwnership().some((owner) => owner.ownerId.startsWith(`${job.id}:`)),
      ).toBe(false);
    } finally {
      continueRun.resolve();
      finishRun.resolve();
      await running;
      cron.stop();
      await cron.waitForIdle();
      await disposeSessionReadContexts();
      await provider.close();
    }
  });
});
