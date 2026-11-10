import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeCronJobScratchInDatabase } from "../../cron/scratch-write.kernel.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import type { CronJob } from "../../cron/types.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronHandlers } from "./cron.js";
import {
  createCronCallerClient as callerClient,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const cronLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-scratch-read-" });
const getRuntimeConfig = () => ({});
const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);
const createCronContext = (job: CronJob) => createCronTestContext(job, getRuntimeConfig);

describe("cron scratch read authority", () => {
  it("allows same-account cross-session scratch reads without allowing writes", async () => {
    const { storePath } = await makeStorePath();
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: cronLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });
    try {
      const owner = { agentId: "ops", sessionKey: "agent:ops:creator", accountId: "work" };
      const scheduledToolPolicy = {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
      const job = await cron.add(
        {
          id: "scratch-read-shared",
          name: "scratch read shared",
          agentId: "ops",
          owner,
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "synthetic event", toolsAllow: ["read"] },
        },
        { scheduledToolPolicy },
      );
      await cron.writeScratch(job.id, {
        content: "same-account scratch",
        expectedRevision: 0,
      });
      const context = createCronContext(job);
      context.cron.readJob.mockImplementation((id) => cron.readJob(id));
      context.cron.getJob.mockImplementation((id) => cron.getJob(id));
      context.cron.readScratch.mockImplementation((...args) => cron.readScratch(...args));
      const reader = callerClient("ops", owner.accountId, "agent:ops:reader");

      const read = await invokeCron(
        "cron.scratch.get",
        { id: job.id },
        { context, client: reader },
      );
      expect(read.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          currentRevision: 1,
          scratch: expect.objectContaining({ content: "same-account scratch" }),
        }),
        undefined,
      );

      const wrongAccountReader = callerClient("ops", "personal", "agent:ops:reader");
      context.cron.readScratch.mockClear();
      const crossAccountRead = await invokeCron(
        "cron.scratch.get",
        { id: job.id },
        { context, client: wrongAccountReader },
      );
      expect(crossAccountRead.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(context.cron.readScratch).not.toHaveBeenCalled();

      const write = await invokeCron(
        "cron.scratch.set",
        { id: job.id, content: "must remain private", expectedRevision: 1 },
        { context, client: reader },
      );
      expect(write.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(context.cron.writeScratch).not.toHaveBeenCalled();
    } finally {
      cron.stop();
    }
  });

  it.each(["caller closes after read", "owner transfers before read"] as const)(
    "withholds private scratch when %s",
    async (change) => {
      const { storePath } = await makeStorePath();
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: cronLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const entered = createDeferred();
      const release = createDeferred();
      let invocation: Promise<unknown> | undefined;
      try {
        const owner = { agentId: "ops", sessionKey: "agent:ops:main", accountId: "work" };
        const scheduledToolPolicy = {
          version: 1 as const,
          mode: "account" as const,
          ownerSessionKey: owner.sessionKey,
          ownerAccountId: owner.accountId,
        };
        const job = await cron.add(
          {
            id: "scratch-read-owner",
            name: "scratch read owner",
            agentId: "ops",
            owner,
            enabled: false,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "synthetic event", toolsAllow: ["read"] },
          },
          { scheduledToolPolicy },
        );
        await cron.writeScratch(job.id, {
          content: "original private scratch",
          expectedRevision: 0,
        });
        const context = createCronContext(job);
        context.cron.readJob.mockImplementation((id) => cron.readJob(id));
        context.cron.getJob.mockImplementation((id) => cron.getJob(id));
        const client = callerClient("ops", owner.accountId, owner.sessionKey);
        context.cron.readScratch.mockImplementation((...args) => cron.readScratch(...args));
        const permitted = await invokeCron("cron.scratch.get", { id: job.id }, { context, client });
        expect(permitted.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            currentRevision: 1,
            scratch: expect.objectContaining({ content: "original private scratch" }),
          }),
          undefined,
        );
        context.cron.readScratch.mockClear();
        let current = true;
        context.cron.readScratch.mockImplementation(async (...args) => {
          if (change === "owner transfers before read") {
            entered.resolve();
            await release.promise;
          }
          const result = await cron.readScratch(...args);
          if (change === "caller closes after read") {
            current = false;
          }
          return result;
        });
        const respond = vi.fn();
        invocation = invokeCron(
          "cron.scratch.get",
          { id: job.id },
          {
            context,
            respond,
            client,
            hasCurrentClientAuthority: () => current,
          },
        ).then(
          () => ({ rejected: false }),
          (error: unknown) => ({ rejected: true, error }),
        );
        if (change === "owner transfers before read") {
          expect(
            await Promise.race([
              entered.promise.then(() => "scope-checked"),
              invocation.then(() => "completed-before-read"),
            ]),
          ).toBe("scope-checked");
          const peer = new DatabaseSync(resolveOpenClawStateSqlitePath());
          try {
            runSqliteImmediateTransactionSync(peer, () => {
              upsertCronJobRow(
                peer,
                cronStoreKey(storePath),
                {
                  ...job,
                  agentId: "worker",
                  owner: { agentId: "worker", sessionKey: "agent:worker:main", accountId: "work" },
                  scheduledToolPolicy: {
                    ...scheduledToolPolicy,
                    ownerSessionKey: "agent:worker:main",
                  },
                },
                0,
              );
              expect(
                writeCronJobScratchInDatabase(peer, {
                  storeKey: cronStoreKey(storePath),
                  jobId: job.id,
                  content: "peer private scratch",
                  expectedRevision: 1,
                  nowMs: Date.now(),
                }).result.ok,
              ).toBe(true);
            });
          } finally {
            peer.close();
          }
          expect(
            (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.agentId,
          ).toBe("worker");
          expect(cron.getJob(job.id)?.agentId).toBe("ops");
          release.resolve();
        }
        const result = await invocation;
        expect(context.cron.readScratch).toHaveBeenCalledOnce();
        if (change === "caller closes after read") {
          expect.soft(result).toMatchObject({
            rejected: true,
            error: { message: expect.stringContaining("authority closed") },
          });
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect.soft(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
          expect(JSON.stringify(respond.mock.calls)).not.toContain("peer private scratch");
        }
      } finally {
        release.resolve();
        await invocation;
        cron.stop();
      }
    },
  );
});
