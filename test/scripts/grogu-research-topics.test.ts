import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelivery } from "../../grogu/plugins/research-topics/delivery.js";
import plugin from "../../grogu/plugins/research-topics/index.js";
import {
  ResearchLedger,
  type ResearchMemberBinding,
} from "../../grogu/plugins/research-topics/ledger.js";
import {
  parseRequest,
  toolSchema,
  type LedgerOperations,
} from "../../grogu/plugins/research-topics/schema.js";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.js";
import { validateToolArguments } from "../../packages/llm-core/src/validation.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const stores: SqliteWorkerStore<LedgerOperations>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
});
const START = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const firstSession = { sessionKey: "agent:grogu:chat:first", sessionId: "first-incarnation" };
const secondSession = { sessionKey: "agent:grogu:chat:second", sessionId: "second-incarnation" };
const mainSession = { sessionKey: "agent:grogu:main", sessionId: "main-incarnation" };
const workerModule = new URL(
  "../../grogu/plugins/research-topics/store.worker.ts",
  import.meta.url,
);
const directory = () => directories.make("research-ledger-", process.cwd());

async function open(databasePath = path.join(directory(), "ledger.sqlite"), caller = firstSession) {
  const store = await openSqliteWorkerStore<LedgerOperations>({
    databasePath,
    moduleUrl: workerModule,
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
        (scope) => scope.execute({ type: "request", input: { request, now, caller, mainSession } }),
        () => {},
        [databasePath],
      );
    },
  };
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error(`Expected result field: ${key}`);
  }
  const field: unknown = Reflect.get(value, key);
  if (typeof field !== "string") {
    throw new Error(`Expected string result field: ${key}`);
  }
  return field;
}

function createV1(databasePath: string, now: number, activeLease = false) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL,
        priority TEXT NOT NULL, status TEXT NOT NULL, cadenceMinutes INTEGER,
        origin TEXT NOT NULL, notifyBar TEXT NOT NULL, notes TEXT NOT NULL,
        findingsRef TEXT NOT NULL, revision INTEGER NOT NULL,
        createdAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL,
        lastCheckedAtMs INTEGER, nextDueAtMs INTEGER, lastNotifiedAtMs INTEGER,
        leaseId TEXT, leaseUntilMs INTEGER, pendingDue INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX topics_due ON topics(status, nextDueAtMs);
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, minimumIntervalMinutes INTEGER NOT NULL,
        lastAttemptedAtMs INTEGER, lastFetchedAtMs INTEGER, lastStatus TEXT,
        backoffUntilMs INTEGER, leaseId TEXT, leaseUntilMs INTEGER, revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE topic_sources (
        topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        sourceId TEXT NOT NULL REFERENCES sources(id), PRIMARY KEY(topicId, sourceId)
      ) STRICT;
      CREATE INDEX topic_sources_source ON topic_sources(sourceId);
      PRAGMA user_version=1;
    `);
    db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "provider",
      30,
      now,
      now - MINUTE,
      "throttled",
      now + 10 * MINUTE,
      "source-reservation",
      now + 60 * MINUTE,
      4,
    );
    for (const [id, status, cadence] of [
      ["active", "active", 360],
      ["paused", "paused", null],
      ["done", "done", 360],
      ["archive", "archived", 360],
    ] as const) {
      db.prepare(
        "INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        `${id} topic`,
        "Existing why",
        "low",
        status,
        cadence,
        "noticed",
        "Only useful news",
        "Known current fact",
        "private:artifact",
        7,
        now - 10 * MINUTE,
        now - MINUTE,
        now - MINUTE,
        now + 360 * MINUTE,
        now - 2 * MINUTE,
        activeLease ? "active-reservation" : null,
        activeLease ? now + 30 * MINUTE : null,
        0,
      );
      db.prepare("INSERT INTO topic_sources VALUES (?, ?)").run(id, "provider");
    }
  } finally {
    db.close();
  }
}

describe("research_topics v2", () => {
  it("isolates bound member ledgers and refuses missing, revoked, or quota-denied access", async () => {
    const root = directory();
    const registered = vi.fn<OpenClawPluginApi["registerTool"]>();
    const services = vi.fn<OpenClawPluginApi["registerService"]>();
    const runtimeSource = fileURLToPath(
      new URL("../../grogu/plugins/research-topics/index.ts", import.meta.url),
    );
    const api = createTestPluginApi({
      id: "research-topics",
      runtimeSource,
      pluginConfig: {
        ledgerMode: "member",
        delivery: { agentId: "grogu", channel: "telegram", target: "telegram:synthetic-owner" },
      },
      registerTool: registered,
      registerService: services,
    });
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
    const delivery = createDelivery(api);
    const cleanup = services.mock.calls[0]?.[0].stop;
    if (!delivery || !cleanup) {
      throw new Error("Expected delivery and plugin cleanup");
    }
    let active = true;
    let quotaAvailable = true;
    const first = new ResearchLedger(path.join(root, "first", "ledger.sqlite"), runtimeSource);
    const second = new ResearchLedger(path.join(root, "second", "ledger.sqlite"), runtimeSource);
    const make = (
      ledger: ResearchLedger,
      selectedDelivery: ResearchMemberBinding["delivery"] = delivery,
    ) =>
      factory.create({
        ...firstSession,
        assertInvocationCurrent: () => {},
        toolBindings: {
          research_topics: {
            ledger,
            delivery: selectedDelivery,
            assertCurrent: () => {
              if (!active) {
                throw new Error("Member revoked");
              }
            },
            withMutationAdmission: async <T>(run: (assertAdmission: () => void) => Promise<T>) =>
              run(() => {
                if (!quotaAvailable) {
                  throw new Error("Member storage full");
                }
              }),
          },
        },
      });
    const one = make(first);
    const two = make(second);
    if (!one || Array.isArray(one) || !two || Array.isArray(two)) {
      throw new Error("Expected member research tools");
    }
    try {
      expect(factory.create({ ...firstSession, assertInvocationCurrent: () => {} })).toBeNull();
      await one.execute("add", { action: "add", id: "private", title: "Private topic" });
      expect((await two.execute("list", { action: "list" })).details).toMatchObject({ topics: [] });
      const inboxTool = make(second, {
        ...delivery,
        authorize: () => {},
        isMain: () => true,
        mainSession: async () => firstSession,
        recoverReceipt: async () => ({
          ...firstSession,
          kind: "owner_inbox",
          messageId: "synthetic-inbox-entry",
          completedAtMs: Date.now(),
        }),
      });
      if (!inboxTool || Array.isArray(inboxTool)) {
        throw new Error("Expected an inbox-bound research tool");
      }
      await inboxTool.execute("add", {
        action: "add",
        id: "inbox-topic",
        title: "Inbox topic",
        completionRule: "Find an answer",
        origin: "automation",
        sessionRefs: [],
      });
      const completion = (
        await inboxTool.execute("complete", {
          action: "complete",
          id: "inbox-topic",
          expectedRevision: 1,
          reason: "Answered",
        })
      ).details;
      const completionId = stringField(completion, "completionId");
      await inboxTool.execute("prepare", {
        action: "prepare_text",
        id: "inbox-topic",
        expectedRevision: 2,
        completionId,
        ownerText: "Answered",
      });
      const confirmed = (
        await inboxTool.execute("confirm", {
          action: "confirm_completion",
          id: "inbox-topic",
          expectedRevision: 3,
          completionId,
        })
      ).details;
      expect(confirmed).toMatchObject({
        destinations: [{ receipt: { kind: "owner_inbox", messageId: "synthetic-inbox-entry" } }],
      });
      await inboxTool.execute("finalize", {
        action: "finalize",
        id: "inbox-topic",
        expectedRevision: 3,
        completionId,
      });
      quotaAvailable = false;
      await expect(
        one.execute("denied", { action: "add", id: "extra", title: "Over quota" }),
      ).rejects.toThrow("Member storage full");
      active = false;
      await expect(one.execute("revoked", { action: "list" })).rejects.toThrow("Member revoked");
      await first.close();
      active = true;
      await expect(one.execute("closed", { action: "list" })).rejects.toThrow("ledger stopped");
    } finally {
      await first.close();
      await second.close();
      await cleanup({
        config: {},
        stateDir: root,
        logger: api.logger,
        scheduler: createTestPluginServiceScheduler(),
      });
    }
  });

  it("uses the registered tool, binds links to its caller, shares provider budgets, and rejects revoked callers", async () => {
    const root = directory();
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
    expect(
      factory.create({
        ...firstSession,
        sessionKey: "agent:grogu:dashboard:incognito-private",
        assertInvocationCurrent: () => {},
      }),
    ).toBeNull();
    const tool = factory.create({
      ...firstSession,
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
      await tool.execute("source", {
        action: "source_set",
        id: "shared",
        minimumIntervalMinutes: 30,
      });
      expect(
        (
          await tool.execute("add", {
            action: "add",
            id: "topic",
            title: "Synthetic topic",
            sourceIds: ["shared"],
          })
        ).details,
      ).toMatchObject({ id: "topic", revision: 1, sessionRefs: [firstSession] });
      await expect(
        tool.execute("forge", {
          action: "update",
          id: "topic",
          expectedRevision: 1,
          changes: { sessionRefs: [secondSession] },
        }),
      ).rejects.toThrow("current caller");
      const link = { action: "link_session", id: "topic" };
      const second = factory.create({ ...secondSession, assertInvocationCurrent: () => {} });
      const scheduled = factory.create({
        sessionKey: "agent:grogu:cron:job-1:run:run-1",
        sessionId: "scheduled-incarnation",
        assertInvocationCurrent: () => {},
      });
      if (!second || Array.isArray(second) || !scheduled || Array.isArray(scheduled)) {
        throw new Error("Expected conversation and scheduled research tools");
      }
      // A conversation cannot name its own incarnation, so the host-supplied caller is the only link it can make.
      for (const callId of ["link", "relink"]) {
        expect((await second.execute(callId, link)).details).toMatchObject({
          revision: 1,
          sessionRefs: [firstSession, secondSession],
        });
      }
      await expect(scheduled.execute("scheduled", link)).rejects.toThrow("cannot link");
      const attempts = await Promise.all([
        tool.execute("first", { action: "source_attempt", id: "shared" }),
        tool.execute("second", { action: "source_attempt", id: "shared" }),
      ]);
      expect(attempts.map((result) => result.details)).toEqual([
        expect.objectContaining({ allowed: true }),
        expect.objectContaining({ allowed: false, reason: "source-cooldown" }),
      ]);
      await tool.execute("settle", {
        action: "source_result",
        id: "shared",
        attemptId: stringField(attempts[0]?.details, "attemptId"),
        outcome: "skipped",
      });
      await tool.execute("check", {
        action: "record_check",
        id: "topic",
        expectedRevision: 1,
        operationId: "unit-1",
      });
      active = false;
      await expect(
        tool.execute("forget", {
          action: "forget",
          id: "topic",
          expectedRevision: 1,
        }),
      ).rejects.toThrow("Caller revoked");
      active = true;
      expect((await tool.execute("get", { action: "get", id: "topic" })).details).toMatchObject({
        revision: 1,
        serviceCount: 1,
      });
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

  it("rolls back a caller revoked while waiting on SQLite's writer lock", async () => {
    const databasePath = path.join(directory(), "ledger.sqlite");
    const store = await openSqliteWorkerStore<LedgerOperations>({
      databasePath,
      moduleUrl: workerModule,
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
              request: parseRequest({ action: "add", id: "revoked", title: "Revoked" }),
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
          input: { request: parseRequest({ action: "get", id: "revoked" }), now: START },
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

  it("keeps action-specific arguments in the provider schema instead of inviting padded calls", () => {
    const [tool] = convertResponsesToolPayload(
      [{ name: "research_topics", description: "Research topics", parameters: toolSchema }],
      { strict: false },
    );
    if (!tool?.parameters) {
      throw new Error("Missing emitted Research Topics schema");
    }
    for (const request of [
      { action: "lookup", query: "train fares", limit: 8 },
      { action: "add", id: "train-fares", title: "Train fares" },
      { action: "update", id: "train-fares", expectedRevision: 1, changes: { priority: "high" } },
    ]) {
      expect(Check(tool.parameters, request)).toBe(true);
      expect(parseRequest(request)).toEqual(request);
    }
    for (const request of [
      {
        action: "lookup",
        query: "train fares",
        id: "noop",
        sessionId: "current",
        reason: "unused",
      },
      { action: "lookup", id: "train-fares" },
      { action: "update", id: "train-fares", expectedRevision: 1, priority: "high" },
    ]) {
      expect(Check(tool.parameters, request)).toBe(false);
      expect(() => parseRequest(request)).toThrow();
    }
  });

  it("tells a rejected caller which fields to repair instead of one generic refusal", () => {
    expect(() => parseRequest({ action: "add", title: "Socks", category: "shopping" })).toThrow(
      /^Invalid research_topics add arguments\. Missing: id\. Unknown: category \(.*label a topic with tags\)\. Allowed: id, title, .*\btags\b/,
    );
    expect(() => parseRequest({ action: "forget", id: "socks", reason: "bought" })).toThrow(
      new Error(
        "Invalid research_topics forget arguments. Missing: expectedRevision. Unknown: reason. Allowed: id, expectedRevision.",
      ),
    );
    expect(() =>
      parseRequest({
        action: "update",
        id: "socks",
        expectedRevision: 1,
        changes: { category: "shopping", priority: "urgent" },
      }),
    ).toThrow(
      /Unknown: changes\.category .*Allowed in changes: title, .*\btags\b.*Invalid: changes\.priority must be one of "high", "normal", "low"\./,
    );
    expect(() => parseRequest({ action: "lookup", query: "socks", limit: 21 })).toThrow(
      new Error("Invalid research_topics lookup arguments. Invalid: limit must be <= 20."),
    );
    expect(() =>
      parseRequest({ action: "source_attempt", id: "socks", sourceId: "web-search.duckduckgo" }),
    ).toThrow(
      new Error(
        "Invalid research_topics source_attempt arguments. Unknown: sourceId. Allowed: id.",
      ),
    );
    expect(() => parseRequest({ id: "socks" })).toThrow(
      /^Invalid research_topics arguments: action must be one of list, get, lookup, add,/,
    );
  });

  it("lets oversized notes pass core validation so the plugin names the repair", () => {
    const tool = {
      name: "research_topics",
      description: "Research topics",
      parameters: toolSchema,
    };
    const notes = "Quiet inbox pass. ".repeat(126).slice(0, 2_263);
    const changesCases = [
      { notes, workState: "ready" },
      JSON.stringify({ notes, workState: "ready" }),
    ];
    for (const changes of changesCases) {
      const args = validateToolArguments(tool, {
        type: "toolCall",
        id: "call",
        name: "research_topics",
        arguments: { action: "update", id: "inbox", expectedRevision: 3, changes },
      });
      expect(() => parseRequest(args)).toThrow(
        new Error(
          "Invalid research_topics update arguments. changes.notes is 2,263 characters; limit 2,000. " +
            "notes is a short summary that replaces the old one; move details and history to brief.",
        ),
      );
    }
    const atLimit = "🎿".repeat(2_000);
    expect(parseRequest({ action: "add", id: "ski", title: "Ski", notes: atLimit })).toMatchObject({
      notes: atLimit,
    });
    expect(() =>
      parseRequest({ action: "add", id: "ski", title: "Ski", notes: `${atLimit}!` }),
    ).toThrow("add arguments. notes is 2,001 characters; limit 2,000.");
  });

  it("reports every wrong field when a flattened call has more mistakes than the validator reports", () => {
    const flattened = {
      title: "Socks",
      brief: "Merino, size 10",
      why: "Hiking",
      notes: "Wool only",
      priority: "high",
      purpose: "answer",
      origin: "owner",
      tags: ["shopping"],
    };
    const unknownFields = "title, brief, why, notes, priority, purpose, origin, tags";
    const cases: [unknown, string][] = [
      [
        { action: "update", id: "socks", ...flattened },
        `Invalid research_topics update arguments. Missing: expectedRevision, changes. Unknown: ${unknownFields}. Allowed: id, expectedRevision, changes.`,
      ],
      [
        {
          action: "update",
          id: "socks",
          expectedRevision: 1,
          changes: { title: "Socks" },
          ...flattened,
        },
        `Invalid research_topics update arguments. Unknown: ${unknownFields}. Allowed: id, expectedRevision, changes.`,
      ],
      [
        { action: "forget", id: "socks", expectedRevision: 1, ...flattened, reason: "bought" },
        `Invalid research_topics forget arguments. Unknown: ${unknownFields}, and 1 more. Allowed: id, expectedRevision.`,
      ],
    ];
    for (const [request, message] of cases) {
      expect(() => parseRequest(request)).toThrow(new Error(message));
    }
    expect(() =>
      parseRequest({
        action: "add",
        id: "socks",
        title: "Socks",
        priority: "urgent",
        origin: "me",
        category: "shopping",
        ...Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((key) => [`extra${key}`, 1])),
      }),
    ).toThrow(
      /Unknown: category \(.*\), extraa, extrab, extrac, extrad, extrae, extraf\. Allowed: id, title, .*\btags\b.*\. Invalid: priority must be one of "high", "normal", "low"; origin must be one of "owner", "noticed", "automation"\.$/,
    );
  });

  it("persists full briefs and indexed bounded lookup without exposing briefs or accepting FTS syntax", async () => {
    const ledger = await open();
    await ledger.run({
      action: "add",
      id: "rail",
      title: "Intercity travel",
      brief: "Private working brief ".repeat(1_000),
      aliases: ["train journey", "rail fares"],
      tags: ["travel"],
      why: "Compare tickets",
      notes: "Known constraints",
      origin: "noticed",
    });
    const other = await open(ledger.databasePath);
    expect(await other.run({ action: "get", id: "rail" })).toMatchObject({
      brief: "Private working brief ".repeat(1_000),
      workState: "ready",
      nextDueAtMs: null,
      purpose: "decision",
      completionRule: null,
      sessionRefs: [firstSession],
    });
    expect(
      await other.run({
        action: "lookup",
        query: "train journey",
        category: "travel",
        sessionKey: firstSession.sessionKey,
      }),
    ).toMatchObject({ topics: [{ id: "rail", why: "Compare tickets" }] });
    const candidates = await other.run({ action: "lookup", query: "rail" });
    expect(candidates).toMatchObject({ topics: [{ id: "rail" }], match: "id" });
    expect(JSON.stringify(candidates)).not.toContain("Private working brief");
    expect(
      await other.run({ action: "lookup", query: "train", sessionKey: secondSession.sessionKey }),
    ).toMatchObject({ topics: [] });
    expect(await other.run({ action: "lookup", query: '" OR NOT * : ()' })).toMatchObject({
      topics: [],
    });
    await expect(other.run({ action: "lookup", query: "train", limit: 21 })).rejects.toThrow(
      "Invalid research_topics",
    );
    await expect(other.run({ action: "add", id: "rail", title: "Overwrite" })).rejects.toThrow(
      "already exists",
    );
    expect(statSync(ledger.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(ledger.databasePath)).mode & 0o777).toBe(0o700);
  });

  it("keeps content revisions independent of service facts while refusing stale edits and replaying one unit once", async () => {
    const ledger = await open();
    await ledger.run({ action: "add", id: "topic", title: "Topic" });
    const check = {
      action: "record_check",
      id: "topic",
      expectedRevision: 1,
      operationId: "one-unit",
    };
    await ledger.run(check);
    ledger.at(START + MINUTE);
    expect(await ledger.run(check)).toMatchObject({
      revision: 1,
      serviceCount: 1,
      lastCheckedAtMs: START,
      replayed: true,
    });
    await ledger.run({
      action: "update",
      id: "topic",
      expectedRevision: 1,
      changes: { brief: "Owner correction", priority: "high" },
    });
    await expect(
      ledger.run({
        action: "record_check",
        id: "topic",
        expectedRevision: 1,
        operationId: "stale-unit",
      }),
    ).rejects.toThrow("revision changed");
    await expect(
      ledger.run({
        action: "update",
        id: "topic",
        expectedRevision: 1,
        changes: { brief: "Lost edit" },
      }),
    ).rejects.toThrow("revision changed");
    await expect(
      ledger.run({
        action: "record_check",
        id: "topic",
        expectedRevision: 2,
        operationId: "one-unit",
      }),
    ).rejects.toThrow("different check facts");
    expect(await ledger.run({ action: "get", id: "topic" })).toMatchObject({
      brief: "Owner correction",
      serviceCount: 1,
      revision: 2,
    });
    await ledger.run({ action: "forget", id: "topic", expectedRevision: 2 });
    await expect(ledger.run({ action: "get", id: "topic" })).rejects.toThrow(
      "Unknown research topic",
    );
    expect(await ledger.run({ action: "lookup", query: "Topic" })).toMatchObject({ topics: [] });
  });

  it("atomically merges reconciled content and all links, detects both revisions, and retains no source alias record", async () => {
    const ledger = await open();
    await ledger.run({ action: "source_set", id: "rail-provider", minimumIntervalMinutes: 30 });
    await ledger.run({ action: "source_set", id: "weather-provider", minimumIntervalMinutes: 60 });
    await ledger.run({
      action: "add",
      id: "trip",
      title: "Trip",
      aliases: ["vacation"],
      tags: ["travel"],
      sourceIds: ["rail-provider"],
      sessionRefs: [{ ...firstSession, messageId: "question" }],
    });
    const peer = await open(ledger.databasePath, secondSession);
    await peer.run({
      action: "add",
      id: "transport",
      title: "Train",
      aliases: ["rail fares"],
      tags: ["travel", "budget"],
      sourceIds: ["weather-provider"],
    });
    await peer.run({
      action: "update",
      id: "transport",
      expectedRevision: 1,
      changes: { notes: "New evidence" },
    });
    const merge = {
      action: "merge",
      id: "trip",
      expectedRevision: 1,
      sourceId: "transport",
      sourceRevision: 1,
      changes: { title: "Trip plan", brief: "Reconciled evidence", tags: ["planning"] },
    };
    await expect(ledger.run(merge)).rejects.toThrow("revision changed");
    expect(await ledger.run({ action: "get", id: "trip" })).toMatchObject({
      title: "Trip",
      revision: 1,
    });
    const merged = await ledger.run({ ...merge, sourceRevision: 2 });
    expect(merged).toMatchObject({
      title: "Trip plan",
      brief: "Reconciled evidence",
      revision: 2,
      aliases: ["rail fares", "vacation"],
      tags: ["budget", "planning", "travel"],
      sourceIds: ["rail-provider", "weather-provider"],
      mergedId: "transport",
      affectedSessionRefs: [{ ...firstSession, messageId: "question" }, secondSession],
    });
    await expect(peer.run({ action: "get", id: "transport" })).rejects.toThrow(
      "Unknown research topic",
    );
    await expect(
      peer.run({
        action: "update",
        id: "transport",
        expectedRevision: 2,
        changes: { notes: "Late write" },
      }),
    ).rejects.toThrow("Unknown research topic");
    expect(await ledger.run({ action: "lookup", query: "rail fares" })).toMatchObject({
      topics: [{ id: "trip" }],
    });
    expect(await ledger.run({ action: "lookup", query: "transport" })).toMatchObject({
      topics: [],
    });
    await ledger.run({
      action: "update",
      id: "trip",
      expectedRevision: 2,
      changes: { sessionRefs: [] },
    });
    expect(await ledger.run({ action: "get", id: "trip" })).toMatchObject({
      sessionRefs: [{ ...firstSession, messageId: "question" }, secondSession],
    });
  });

  it("serves recurring high, high, normal, and low topics in two complete rounds before repeats", async () => {
    const ledger = await open();
    for (const [id, priority] of [
      ["high-a", "high"],
      ["high-b", "high"],
      ["normal", "normal"],
      ["low", "low"],
    ]) {
      await ledger.run({
        action: "add",
        id,
        title: id,
        priority,
        tags: ["science"],
        workState: "waiting",
      });
    }
    for (const id of ["high-a", "high-b", "normal", "low"]) {
      await ledger.run({
        action: "update",
        id,
        expectedRevision: 1,
        changes: { workState: "ready" },
      });
    }
    let unit = 0;
    for (let round = 0; round < 2; round++) {
      for (const id of ["high-a", "high-b", "normal", "low"]) {
        ledger.at(START + unit++);
        expect(await ledger.run({ action: "due", limit: 1, category: "science" })).toMatchObject({
          topics: [{ id, score: { round }, serviceCount: round }],
        });
        await ledger.run({
          action: "record_check",
          id,
          expectedRevision: 2,
          operationId: `round-${round}-${id}`,
        });
      }
    }
    ledger.at(START + unit);
    expect(await ledger.run({ action: "add", id: "new", title: "New" })).toMatchObject({
      serviceCount: 3,
      nextDueAtMs: null,
      workState: "ready",
    });
    expect(await ledger.run({ action: "due", category: "unrelated" })).toEqual({ topics: [] });
  });

  it("serves a waiting low topic despite a new high-priority arrival before every completed unit", async () => {
    const ledger = await open();
    await ledger.run({
      action: "add",
      id: "high-existing",
      title: "Existing research",
      priority: "high",
    });
    await ledger.run({ action: "add", id: "low", title: "Waiting research", priority: "low" });
    const served: string[] = [];
    for (let unit = 0; unit < 4; unit++) {
      ledger.at(START + unit + 1);
      await ledger.run({
        action: "add",
        id: `arrival-${unit}`,
        title: `New research ${unit}`,
        priority: "high",
      });
      const due = await ledger.run({ action: "due", limit: 1 });
      if (!due || typeof due !== "object" || !("topics" in due) || !Array.isArray(due.topics)) {
        throw new Error("Expected a due-topic selection");
      }
      const id = stringField(due.topics[0], "id");
      served.push(id);
      await ledger.run({
        action: "record_check",
        id,
        expectedRevision: 1,
        operationId: `churn-${unit}`,
      });
    }
    expect(served).toContain("low");
    expect(await ledger.run({ action: "get", id: "low" })).toMatchObject({
      serviceCount: 2,
      lastCheckedAtMs: START + 4,
    });
  });

  it("requires explicit monitoring reasons and times, with no general research timer or partial invalid writes", async () => {
    const ledger = await open();
    for (const request of [
      { action: "add", id: "bad", title: "Bad", workState: "monitoring" },
      { action: "add", id: "bad", title: "Bad", nextDueAtMs: START + MINUTE },
      { action: "add", id: "bad", title: "Bad", sourceIds: ["unknown"] },
      { action: "add", id: "bad", title: "Bad", brief: "🦞".repeat(17_000) },
      { action: "add", id: "bad", title: "Bad", sessionRefs: [secondSession] },
    ]) {
      await expect(ledger.run(request)).rejects.toThrow();
    }
    expect(await ledger.run({ action: "list" })).toMatchObject({ topics: [] });
    await ledger.run({
      action: "add",
      id: "watch",
      title: "Release watch",
      purpose: "watch",
      workState: "monitoring",
      monitoringReason: "Wait for publication",
      nextDueAtMs: START + MINUTE,
    });
    expect(await ledger.run({ action: "due" })).toEqual({ topics: [] });
    ledger.at(START + MINUTE);
    expect(await ledger.run({ action: "due" })).toMatchObject({ topics: [{ id: "watch" }] });
    await ledger.run({
      action: "record_check",
      id: "watch",
      expectedRevision: 1,
      operationId: "publication",
    });
    expect(await ledger.run({ action: "get", id: "watch" })).toMatchObject({
      workState: "ready",
      nextDueAtMs: null,
      monitoringReason: "",
      serviceCount: 1,
    });
    await ledger.run({
      action: "update",
      id: "watch",
      expectedRevision: 1,
      changes: { workState: "waiting" },
    });
    expect(await ledger.run({ action: "due" })).toEqual({ topics: [] });
    await expect(ledger.run({ action: "acquire", id: "watch" })).rejects.toThrow(
      "Invalid research_topics",
    );
  });

  it("tells the caller to set workState monitoring when a due time arrives without it", async () => {
    const ledger = await open();
    await ledger.run({ action: "add", id: "topic", title: "Topic" });
    const recheck = {
      action: "record_check",
      id: "topic",
      expectedRevision: 1,
      monitoringReason: "Recheck the listing",
      nextDueAtMs: START + MINUTE,
    } as const;
    await expect(ledger.run({ ...recheck, operationId: "without-state" })).rejects.toThrow(
      /workState "monitoring"/,
    );
    await ledger.run({ ...recheck, operationId: "with-state", workState: "monitoring" });
    expect(await ledger.run({ action: "get", id: "topic" })).toMatchObject({
      workState: "monitoring",
      nextDueAtMs: START + MINUTE,
      serviceCount: 1,
    });
  });

  it("retains pending completion obligations and freezes edits rather than trusting arbitrary delivery claims", async () => {
    const ledger = await open();
    await ledger.run({
      action: "add",
      id: "topic",
      title: "Question",
      purpose: "answer",
      completionRule: "The question has a supported answer",
    });
    await ledger.run({ action: "add", id: "other", title: "Other" });
    const pending = await ledger.run({
      action: "complete",
      id: "topic",
      expectedRevision: 1,
      reason: "The question is answered",
    });
    const completionId = stringField(pending, "completionId");
    expect(pending).toMatchObject({
      status: "completion_pending",
      revision: 2,
      ownerText: null,
      destinations: [
        { destinationId: "main", kind: "main", ...mainSession, receipt: null },
        { kind: "session", ...firstSession, receipt: null },
      ],
    });
    expect(await ledger.run({ action: "due" })).toMatchObject({ topics: [{ id: "other" }] });
    for (const request of [
      {
        action: "update",
        id: "topic",
        expectedRevision: 2,
        changes: { brief: "Changed after notice" },
      },
      { action: "record_check", id: "topic", expectedRevision: 2, operationId: "too-late" },
      {
        action: "merge",
        id: "other",
        expectedRevision: 1,
        sourceId: "topic",
        sourceRevision: 2,
        changes: { title: "Merged", brief: "Changed after notice" },
      },
    ]) {
      await expect(ledger.run(request)).rejects.toThrow("completion is pending");
    }
    await expect(
      ledger.run({
        action: "confirm_completion",
        id: "topic",
        expectedRevision: 2,
        completionId,
        toolCallId: "unverified",
      }),
    ).rejects.toThrow("native receipt");
    await expect(
      ledger.run({
        action: "finalize",
        id: "topic",
        expectedRevision: 2,
        completionId,
      }),
    ).rejects.toThrow("unconfirmed");
    expect(await ledger.run({ action: "get", id: "topic" })).toEqual(pending);
    await ledger.run({ action: "forget", id: "topic", expectedRevision: 2 });
    await expect(ledger.run({ action: "get", id: "topic" })).rejects.toThrow(
      "Unknown research topic",
    );
  });

  it("reopens for an owner correction without losing research history or accepting stale completion", async () => {
    const ledger = await open();
    await ledger.run({
      action: "add",
      id: "topic",
      title: "Question",
      brief: "Current evidence",
      aliases: ["Research question"],
      tags: ["science"],
      completionRule: "Independent evidence answers it",
    });
    await ledger.run({
      action: "record_check",
      id: "topic",
      expectedRevision: 1,
      operationId: "completed-unit",
      workState: "monitoring",
      monitoringReason: "Await independent evidence",
      nextDueAtMs: START + MINUTE,
    });
    const pending = await ledger.run({
      action: "complete",
      id: "topic",
      expectedRevision: 1,
      reason: "The answer is established",
    });
    const completionId = stringField(pending, "completionId");
    await expect(
      ledger.run({ action: "reopen", id: "topic", expectedRevision: 1 }),
    ).rejects.toThrow("revision changed");
    expect(await ledger.run({ action: "get", id: "topic" })).toEqual(pending);
    ledger.at(START + 1);
    expect(await ledger.run({ action: "reopen", id: "topic", expectedRevision: 2 })).toMatchObject({
      status: "active",
      workState: "ready",
      revision: 3,
      brief: "Current evidence",
      aliases: ["Research question"],
      tags: ["science"],
      sessionRefs: [firstSession],
      serviceCount: 1,
      lastCheckedAtMs: START,
      monitoringReason: "",
      nextDueAtMs: null,
      completionId: null,
      completionReason: null,
      ownerText: null,
      completedAtMs: null,
      destinations: [],
    });
    expect(await ledger.run({ action: "due" })).toMatchObject({ topics: [{ id: "topic" }] });
    await ledger.run({
      action: "update",
      id: "topic",
      expectedRevision: 3,
      changes: { brief: "Corrected evidence" },
    });
    await expect(
      ledger.run({
        action: "finalize",
        id: "topic",
        expectedRevision: 2,
        completionId,
      }),
    ).rejects.toThrow("revision changed");
    await expect(
      ledger.run({
        action: "finalize",
        id: "topic",
        expectedRevision: 4,
        completionId,
      }),
    ).rejects.toThrow("completion identity changed");
    expect(await ledger.run({ action: "get", id: "topic" })).toMatchObject({
      brief: "Corrected evidence",
      revision: 4,
      serviceCount: 1,
      destinations: [],
    });
  });

  it("preserves shared source intervals, successful-fetch time, Retry-After and stale-result fencing independently of topics", async () => {
    const ledger = await open();
    await ledger.run({ action: "source_set", id: "provider", minimumIntervalMinutes: 30 });
    for (const id of ["first", "second"]) {
      await ledger.run({ action: "add", id, title: id, sourceIds: ["provider"] });
    }
    const attempt = await ledger.run({ action: "source_attempt", id: "provider" });
    expect(await ledger.run({ action: "due" })).toEqual({ topics: [] });
    ledger.at(START + MINUTE);
    const ok = {
      action: "source_result",
      id: "provider",
      attemptId: stringField(attempt, "attemptId"),
      outcome: "ok",
    };
    await ledger.run(ok);
    ledger.at(START + 30 * MINUTE);
    expect(await ledger.run({ action: "source_attempt", id: "provider" })).toMatchObject({
      allowed: false,
      nextAllowedAtMs: START + 31 * MINUTE,
    });
    expect(await ledger.run(ok)).toMatchObject({ lastFetchedAtMs: START + MINUTE, replayed: true });
    ledger.at(START + 31 * MINUTE);
    const throttle = await ledger.run({ action: "source_attempt", id: "provider" });
    await expect(ledger.run(ok)).rejects.toThrow("attempt changed");
    await ledger.run({
      action: "source_result",
      id: "provider",
      attemptId: stringField(throttle, "attemptId"),
      outcome: "throttled",
      retryAfterMinutes: 120,
    });
    expect(await ledger.run({ action: "source_list" })).toMatchObject({
      sources: [
        {
          lastFetchedAtMs: START + MINUTE,
          lastStatus: "throttled",
          backoffUntilMs: START + 151 * MINUTE,
        },
      ],
    });
    await ledger.run({
      action: "record_check",
      id: "first",
      expectedRevision: 1,
      operationId: "saved-info",
    });
    ledger.at(START + 151 * MINUTE);
    expect(await ledger.run({ action: "due" })).toMatchObject({
      topics: [{ id: "second" }, { id: "first" }],
    });
    const failure = await ledger.run({ action: "source_attempt", id: "provider" });
    await ledger.run({
      action: "source_result",
      id: "provider",
      attemptId: stringField(failure, "attemptId"),
      outcome: "error",
    });
    expect(await ledger.run({ action: "source_list" })).toMatchObject({
      sources: [
        {
          lastStatus: "error",
          lastFetchedAtMs: START + MINUTE,
          backoffUntilMs: START + 181 * MINUTE,
        },
      ],
    });
    await expect(
      ledger.run({ action: "source_set", id: "provider", minimumIntervalMinutes: 1 }),
    ).rejects.toThrow("revision changed");
    expect(await ledger.run({ action: "get", id: "first" })).toMatchObject({
      revision: 1,
      serviceCount: 1,
    });
  });

  it("migrates v1 current facts and conservative provider cooldowns without inferring watches or retaining archives", async () => {
    const root = directory();
    const databasePath = path.join(root, "ledger.sqlite");
    const now = Date.now();
    createV1(databasePath, now);
    const ledger = await open(databasePath);
    ledger.at(now);
    expect(await ledger.run({ action: "get", id: "active" })).toMatchObject({
      priority: "low",
      purpose: "decision",
      workState: "ready",
      completionRule: null,
      nextDueAtMs: null,
      origin: "noticed",
      notes: "Known current fact",
      findingsRef: "private:artifact",
      lastCheckedAtMs: now - MINUTE,
      lastNotifiedAtMs: now - 2 * MINUTE,
      revision: 8,
      brief: expect.stringContaining("cadenceMinutes=360"),
      sources: [
        {
          minimumIntervalMinutes: 30,
          lastAttemptedAtMs: now,
          lastFetchedAtMs: now - MINUTE,
          backoffUntilMs: now + 60 * MINUTE,
          lastStatus: "throttled",
        },
      ],
    });
    expect(await ledger.run({ action: "get", id: "paused" })).toMatchObject({
      workState: "waiting",
    });
    for (const id of ["done", "archive"]) {
      await expect(ledger.run({ action: "get", id })).rejects.toThrow("Unknown research topic");
    }
    expect(await ledger.run({ action: "source_attempt", id: "provider" })).toMatchObject({
      allowed: false,
      nextAllowedAtMs: now + 60 * MINUTE,
    });
    ledger.at(now + 60 * MINUTE);
    expect(await ledger.run({ action: "due" })).toMatchObject({ topics: [{ id: "active" }] });
    expect(await ledger.run({ action: "lookup", query: "Known current fact" })).toMatchObject({
      topics: [{ id: "active" }, { id: "paused" }],
    });
    expect(
      readdirSync(root).every((name) =>
        ["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm"].includes(name),
      ),
    ).toBe(true);
  });

  it("refuses v1 live work and newer schemas without committing a migration", async () => {
    const databasePath = path.join(directory(), "ledger.sqlite");
    createV1(databasePath, Date.now(), true);
    await expect(open(databasePath)).rejects.toThrow("live topic lease");
    const db = new DatabaseSync(databasePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM topics").get()?.count).toBe(4);
      db.exec("PRAGMA user_version=3");
    } finally {
      db.close();
    }
    await expect(open(databasePath)).rejects.toThrow("newer than this plugin");
  });
});
