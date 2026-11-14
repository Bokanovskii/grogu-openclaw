import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../grogu/plugins/research-topics/index.js";
import { parseRequest, type LedgerOperations } from "../../grogu/plugins/research-topics/schema.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stores: SqliteWorkerStore<LedgerOperations>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
});
const START = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

async function open(databasePath = path.join(tempDirs.make("research-ledger-"), "ledger.sqlite")) {
  const store = await openSqliteWorkerStore<LedgerOperations>({
    databasePath,
    moduleUrl: new URL("../../grogu/plugins/research-topics/store.worker.ts", import.meta.url),
    input: {},
  });
  stores.push(store);
  let now = START;
  return {
    databasePath,
    at: (time: number) => {
      now = time;
    },
    run: async (value: unknown) => {
      const request = parseRequest(value);
      return runSqliteWorkerStoreWrite(
        store,
        (scope) => scope.execute({ type: "request", input: { request, now } }),
        () => {},
        [databasePath],
      );
    },
  };
}

function leaseId(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("leaseId" in value) ||
    typeof value.leaseId !== "string"
  ) {
    throw new Error("Expected an acquired research lease");
  }
  return value.leaseId;
}

describe("research_topics ledger operations", () => {
  it("runs the registered chat/automation tool through the real worker and rejects revoked callers", async () => {
    const root = tempDirs.make("research-tool-");
    const registered = vi.fn<OpenClawPluginApi["registerTool"]>();
    const service = vi.fn<OpenClawPluginApi["registerService"]>();
    const api = createTestPluginApi({
      id: "research-topics",
      runtimeSource: fileURLToPath(
        new URL("../../grogu/plugins/research-topics/index.ts", import.meta.url),
      ),
      registerTool: registered,
      registerService: service,
    });
    api.runtime.state = {
      resolveStateDir: () => root,
      openBlobStore: () => {
        throw new Error("Unused");
      },
      openKeyedStore: () => {
        throw new Error("Unused");
      },
      openSyncKeyedStore: () => {
        throw new Error("Unused");
      },
      openChannelIngressQueue: () => {
        throw new Error("Unused");
      },
      openChannelIngressDrain: () => {
        throw new Error("Unused");
      },
    };
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
    let active = true;
    const tool = factory.create({
      assertInvocationCurrent: () => {
        if (!active) {
          throw new Error("Caller revoked");
        }
      },
    });
    const cleanup = service.mock.calls[0]?.[0].stop;
    if (!tool || Array.isArray(tool) || !cleanup) {
      throw new Error("Expected a research tool and shutdown owner");
    }
    try {
      const result = await tool.execute("add", {
        action: "add",
        id: "synthetic",
        title: "Synthetic topic",
      });
      expect(result.details).toMatchObject({ id: "synthetic", revision: 1 });
      const listing = await tool.execute("list", { action: "list" });
      expect(listing.details).toMatchObject({ topics: [{ id: "synthetic" }] });
      await tool.execute("source", {
        action: "source_set",
        id: "shared",
        minimumIntervalMinutes: 30,
      });
      await tool.execute("attach", {
        action: "update",
        id: "synthetic",
        expectedRevision: 1,
        changes: { sourceIds: ["shared"] },
      });
      await tool.execute("peer", {
        action: "add",
        id: "peer",
        title: "Peer topic",
        sourceIds: ["shared"],
      });
      const competing = await Promise.all([
        tool.execute("claim-first", { action: "acquire", id: "synthetic" }),
        tool.execute("claim-second", { action: "acquire", id: "peer" }),
      ]);
      expect(competing.map((attempt) => attempt.details)).toEqual([
        expect.objectContaining({ acquired: true }),
        { acquired: false, reason: "not-due-or-source-unavailable" },
      ]);
      await tool.execute("settle", {
        action: "record_check",
        id: "synthetic",
        leaseId: leaseId(competing[0]?.details),
        sources: [{ id: "shared", outcome: "skipped" }],
      });
      active = false;
      await expect(
        tool.execute("remove", {
          action: "remove",
          id: "synthetic",
          expectedRevision: 1,
          hardDelete: true,
        }),
      ).rejects.toThrow("Caller revoked");
      active = true;
      expect((await tool.execute("get", { action: "get", id: "synthetic" })).details).toMatchObject(
        { id: "synthetic" },
      );
    } finally {
      await cleanup({
        config: {},
        stateDir: root,
        logger: api.logger,
        scheduler: createTestPluginServiceScheduler(),
      });
    }
    await expect(tool.execute("late", { action: "list" })).rejects.toThrow("plugin stopped");
  });

  it("rejects a ledger write revoked while it waits on SQLite's writer lock", async () => {
    const root = tempDirs.make("research-writer-lock-");
    const databasePath = path.join(root, "ledger.sqlite");
    const runtimeSource = fileURLToPath(
      new URL("../../grogu/plugins/research-topics/index.ts", import.meta.url),
    );
    const store = await openSqliteWorkerStore<LedgerOperations>({
      databasePath,
      moduleUrl: new URL("./store.worker.ts", pathToFileURL(runtimeSource)),
      input: {},
    });
    const lock = new DatabaseSync(databasePath);
    lock.exec("BEGIN IMMEDIATE");
    let lockHeld = true;
    let active = true;
    try {
      let notifyDispatched = () => {};
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatched = resolve;
      });
      const write = runSqliteWorkerStoreWrite(
        store,
        (scope) => {
          const dispatchedWrite = scope.execute({
            type: "request",
            input: {
              request: parseRequest({
                action: "add",
                id: "revoked-while-waiting",
                title: "Revoked while waiting",
              }),
              now: START,
            },
          });
          notifyDispatched();
          return dispatchedWrite;
        },
        () => {
          if (!active) {
            throw new Error("Caller revoked");
          }
        },
        [databasePath],
      );
      await dispatched;
      active = false;
      lock.exec("ROLLBACK");
      lockHeld = false;
      await expect(write).rejects.toThrow();
      await expect(
        store.execute({
          type: "request",
          input: {
            request: parseRequest({ action: "get", id: "revoked-while-waiting" }),
            now: START,
          },
        }),
      ).rejects.toThrow("Unknown research topic");
    } finally {
      if (lockHeld) {
        lock.exec("ROLLBACK");
      }
      lock.close();
      await store.close();
    }
  });

  it("persists additive topics, bounded reads, optimistic edits, stopping and permanent removal", async () => {
    const ledger = await open();
    await ledger.run({ action: "add", id: "weather", title: "Weather", origin: "noticed" });
    await ledger.run({ action: "add", id: "events", title: "Events", cadenceMinutes: null });
    await expect(ledger.run({ action: "add", id: "weather", title: "Overwrite" })).rejects.toThrow(
      "already exists",
    );
    const other = await open(ledger.databasePath);
    expect(await other.run({ action: "get", id: "weather" })).toMatchObject({
      title: "Weather",
      origin: "noticed",
      revision: 1,
      createdAtMs: START,
    });
    expect(await other.run({ action: "list", limit: 1 })).toEqual({
      topics: [expect.objectContaining({ id: "events" })],
      nextCursor: "events",
    });
    expect(await other.run({ action: "list", after: "events" })).toMatchObject({
      topics: [{ id: "weather" }],
      nextCursor: null,
    });
    await other.run({
      action: "update",
      id: "weather",
      expectedRevision: 1,
      changes: { priority: "high", notes: "Keep it short" },
    });
    await expect(
      ledger.run({
        action: "update",
        id: "weather",
        expectedRevision: 1,
        changes: { title: "Lost edit" },
      }),
    ).rejects.toThrow("revision changed");
    expect(await ledger.run({ action: "due" })).toMatchObject({
      topics: [{ id: "weather", priority: "high" }],
    });
    await ledger.run({
      action: "update",
      id: "weather",
      expectedRevision: 2,
      changes: { status: "paused" },
    });
    expect(await ledger.run({ action: "due" })).toEqual({ topics: [] });
    await expect(ledger.run({ action: "signal", id: "weather" })).rejects.toThrow("not active");
    await ledger.run({ action: "remove", id: "weather", expectedRevision: 3 });
    expect(await other.run({ action: "get", id: "weather" })).toMatchObject({
      status: "archived",
      notes: "Keep it short",
    });
    await ledger.run({ action: "remove", id: "weather", expectedRevision: 4, hardDelete: true });
    await expect(other.run({ action: "get", id: "weather" })).rejects.toThrow(
      "Unknown research topic",
    );
    expect(statSync(ledger.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(ledger.databasePath)).mode & 0o777).toBe(0o700);
  });

  it("orders due topics by priority, then due time, and only researches on-signal topics after a signal", async () => {
    const ledger = await open();
    for (const [id, priority, nextDueAtMs] of [
      ["low", "low", START - 10],
      ["normal", "normal", START - 10],
      ["high-new", "high", START],
      ["high-old", "high", START - 1],
    ]) {
      await ledger.run({ action: "add", id, title: id, priority, nextDueAtMs });
    }
    await ledger.run({ action: "add", id: "signal", title: "On signal", cadenceMinutes: null });
    await ledger.run({ action: "add", id: "done", title: "Done", status: "done" });
    await ledger.run({ action: "add", id: "future", title: "Future", nextDueAtMs: START + 1 });
    expect(await ledger.run({ action: "due" })).toMatchObject({
      topics: ["high-old", "high-new", "normal", "low"].map((id) => ({ id })),
    });
    await ledger.run({ action: "signal", id: "signal" });
    const lease = leaseId(await ledger.run({ action: "acquire", id: "signal" }));
    await ledger.run({ action: "record_check", id: "signal", leaseId: lease, sources: [] });
    expect(await ledger.run({ action: "get", id: "signal" })).toMatchObject({
      nextDueAtMs: null,
      lastCheckedAtMs: START,
    });
  });

  it("shares source limits across topics and separates attempted fetches, successes and 429 backoff", async () => {
    const ledger = await open();
    await ledger.run({ action: "source_set", id: "example.org", minimumIntervalMinutes: 30 });
    for (const id of ["first", "second"]) {
      await ledger.run({
        action: "add",
        id,
        title: id,
        sourceIds: ["example.org"],
        cadenceMinutes: 1,
      });
    }
    const other = await open(ledger.databasePath);
    const lease = leaseId(await ledger.run({ action: "acquire", id: "first" }));
    expect(await other.run({ action: "acquire", id: "second" })).toEqual({
      acquired: false,
      reason: "not-due-or-source-unavailable",
    });
    expect(await other.run({ action: "due" })).toEqual({ topics: [] });
    ledger.at(START + MINUTE);
    await ledger.run({
      action: "record_check",
      id: "first",
      leaseId: lease,
      sources: [{ id: "example.org", outcome: "ok" }],
    });
    expect(await other.run({ action: "source_list" })).toMatchObject({
      sources: [{ lastAttemptedAtMs: START, lastFetchedAtMs: START + MINUTE, lastStatus: "ok" }],
    });
    other.at(START + 29 * MINUTE);
    expect(await other.run({ action: "due" })).toEqual({ topics: [] });
    other.at(START + 30 * MINUTE);
    expect(await other.run({ action: "due" })).toEqual({ topics: [] });
    other.at(START + 31 * MINUTE);
    const throttledLease = leaseId(await other.run({ action: "acquire", id: "second" }));
    await other.run({
      action: "record_check",
      id: "second",
      leaseId: throttledLease,
      sources: [{ id: "example.org", outcome: "throttled", retryAfterMinutes: 120 }],
    });
    expect(await other.run({ action: "source_list" })).toMatchObject({
      sources: [
        {
          lastAttemptedAtMs: START + 31 * MINUTE,
          lastFetchedAtMs: START + MINUTE,
          lastStatus: "throttled",
          backoffUntilMs: START + 151 * MINUTE,
        },
      ],
    });
    other.at(START + 150 * MINUTE);
    expect(await other.run({ action: "due" })).toEqual({ topics: [] });
    other.at(START + 151 * MINUTE);
    expect(await other.run({ action: "due" })).toMatchObject({
      topics: [{ id: "first" }, { id: "second" }],
    });
    await expect(
      other.run({ action: "source_set", id: "example.org", minimumIntervalMinutes: 1 }),
    ).rejects.toThrow("revision changed");
  });

  it("settles checks atomically without losing owner edits or signals during research", async () => {
    const ledger = await open();
    await ledger.run({ action: "source_set", id: "feed", minimumIntervalMinutes: 1 });
    await ledger.run({ action: "add", id: "topic", title: "Topic", sourceIds: ["feed"] });
    const lease = leaseId(await ledger.run({ action: "acquire", id: "topic" }));
    await expect(
      ledger.run({ action: "record_check", id: "topic", leaseId: lease, sources: [] }),
    ).rejects.toThrow("every source");
    await expect(
      ledger.run({
        action: "record_check",
        id: "topic",
        leaseId: lease,
        sources: [
          { id: "feed", outcome: "ok" },
          { id: "feed", outcome: "ok" },
        ],
      }),
    ).rejects.toThrow("every source");
    await ledger.run({
      action: "update",
      id: "topic",
      expectedRevision: 2,
      changes: { notes: "Owner edit", cadenceMinutes: null },
    });
    await ledger.run({ action: "signal", id: "topic" });
    await ledger.run({
      action: "record_check",
      id: "topic",
      leaseId: lease,
      sources: [{ id: "feed", outcome: "error" }],
    });
    expect(await ledger.run({ action: "get", id: "topic" })).toMatchObject({
      notes: "Owner edit",
      cadenceMinutes: null,
      nextDueAtMs: START,
      lastCheckedAtMs: START,
      sources: [{ lastFetchedAtMs: null, lastStatus: "error", backoffUntilMs: START + 5 * MINUTE }],
    });
    ledger.at(START + 10 * MINUTE);
    const confirmed = await ledger.run({
      action: "record_notification",
      id: "topic",
      confirmedAtMs: START + 2 * MINUTE,
    });
    expect(confirmed).toMatchObject({
      lastNotifiedAtMs: START + 2 * MINUTE,
      updatedAtMs: START + 10 * MINUTE,
      notes: "Owner edit",
      cadenceMinutes: null,
    });
    ledger.at(START + 20 * MINUTE);
    for (const confirmedAtMs of [START + 2 * MINUTE, START + MINUTE]) {
      expect(
        await ledger.run({ action: "record_notification", id: "topic", confirmedAtMs }),
      ).toEqual(confirmed);
    }
    for (const confirmedAtMs of [START - 1, START + 21 * MINUTE]) {
      await expect(
        ledger.run({ action: "record_notification", id: "topic", confirmedAtMs }),
      ).rejects.toThrow("confirmation time");
    }
    expect(await ledger.run({ action: "get", id: "topic" })).toEqual(confirmed);
  });

  it("recovers expired claims and rejects late results, invalid input and unknown sources without partial writes", async () => {
    const ledger = await open();
    await expect(
      ledger.run({ action: "add", id: "bad", title: "Bad", sourceIds: ["missing"] }),
    ).rejects.toThrow("Unknown research source");
    expect(await ledger.run({ action: "list" })).toMatchObject({ topics: [] });
    for (const request of [
      { action: "add", id: "../escape", title: "Bad" },
      { action: "add", id: "bad", title: " " },
      { action: "add", id: "bad", title: "Bad", cadenceMinutes: 0 },
      { action: "update", id: "bad", expectedRevision: 1, changes: { typo: true } },
      { action: "due", limit: 51 },
      { action: "record_notification", id: "bad" },
    ]) {
      await expect(ledger.run(request)).rejects.toThrow("Invalid research_topics");
    }
    await ledger.run({ action: "add", id: "topic", title: "Topic" });
    const old = leaseId(await ledger.run({ action: "acquire", id: "topic", leaseMinutes: 1 }));
    ledger.at(START + MINUTE);
    const current = leaseId(await ledger.run({ action: "acquire", id: "topic" }));
    await expect(
      ledger.run({ action: "record_check", id: "topic", leaseId: old, sources: [] }),
    ).rejects.toThrow("lease expired or changed");
    await ledger.run({
      action: "update",
      id: "topic",
      expectedRevision: 3,
      changes: { status: "paused", nextDueAtMs: START + 120 * MINUTE },
    });
    await ledger.run({ action: "record_check", id: "topic", leaseId: current, sources: [] });
    expect(await ledger.run({ action: "get", id: "topic" })).toMatchObject({
      status: "paused",
      nextDueAtMs: START + 120 * MINUTE,
    });
    expect(await ledger.run({ action: "due" })).toEqual({ topics: [] });
  });
});
