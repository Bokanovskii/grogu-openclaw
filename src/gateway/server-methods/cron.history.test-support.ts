import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { CronHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { cronRunLogEntryToDetail } from "../../cron/run-history-detail.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { recordCronRunInDatabase } from "../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { cronHandlers } from "./cron.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export function persistHistory(records: CronRunHistoryWrite[]) {
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const record of records) {
      recordCronRunInDatabase(db, record);
    }
  });
}

export async function withCronTranscript(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  let registry: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      registry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(createEmptyPluginRegistry());
      try {
        const fixture = await setup();
        try {
          await run(fixture);
        } finally {
          fixture.cron.stop();
        }
      } finally {
        await disposeSessionReadContexts();
      }
    });
  } finally {
    if (registry) {
      restoreActivePluginRegistrySnapshot(registry);
    }
  }
}

async function setup() {
  const profile = ensureProfileForEmail("cron-reader@example.test");
  const baseKey = "agent:main:cron:history-job";
  const oldScope = { agentId: "main", sessionKey: baseKey, sessionId: "old-cron" };
  await upsertSessionEntryCore(oldScope, {
    sessionId: oldScope.sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  for (const content of ["Old first", "Old second", "Old last"]) {
    await appendTranscriptMessage(oldScope, { message: { role: "assistant", content } });
  }
  const alias = `${baseKey}:run:${oldScope.sessionId}`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: alias },
    { sessionId: oldScope.sessionId, updatedAt: 1 },
  );
  await deleteSessionEntryLifecycle({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    target: { canonicalKey: alias, storeKeys: [alias] },
    archiveTranscript: false,
    expectedSessionId: oldScope.sessionId,
  });
  const latest = { ...oldScope, sessionId: "new-cron" };
  await upsertSessionEntryCore(latest, {
    sessionId: latest.sessionId,
    updatedAt: 2,
    visibility: "shared",
  });
  await appendTranscriptMessage(latest, {
    message: { role: "assistant", content: "Latest run only" },
  });
  const storePath = path.join(
    expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated state"),
    "cron",
    "jobs.json",
  );
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    defaultAgentId: "main",
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const created = await cron.add(
    {
      name: "History job",
      agentId: "main",
      owner: { agentId: "main", sessionKey: baseKey },
      schedule: { kind: "every", everyMs: 60_000 },
      enabled: false,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "fixture" },
      delivery: { mode: "none" },
    },
    { scheduledToolPolicy: { version: 1, mode: "trusted" } },
  );
  const job = "job" in created ? created.job : created;
  const record: CronRunHistoryWrite = {
    storeKey: cronStoreKey(storePath),
    jobId: job.id,
    runId: "internal-old-run",
    sessionKey: alias,
    agentId: "main",
    startedAt: 10,
    endedAt: 20,
    status: "succeeded",
    detail: cronRunLogEntryToDetail(
      {
        jobId: job.id,
        action: "finished",
        ts: 20,
        runAtMs: 10,
        runId: "public-old-run",
        sessionKey: alias,
        sessionId: oldScope.sessionId,
        status: "ok",
      },
      { storeKey: cronStoreKey(storePath) },
    ),
  };
  persistHistory([record]);
  const context = await createHistoryReadContext({ cron, cronStorePath: storePath });
  const query = async (
    params: Record<string, unknown>,
    options: Partial<
      Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">
    > = {},
    readContext = context,
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      cronHandlers["cron.history"],
      "registered cron.history",
    )({
      req: { type: "req", id: "history", method: "cron.history", params },
      params,
      client: null,
      context: readContext,
      respond,
      isWebchatConnect: () => false,
      ...options,
    });
    return { respond, payload: respond.mock.calls[0]?.[1] as CronHistoryResult | undefined };
  };
  return {
    cron,
    storePath,
    baseKey,
    alias,
    oldScope,
    latest,
    job,
    record,
    context,
    query,
    profile,
  };
}
