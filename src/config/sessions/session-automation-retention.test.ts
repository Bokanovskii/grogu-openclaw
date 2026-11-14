import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "../../trajectory/runtime-store.sqlite.js";
import { createTrajectoryEvent } from "../../trajectory/runtime-store.test-support.js";
import { resolveSessionStorePathCore } from "./paths.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { runAutomationDetailRetentionForStore } from "./session-automation-retention.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import {
  readSessionColdTranscript,
  SessionTranscriptColdError,
} from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";

// mock-isolation: This fixture invokes retention explicitly, without competing maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Explicit retention owns this fixture, not background eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("expires only proven old automation detail through the worker and preserves active work", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const now = Date.now();
    const old = now - 8 * 86_400_000;
    const cutoff = now - 7 * 86_400_000;
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:main",
      sessionId: "shared",
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: now });
    const append = (id: string, message: Record<string, unknown>, at = old) => {
      expect(appendTranscriptMessageSync(scope, { eventId: id, message, now: at })).toMatchObject({
        ok: true,
      });
    };
    const provenance = {
      kind: "internal_system",
      sourceTool: "cron",
      jobId: "job",
      runId: "automation-run",
    };
    append("personal", { role: "user", content: "personal chat" });
    append("personal-answer", {
      role: "assistant",
      content: [{ type: "text", text: "personal answer" }],
      __openclaw: { runId: "personal-run" },
    });
    append("legacy", { role: "assistant", content: [{ type: "text", text: "uncorrelated" }] });
    append("automation", { role: "user", content: "old automation input", provenance });
    for (let index = 0; index < 130; index++) {
      append(`reply-${index}`, {
        role: index % 2 ? "assistant" : "toolResult",
        content: [{ type: "text", text: "old automation detail" }],
        __openclaw: { runId: "automation-run" },
      });
    }
    append(
      "recent",
      {
        role: "user",
        content: "recent automation",
        provenance: { ...provenance, runId: "recent-run" },
      },
      now,
    );
    appendSqliteTrajectoryRuntimeEvents(
      scope,
      ["automation-run", "personal-run", "recent-run"].map((runId, index) =>
        Object.assign(
          createTrajectoryEvent({
            type: "model.completed",
            ts: new Date(runId === "recent-run" ? now : old).toISOString(),
            sessionId: scope.sessionId,
            runId,
            seq: index + 1,
          }),
          { sessionKey: scope.sessionKey, data: { messagesSnapshot: ["old detail"] } },
        ),
      ),
    );
    const before = readTranscriptEventRows(database, scope.sessionId);
    for (const phase of ["pending", "acquired", "settling", "unbound"]) {
      const entered = createDeferred();
      const allowed = createDeferred();
      const admission = beginSessionWorkAdmission({
        scope: database.path,
        identities: phase === "unbound" ? [] : [scope.sessionKey, scope.sessionId],
        signal,
        isSettling: () => phase === "settling",
        async assertAllowed() {
          entered.resolve();
          await allowed.promise;
        },
      });
      await withinTest(entered.promise, signal);
      if (phase !== "pending") {
        allowed.resolve();
        await withinTest(admission, signal);
      }
      try {
        expect(
          await runAutomationDetailRetentionForStore({
            agentId: "main",
            storePath: database.path,
            cutoff,
            assertCurrent() {},
          }),
          phase,
        ).toEqual({ rewritten: 0, runtimeDeleted: 0 });
        expect(readTranscriptEventRows(database, scope.sessionId)).toEqual(before);
      } finally {
        allowed.resolve();
        (await admission).release();
      }
    }
    const sql = observeHostDataSql();
    try {
      expect(
        await runAutomationDetailRetentionForStore({
          agentId: "main",
          storePath: database.path,
          cutoff,
          assertCurrent() {},
        }),
      ).toEqual({ rewritten: 131, runtimeDeleted: 1 });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    const after = readTranscriptEventRows(database, scope.sessionId);
    expect(after).toHaveLength(before.length);
    for (const id of ["personal", "personal-answer", "legacy", "recent"]) {
      expect(after.find((row) => JSON.parse(row.eventJson).id === id)).toEqual(
        before.find((row) => JSON.parse(row.eventJson).id === id),
      );
    }
    expect(
      after.filter((row) => JSON.parse(row.eventJson).customType === "automation-detail-expired"),
    ).toHaveLength(131);
    const retained = loadSqliteTrajectoryRuntimeEventRowsSync(scope);
    expect(retained.map(({ event }) => event.runId)).toEqual(["personal-run", "recent-run"]);
    expect(
      await runAutomationDetailRetentionForStore({
        agentId: "main",
        storePath: database.path,
        cutoff,
        assertCurrent() {},
      }),
    ).toEqual({ rewritten: 0, runtimeDeleted: 0 });
  });
});

it("does not expire detail while another receipt owner holds physical custody", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:cron:foreign-receipt",
      sessionId: "foreign-receipt",
    };
    const old = Date.now() - 8 * 86_400_000;
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: old });
    expect(
      appendTranscriptMessageSync(scope, {
        eventId: "protected-output",
        now: old,
        message: { role: "assistant", content: "Still owned by another host." },
      }),
    ).toMatchObject({ ok: true });
    const before = readTranscriptEventRows(database, scope.sessionId);
    const context = captureOpenClawStateWorkerContext();
    const foreign = await acquireFileLock(
      `${context.admission.identity.canonicalPath}.cron-authority`,
      { retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 }, stale: 0 },
    );
    try {
      await expect(
        runAutomationDetailRetentionForStore({
          agentId: "main",
          storePath: database.path,
          cutoff: Date.now() - 7 * 86_400_000,
          assertCurrent() {},
        }),
      ).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(readTranscriptEventRows(database, scope.sessionId)).toEqual(before);
    } finally {
      await foreign.release();
    }
  });
});

it.each(["target", "target-store-selector", "unrelated"] as const)(
  "rechecks %s activity at the actual retention commit",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const old = Date.now() - 8 * 86_400_000;
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:retention-target",
        sessionId: "retention-target",
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: old });
      expect(
        appendTranscriptMessageSync(scope, {
          eventId: "automation",
          now: old,
          message: {
            role: "user",
            content: "automation detail",
            provenance: {
              kind: "internal_system",
              sourceTool: "cron",
              jobId: "job",
              runId: "run",
            },
          },
        }),
      ).toMatchObject({ ok: true });
      const before = readTranscriptEventRows(database, scope.sessionId);
      let injected = false;
      let claim: string | undefined;
      const admission = probe.admission(operationAdmission, (request, grant, admit) => {
        if (request.stage === "commit" && !injected) {
          injected = true;
          claim = claimAgentRunContext(
            "retention-active-proof",
            {
              agentId: "main",
              storePath:
                change === "target-store-selector"
                  ? resolveSessionStorePathCore(undefined, { agentId: "main" })
                  : database.path,
              sessionKey: change !== "unrelated" ? scope.sessionKey : "agent:main:other",
              sessionId: change !== "unrelated" ? scope.sessionId : "other-session",
              projectSessionActive: false,
              isControlUiVisible: false,
            },
            { trackOwner: true },
          );
          expect(claim).toBeDefined();
        }
        admit(request, grant);
      });
      try {
        const sweep = runAutomationDetailRetentionForStore({
          agentId: "main",
          storePath: database.path,
          cutoff: Date.now() - 7 * 86_400_000,
          assertCurrent() {},
        });
        if (change !== "unrelated") {
          await expect(sweep).rejects.toThrow("active");
          expect(readTranscriptEventRows(database, scope.sessionId)).toEqual(before);
        } else {
          await expect(sweep).resolves.toEqual({ rewritten: 1, runtimeDeleted: 0 });
          expect(
            readTranscriptEventRows(database, scope.sessionId).map((row) =>
              JSON.parse(row.eventJson),
            ),
          ).toContainEqual(
            expect.objectContaining({ id: "automation", customType: "automation-detail-expired" }),
          );
        }
        expect(injected).toBe(true);
      } finally {
        releaseAgentRunContext("retention-active-proof", claim);
        admission.mockRestore();
      }
    });
  },
);

it("expires historical cron windows after the registry advances to a new session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const old = Date.now() - 8 * 86_400_000;
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:cron:job",
      sessionId: "retained-old-generation",
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: old });
    for (const [id, message] of [
      ["personal", { role: "user", content: "owner message" }],
      ["reply", { role: "assistant", content: [{ type: "text", text: "legacy cron output" }] }],
    ] as const) {
      expect(appendTranscriptMessageSync(scope, { eventId: id, message, now: old })).toMatchObject({
        ok: true,
      });
    }
    const before = readTranscriptEventRows(database, scope.sessionId);
    appendSqliteTrajectoryRuntimeEvents(
      scope,
      Array.from({ length: 129 }, (_, index) => ({
        ...createTrajectoryEvent({
          type: "model.completed",
          ts: new Date(old).toISOString(),
          sessionId: scope.sessionId,
          runId: "legacy-run-without-input-correlation",
          seq: index + 1,
        }),
        sessionKey: scope.sessionKey,
        data: { messagesSnapshot: ["expired snapshot"] },
      })),
    );
    replaceSessionEntrySync(scope, { sessionId: "new-generation", updatedAt: Date.now() });
    expect(
      await runAutomationDetailRetentionForStore({
        agentId: "main",
        storePath: database.path,
        cutoff: Date.now() - 7 * 86_400_000,
        assertCurrent() {},
      }),
    ).toEqual({ rewritten: 1, runtimeDeleted: 129 });
    const after = readTranscriptEventRows(database, scope.sessionId);
    expect(after.find((row) => JSON.parse(row.eventJson).id === "personal")).toEqual(
      before.find((row) => JSON.parse(row.eventJson).id === "personal"),
    );
    expect(after.map((row) => JSON.parse(row.eventJson))).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "automation-detail-expired",
        id: "reply",
      }),
    );
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope)).toEqual([]);
  });
});

it("keeps personal follow-ups in cron sessions while expiring scheduled runs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const old = Date.now() - 8 * 86_400_000;
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:cron:job",
      sessionId: "cron-session",
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: old });
    const prompt = (runId: string) => ({
      role: "user",
      content: "scheduled input",
      provenance: { kind: "internal_system", sourceTool: "cron", jobId: "job", runId },
    });
    const reply = (role: string, runId: string) => ({
      role,
      content: [{ type: "text", text: "run detail" }],
      __openclaw: { runId },
    });
    const messages: [string, Record<string, unknown>][] = [
      ["prompt", prompt("cron-run")],
      ["agent-reply", reply("assistant", "agent-run")],
      ["personal", { role: "user", content: "owner follow-up" }],
      ["personal-tool", reply("toolResult", "personal-run")],
      ["personal-answer", reply("assistant", "personal-run")],
      ["next-prompt", prompt("cron-run-2")],
      ["next-reply", reply("assistant", "agent-run-2")],
    ];
    for (const [id, message] of messages) {
      expect(appendTranscriptMessageSync(scope, { eventId: id, message, now: old })).toMatchObject({
        ok: true,
      });
    }
    appendSqliteTrajectoryRuntimeEvents(
      scope,
      ["agent-run", "personal-run", "agent-run-2", undefined].map((runId, index) => {
        const event = createTrajectoryEvent({
          type: "model.completed",
          ts: new Date(old).toISOString(),
          sessionId: scope.sessionId,
          seq: index + 1,
        });
        return Object.assign(event, { runId, sessionKey: scope.sessionKey });
      }),
    );
    const before = readTranscriptEventRows(database, scope.sessionId);
    expect(
      await runAutomationDetailRetentionForStore({
        agentId: "main",
        storePath: database.path,
        cutoff: Date.now() - 7 * 86_400_000,
        assertCurrent() {},
      }),
    ).toEqual({ rewritten: 4, runtimeDeleted: 2 });
    const after = readTranscriptEventRows(database, scope.sessionId);
    const byId = (rows: typeof after, id: string) =>
      rows.find((row) => JSON.parse(row.eventJson).id === id);
    for (const id of ["personal", "personal-tool", "personal-answer"]) {
      expect(byId(after, id), id).toEqual(byId(before, id));
    }
    for (const id of ["prompt", "agent-reply", "next-prompt", "next-reply"]) {
      expect(JSON.parse(byId(after, id)!.eventJson), id).toMatchObject({
        customType: "automation-detail-expired",
      });
    }
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope).map(({ event }) => event.runId)).toEqual(
      ["personal-run", undefined],
    );
  });
});

function observeColdRestores() {
  const spy = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveWorkerOperation");
  return {
    count: () =>
      spy.mock.calls.filter(
        ([params]) =>
          params.expectedMessageType === "reclaimed" &&
          params.workerData.plan.kind === "cold-restore",
      ).length,
    restore: () => spy.mockRestore(),
  };
}

it("keeps personal-only cold archives in cold storage during automation retention", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const fixture = await createSessionColdStorageFixture(
      database.path,
      "agent:main:retired-personal",
    );
    const old = Date.now() - 8 * 86_400_000;
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE transcript_events SET created_at = ? WHERE session_id = ?").run(
        old,
        historicalId,
      );
    }, fixture.options);
    expect(
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(database.path) }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    const archive = readSessionColdTranscript(database.db, historicalId);
    expect(archive?.storage).toBe("file");
    if (!archive) {
      throw new Error("Missing cold personal archive");
    }
    const archivePath = resolveSessionColdArchivePath(database.path, archive.archive_name);
    await expect(fs.stat(archivePath)).resolves.toBeDefined();
    const restores = observeColdRestores();
    try {
      const cutoff = Date.now() - 7 * 86_400_000;
      // Personal-only archives are decoded once, not on every later sweep.
      for (const sweepCutoff of [cutoff, cutoff, Date.now()]) {
        expect(
          await runAutomationDetailRetentionForStore({
            agentId: "main",
            storePath: database.path,
            cutoff: sweepCutoff,
            assertCurrent() {},
          }),
        ).toEqual({ rewritten: 0, runtimeDeleted: 0 });
      }
      expect(restores.count()).toBe(1);
    } finally {
      restores.restore();
    }
    expect(readSessionColdTranscript(database.db, historicalId)).toEqual(archive);
    expect(() => readTranscriptEventRows(database, historicalId)).toThrow(
      SessionTranscriptColdError,
    );
    await expect(fs.stat(archivePath)).resolves.toBeDefined();
  });
});

it("expires cold automation detail without retaining the restored archive copy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const fixture = await createSessionColdStorageFixture(
      database.path,
      "agent:main:cron:cold-job",
    );
    const old = Date.now() - 8 * 86_400_000;
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE transcript_events SET created_at = ? WHERE session_id = ?").run(
        old,
        historicalId,
      );
    }, fixture.options);
    const before = readTranscriptEventRows(database, historicalId);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(database.path),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    const archive = readSessionColdTranscript(database.db, historicalId);
    expect(archive?.storage).toBe("file");
    if (!archive) {
      throw new Error("Missing cold automation archive");
    }
    const archivePath = resolveSessionColdArchivePath(database.path, archive.archive_name);
    await expect(fs.stat(archivePath)).resolves.toBeDefined();
    const restores = observeColdRestores();
    try {
      // Detail not yet past the cutoff defers further probes until the cutoff passes it.
      for (let sweep = 0; sweep < 2; sweep++) {
        expect(
          await runAutomationDetailRetentionForStore({
            agentId: "main",
            storePath: database.path,
            cutoff: old,
            assertCurrent() {},
          }),
        ).toEqual({ rewritten: 0, runtimeDeleted: 0 });
      }
      expect(restores.count()).toBe(1);
      expect(readSessionColdTranscript(database.db, historicalId)).toEqual(archive);
      expect(
        await runAutomationDetailRetentionForStore({
          agentId: "main",
          storePath: database.path,
          cutoff: Date.now() - 7 * 86_400_000,
          assertCurrent() {},
        }),
      ).toEqual({ rewritten: 1, runtimeDeleted: 0 });
      expect(restores.count()).toBe(2);
    } finally {
      restores.restore();
    }
    const after = readTranscriptEventRows(database, historicalId);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(JSON.parse(after[2]!.eventJson)).toMatchObject({
      type: "custom",
      customType: "automation-detail-expired",
      id: "history-assistant",
    });
    expect(
      database.db
        .prepare(
          "SELECT event_type FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
        )
        .get(historicalId, "history-assistant"),
    ).toEqual({ event_type: "custom" });
    expect(readSessionColdTranscript(database.db, historicalId)).toBeUndefined();
    await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
