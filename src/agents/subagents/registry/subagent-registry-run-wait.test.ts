import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setGatewayDedupeEntry } from "../../../gateway/agent-turn/agent-job.js";
import { withLocalGatewayRequestScope } from "../../../gateway/local-request-context.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { LegacyPluginSdkResourceHost } from "../../../plugins/legacy-sdk-resource-host.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";

function storedPayload(runId: string): string | undefined {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "subagent_runs">>(db)
      .selectFrom("subagent_runs")
      .select("payload_json")
      .where("run_id", "=", runId),
  ).rows[0]?.payload_json;
}

it("keeps request-owned child content out of the durable registry", async () => {
  await withQueuedRegistrationFixture(async (f) => {
    vi.spyOn(f.manager, "waitForSubagentCompletion").mockResolvedValue();
    await f.manager.registerSubagentRun({
      ...f.registration,
      queued: false,
      queuedLaunch: undefined,
      collect: false,
      cleanup: "delete",
      expectsCompletionMessage: false,
      task: "private task text",
      taskName: "private task name",
      sessionEntry: { sessionId: "child-id", lifecycleRevision: "child-revision" },
      requestScopedTransient: true,
    });
    expect(f.current().task).toBe("private task text");
    expect(storedPayload(f.registration.runId)).not.toContain("private task");
    const killClaim = await f.manager.claimSubagentRunKill({
      runId: f.registration.runId,
      expected: f.current(),
      sessionId: "child-id",
      sessionLifecycleRevision: "child-revision",
    });
    if (!killClaim) {
      throw new Error("The native cancellation claim was not admitted");
    }
    expect(f.stored()?.killIntent).toMatchObject(killClaim);
    await restoreSubagentRunsFromDisk({ runs: f.runs });
    expect(f.current().killIntent).toMatchObject(killClaim);
    await expect(
      f.manager.releaseSubagentRunKillClaim({
        runId: f.registration.runId,
        expected: f.current(),
        claim: killClaim,
      }),
    ).resolves.toBe(true);
    await f.change((draft) => {
      draft.execution = {
        ...draft.execution,
        status: "terminal",
        endedAt: 4,
        outcome: { status: "error", error: "private error text", endedAt: 4 },
      };
      draft.completion = {
        required: false,
        resultText: "private result text",
        fallbackResultText: "private fallback text",
        capturedAt: 4,
      };
      draft.killReconciliation = { killedAt: 4, taskCancellationAccepted: true };
    });
    expect(f.current().completion?.resultText).toBe("private result text");
    const stored = storedPayload(f.registration.runId);
    expect(stored).not.toContain("private result");
    expect(stored).not.toContain("private fallback");
    expect(stored).not.toContain("private error");
    expect(f.stored()).toMatchObject({
      runId: f.registration.runId,
      childSessionIdentity: { sessionId: "child-id", lifecycleRevision: "child-revision" },
      requesterSessionKey: f.registration.requesterSessionKey,
      killReconciliation: { killedAt: 4, taskCancellationAccepted: true },
    });
    await restoreSubagentRunsFromDisk({ runs: f.runs });
    expect(f.current().task).toBe("private task text");
    expect(f.current().completion?.resultText).toBe("private result text");
    expect(f.current().killReconciliation).toEqual({ killedAt: 4, taskCancellationAccepted: true });
    await f.change((draft) => {
      draft.cleanupHandled = true;
    });
    expect(f.current().cleanupHandled).toBe(true);
    expect(storedPayload(f.registration.runId)).not.toContain("private result");
  });
});

it("observes a locally owned child without a Gateway socket", async () => {
  await withQueuedRegistrationFixture(async (f) => {
    await f.register();
    await f.change((draft) => {
      draft.childSessionIdentity = { sessionId: "owned-child", lifecycleRevision: "owned-rev" };
    });
    const host = new LegacyPluginSdkResourceHost();
    try {
      await host.run(() =>
        withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
          const scope = getPluginRuntimeGatewayRequestScope();
          if (!scope?.context || !scope.resolveGatewayContext) {
            throw new Error("Missing local Gateway owner");
          }
          const entry = f.current();
          bindGatewayContextResolver(entry, scope.resolveGatewayContext);
          setGatewayDedupeEntry({
            dedupe: scope.context.dedupe,
            key: `agent:${entry.runId}`,
            session: {
              sessionKey: entry.childSessionKey,
              sessionId: "owned-child",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
            entry: { ts: Date.now(), ok: true, payload: { runId: entry.runId, status: "ok" } },
          });
          const gateway = vi.spyOn(f.options, "callGateway");
          const complete = vi.spyOn(f.options, "completeSubagentRun");
          await f.manager.waitForSubagentCompletion(entry.runId, entry, 100);
          expect(gateway).not.toHaveBeenCalled();
          expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({
              runId: entry.runId,
              outcome: expect.objectContaining({ status: "ok" }),
            }),
          );
        }),
      );
    } finally {
      await host.close();
    }
  });
});

it("does not reconnect when the child Gateway owner has closed", async () => {
  await withQueuedRegistrationFixture(async (f) => {
    await f.register();
    const entry = f.current();
    bindGatewayContextResolver(entry, () => undefined);
    const gateway = vi.spyOn(f.options, "callGateway");
    const complete = vi.spyOn(f.options, "completeSubagentRun");
    await f.manager.waitForSubagentCompletion(entry.runId, entry, 100);
    expect(gateway).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

it("does not settle a child from another session's run observation", async () => {
  await withQueuedRegistrationFixture(async (f) => {
    await f.register();
    await f.change((draft) => {
      draft.childSessionIdentity = { sessionId: "owned-child", lifecycleRevision: "owned-rev" };
    });
    const host = new LegacyPluginSdkResourceHost();
    try {
      await host.run(() =>
        withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
          const scope = getPluginRuntimeGatewayRequestScope();
          if (!scope?.context || !scope.resolveGatewayContext) {
            throw new Error("Missing local Gateway owner");
          }
          const entry = f.current();
          bindGatewayContextResolver(entry, scope.resolveGatewayContext);
          setGatewayDedupeEntry({
            dedupe: scope.context.dedupe,
            key: `agent:${entry.runId}`,
            session: {
              sessionKey: entry.childSessionKey,
              sessionId: "different-child",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
            entry: { ts: Date.now(), ok: true, payload: { runId: entry.runId, status: "ok" } },
          });
          const complete = vi.spyOn(f.options, "completeSubagentRun");
          await f.manager.waitForSubagentCompletion(entry.runId, entry, 100);
          expect(complete).not.toHaveBeenCalled();
        }),
      );
    } finally {
      await host.close();
    }
  });
});

it.each(["live", "closing"] as const)(
  "settles failed completion recovery with a %s state database",
  async (lifecycle) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      await f.change((draft) => {
        draft.execution = { status: "terminal", startedAt: 1, endedAt: 2 };
        draft.cleanupHandled = true;
      });
      const original = f.current();
      const before = structuredClone(original);
      const persisted = storedPayload(original.runId);
      expect(original.cleanupHandled).toBe(true);
      expect(persisted).toBeTypeOf("string");
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockRejectedValue(new Error("synthetic timing read failed"));
      const write = f.holdNextWrite("before");
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(write.entered, waiting, "Recovery did not reach its write");
        if (lifecycle === "closing") {
          closing = closeOpenClawStateDatabaseAsync();
          expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        }
        write.release();
        await expect(waiting).resolves.toBeUndefined();
        await closing;
        if (lifecycle === "live") {
          expect(f.current().cleanupHandled).toBe(false);
          expect(f.options.resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(original.runId);
        } else {
          expect(storedPayload(original.runId)).toBe(persisted);
          expect(f.current()).toEqual(before);
          expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
          expect(f.options.scheduleSweep).not.toHaveBeenCalled();
        }
      } finally {
        write.release();
        await Promise.allSettled([waiting, ...(closing ? [closing] : [])]);
        timing.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "retires a closed wait without hiding an unknown outcome (%s)",
  async (unknown) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const original = f.current();
      const before = structuredClone(original);
      const entered = createDeferred();
      const release = createDeferred();
      const fault = new SqliteWorkerError("synthetic unknown write outcome", "outcome-unknown");
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (unknown) {
            throw fault;
          }
          return undefined;
        });
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          waiting,
          "Wait did not reach reconciliation",
        );
        await closeOpenClawStateDatabaseAsync();
        release.resolve();
        if (unknown) {
          await expect(waiting).rejects.toBe(fault);
        } else {
          await expect(waiting).resolves.toBeUndefined();
        }
        expect(f.current()).toEqual(before);
        expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
        expect(f.options.scheduleSweep).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([waiting]);
        timing.mockRestore();
      }
    });
  },
);
