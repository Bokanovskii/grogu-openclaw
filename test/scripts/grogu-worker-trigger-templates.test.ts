import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderWorkerTriggerScript,
  workerTriggerScriptSha256,
  workerTriggerTemplateSchema,
  type WorkerTriggerTemplate,
} from "../../grogu/worker-trigger-templates.js";
import {
  consumeMcpCodeModeGuestResult,
  projectMcpCallToolResult,
} from "../../src/agents/mcp-content.js";

const schemaSha256 = "16f483176747c72d4e27fe9c8cd4c645c48d4f6aa6aadaded3bdbe2ca89495b1";
const approvedTools = [
  "gmail__gmail_search",
  "seaglass__recent_messages",
  "icloud_calendar_events",
  "sessions_search",
];
const continuation = {
  delayMs: 60_000,
  intervalMs: 60_000,
  nativeSweepIntervalMs: 300_000,
  maxOpen: 8,
  maxFires: 2,
  ttlMs: 24 * 60 * 60_000,
};

function messagesTemplate(limit = 50): WorkerTriggerTemplate {
  return workerTriggerTemplateSchema.parse({
    version: 1,
    templateId: "messages-metadata-v1",
    schemaSha256,
    toolsAllow: approvedTools,
    args: { since_ts: 100, limit, offset: 0, include_text: false },
    maxItems: limit,
    continuation,
  });
}

function gmailTemplate(max = 1): WorkerTriggerTemplate {
  return workerTriggerTemplateSchema.parse({
    version: 1,
    templateId: "gmail-metadata-v1",
    schemaSha256,
    toolsAllow: approvedTools,
    args: {
      query: "newer_than:1d",
      max,
      include_body: false,
      sanitize_content: true,
    },
    maxItems: max,
    continuation,
  });
}

type TriggerRun = (mcp: unknown, trigger: unknown) => Promise<Record<string, unknown>>;

function compile(template: WorkerTriggerTemplate): TriggerRun {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => TriggerRun;
  return new AsyncFunction("MCP", "trigger", renderWorkerTriggerScript(template));
}

type MessagesOptions = {
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  limit?: number;
  sinceTs?: number;
  beforeTs?: number;
};

function messagesResult(messages: unknown[], options: MessagesOptions = {}) {
  const offset = options.offset ?? 0;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          source: "messages",
          observed_at_ts: 300,
          newest_source_ts: messages.length > 0 ? 200 : null,
          since_ts: options.sinceTs ?? 100,
          before_ts: options.beforeTs ?? 200,
          limit: options.limit ?? 50,
          offset,
          has_more: options.hasMore ?? false,
          next_offset: options.nextOffset ?? offset + messages.length,
          messages,
        }),
      },
    ],
    isError: false,
  };
}

function messagesMcp(messages: unknown[], options: MessagesOptions = {}) {
  return {
    seaglass: {
      recentMessages: async () => messagesResult(messages, options),
    },
  };
}

function gmailResult(stdout: Record<string, unknown> | string) {
  return {
    isError: false,
    structuredContent: {
      tool: "gmail_search",
      risk: "read",
      exit_code: 0,
      stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    },
  };
}

type GmailOptions = { hasMore?: boolean; nextPageToken?: string };

// gog's failing envelope: the structured error has a numeric `code` and no `kind`.
const gmailFailureText = {
  stderr: "synthetic stderr detail",
  message: "synthetic message detail",
  class: "synthetic class detail",
};

function gmailFailure(
  exitCode: unknown,
  options: { isError?: boolean; stdoutAsText?: boolean } = {},
) {
  const stdout = {
    error: { class: gmailFailureText.class, code: 7, message: gmailFailureText.message },
  };
  return {
    isError: options.isError ?? true,
    content: [{ type: "text", text: "synthetic failure text" }],
    structuredContent: {
      tool: "gmail_search",
      service: "gmail",
      risk: "read",
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      stdout: options.stdoutAsText ? JSON.stringify(stdout) : stdout,
      stderr: gmailFailureText.stderr,
    },
  };
}

function gmailMcp(messages: unknown[], options: GmailOptions = {}) {
  return {
    gmail: {
      gmailSearch: async () =>
        gmailResult({
          count: messages.length,
          externalContent: true,
          has_more: options.hasMore ?? false,
          messages,
          nextPageToken: options.nextPageToken ?? "",
        }),
    },
  };
}

type Source = "gmail" | "messages";
type Entry = readonly [n: number, t: number];

type HeadFixture = {
  template: () => WorkerTriggerTemplate;
  coverageKind: string;
  // Synthetic connector row, decoded item (also the legacy v1 item) and identity key for item `n` at time `t`.
  row: (n: number, t: number) => Record<string, unknown>;
  item: (n: number, t: number) => Record<string, unknown>;
  key: (n: number) => string;
  // A row whose timestamp cannot be read as a number (Messages) or parsed as a date (Gmail).
  unreadable: (n: number) => Record<string, unknown>;
  // Timestamp stored as the floor when `t` is the oldest time in a truncated head (seconds or ms).
  at: (t: number) => number;
  mcp: (rows: unknown[], hasMore: boolean) => unknown;
};

// Synthetic pages with the live shapes: float Messages timestamps and 16-hex Gmail ids.
const liveWindow = { sinceTs: 1_730_000_000.123456, beforeTs: 1_730_086_400.654321, limit: 100 };
const messagesEpoch = 1_730_000_000.25;
const gmailEpoch = Date.UTC(2026, 10, 4);
const gmailId = (n: number) => (0x18f000000000 + n).toString(16).padStart(16, "0");
const gmailIso = (t: number) => new Date(gmailEpoch + t * 1000).toISOString();
const messagesRow = (n: number, t: number) => ({
  message_id: 5_000_000 + n,
  chat_id: 100 + (n % 9),
  ts: messagesEpoch + t,
  is_from_me: n % 4 === 0,
  sender: null,
  has_attachment: false,
});
const gmailRow = (n: number, t: number) => ({
  id: gmailId(n),
  threadId: gmailId(n),
  internalDateIso: gmailIso(t),
});

const heads: Record<Source, HeadFixture> = {
  messages: {
    template: () => messagesTemplate(100),
    coverageKind: "bounded_recent_window",
    row: messagesRow,
    item: (n, t) => ({
      id: 5_000_000 + n,
      conversationId: 100 + (n % 9),
      timestamp: messagesEpoch + t,
    }),
    key: (n) => `${100 + (n % 9)}:${5_000_000 + n}`,
    unreadable: (n) => ({ ...messagesRow(n, 0), ts: "unreadable" }),
    at: (t) => messagesEpoch + t,
    mcp: (rows, hasMore) => messagesMcp(rows, { ...liveWindow, hasMore }),
  },
  gmail: {
    template: () => gmailTemplate(100),
    coverageKind: "bounded_head",
    row: gmailRow,
    item: (n, t) => ({ id: gmailId(n), threadId: gmailId(n), timestamp: gmailIso(t) }),
    key: gmailId,
    unreadable: (n) => ({ ...gmailRow(n, 0), internalDateIso: "unreadable" }),
    at: (t) => gmailEpoch + t * 1000,
    mcp: (rows, hasMore) => gmailMcp(rows, { hasMore }),
  },
};

// Item `n` is at time 1000 - 10n, so a 100-item head has its floor at time 10.
const base: Entry[] = Array.from({ length: 100 }, (_, n): Entry => [n, 1000 - n * 10]);

function driver(source: Source) {
  const head = heads[source];
  const run = compile(head.template());
  const page = (entries: readonly Entry[]) =>
    entries.toSorted((a, b) => b[1] - a[1]).map(([n, t]) => head.row(n, t));
  const observe = (
    entries: readonly Entry[],
    options: { state?: unknown; hasMore?: boolean } = {},
  ) => run(head.mcp(page(entries), options.hasMore ?? true), { state: options.state });
  return { head, run, page, observe };
}

function storedFingerprint(result: Record<string, unknown>, source: Source) {
  const state = result.state as { sources: Record<string, { fingerprint: string } | undefined> };
  return state.sources[source]?.fingerprint ?? "";
}

function storedHead(result: Record<string, unknown>, source: Source) {
  return JSON.parse(storedFingerprint(result, source)) as {
    v: number;
    ids: string[];
    floor: number | null;
  };
}

function deltaItems(result: Record<string, unknown>) {
  return (JSON.parse(String(result.message)) as { items: unknown[] }).items;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("private worker trigger templates", () => {
  it("pins exact source schema, metadata arguments, and toolsAllow", () => {
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        schemaSha256: "not-a-hash",
      }),
    ).toThrow();
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        schemaSha256: "0".repeat(64),
      }),
    ).toThrow(/effective probe/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        toolsAllow: [...approvedTools, "message"],
      }),
    ).toThrow(/toolsAllow/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        toolsAllow: [...approvedTools, "*"],
      }),
    ).toThrow(/toolsAllow/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        args: { ...messagesTemplate().args, include_text: true },
      }),
    ).toThrow(/metadata-only/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...gmailTemplate(),
        args: { ...gmailTemplate().args, pageToken: "not-supported" },
      }),
    ).toThrow(/metadata-only/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...gmailTemplate(),
        args: { ...gmailTemplate().args, include_recipients: true },
      }),
    ).toThrow(/metadata-only/);
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        templateId: "calendar-metadata-v1",
      }),
    ).toThrow();
  });

  it("renders portable catalog-normalized callables without Calendar or source data", () => {
    const messages = renderWorkerTriggerScript(messagesTemplate());
    const gmail = renderWorkerTriggerScript(gmailTemplate());
    expect(messages).toContain("MCP.seaglass.recentMessages");
    expect(gmail).toContain("MCP.gmail.gmailSearch");
    expect(messages).not.toContain("__name");
    expect(messages).not.toContain("toString()");
    expect(messages).toContain('"icloud_calendar_events"');
    expect(messages).not.toContain("MCP.icloud");
    expect(messages).not.toContain("private body");
    expect(workerTriggerScriptSha256(messages)).toMatch(/^[a-f0-9]{64}$/);
    expect(messages.length).toBeLessThan(65_536);
  });

  it("deduplicates and sorts fixed metadata while excluding arbitrary fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const run = compile(messagesTemplate());
    const initial = await run(
      messagesMcp([
        { message_id: 2, chat_id: 7, ts: 20, sender: "private", text: "private body" },
        { message_id: 1, chat_id: 7, ts: 10, sender: "private", text: "other body" },
      ]),
      {},
    );
    expect(initial.fire).toBe(false);
    expect(JSON.stringify(initial)).not.toContain("private body");

    vi.setSystemTime(2_000);
    const reordered = await run(
      messagesMcp([
        { message_id: 1, chat_id: 7, ts: 10, sender: "changed sender" },
        { message_id: 2, chat_id: 7, ts: 20 },
        { message_id: 1, chat_id: 7, ts: 10 },
      ]),
      { state: initial.state },
    );
    expect(reordered.fire).toBe(false);
    expect(JSON.stringify(reordered)).not.toContain("changed body");

    const malformed = await run(messagesMcp([{ message_id: null, chat_id: 7, ts: 10 }]), {
      state: reordered.state,
    });
    expect(malformed).toEqual({ error: { kind: "schema" } });
  });

  it("tracks bounded Gmail heads and preserves typed source failures", async () => {
    const run = compile(gmailTemplate());
    const partial = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              externalContent: true,
              has_more: true,
              messages: [
                {
                  id: "m1",
                  threadId: "t1",
                  internalDateIso: "2026-11-04T00:00:00Z",
                  from: "private",
                  subject: "private",
                },
              ],
              nextPageToken: "opaque-next",
            }),
        },
      },
      {},
    );
    expect(partial).toMatchObject({ fire: false });
    expect(JSON.stringify(partial)).not.toContain("opaque-next");

    const repeatedPartial = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              externalContent: true,
              has_more: true,
              messages: [
                {
                  id: "m1",
                  threadId: "t1",
                  internalDateIso: "2026-11-04T00:00:00Z",
                  from: "changed private sender",
                  subject: "changed private subject",
                },
              ],
              nextPageToken: "different-opaque-next",
            }),
        },
      },
      { state: partial.state },
    );
    expect(repeatedPartial).toMatchObject({ fire: false });
    expect(JSON.stringify(repeatedPartial)).not.toContain("different-opaque-next");

    const changedPartial = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              externalContent: true,
              has_more: true,
              messages: [
                {
                  id: "m2",
                  threadId: "t2",
                  date: "2026-11-04T00:01:00Z",
                  from: "private sender",
                  subject: "private subject",
                },
              ],
              nextPageToken: "opaque-next",
            }),
        },
      },
      { state: repeatedPartial.state },
    );
    expect(changedPartial).toMatchObject({ fire: true });
    expect(JSON.parse(String(changedPartial.message))).toMatchObject({
      kind: "source_delta",
      coverage: { kind: "bounded_head", limit: 1, truncated: true, empty: false },
      uncertainty: "older_matches_not_observed",
    });
    expect(JSON.stringify(changedPartial)).not.toContain("opaque-next");

    const quietChangedPartial = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              externalContent: true,
              has_more: true,
              messages: [{ id: "m2", threadId: "t2", date: "2026-11-04T00:01:00Z" }],
              nextPageToken: "rotated-token",
            }),
        },
      },
      { state: changedPartial.state },
    );
    expect(quietChangedPartial).toMatchObject({ fire: false });

    const malformedPage = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              messages: [{ id: "m1", internalDateIso: "2026-11-04T00:00:00Z" }],
            }),
        },
      },
      {},
    );
    expect(malformedPage).toEqual({ error: { kind: "schema" } });

    const completeFullPage = await run(
      {
        gmail: {
          gmailSearch: async () =>
            gmailResult({
              count: 1,
              externalContent: true,
              has_more: false,
              messages: [
                {
                  id: "m3",
                  threadId: "t3",
                  internalDateIso: "2026-11-04T00:02:00Z",
                  from: "private sender",
                  subject: "private subject",
                },
              ],
              nextPageToken: "",
            }),
        },
      },
      { state: quietChangedPartial.state },
    );
    expect(completeFullPage).toMatchObject({ fire: true });
    expect(JSON.parse(String(completeFullPage.message))).toMatchObject({
      kind: "source_delta",
      coverage: { kind: "bounded_head", limit: 1, truncated: false, empty: false },
      items: [{ id: "m3", threadId: "t3", timestamp: "2026-11-04T00:02:00Z" }],
      uncertainty: null,
    });
    expect(JSON.stringify(completeFullPage)).not.toContain("private sender");
    expect(JSON.stringify(completeFullPage)).not.toContain("private subject");

    const authFailure = await run(
      {
        gmail: {
          gmailSearch: async () => {
            throw Object.assign(new Error("authentication failed"), { kind: "auth" });
          },
        },
      },
      {},
    );
    expect(authFailure).toEqual({ error: { kind: "auth" } });

    await expect(
      run(
        {
          gmail: {
            gmailSearch: async () => ({
              isError: true,
              structuredContent: {
                tool: "gmail_search",
                risk: "read",
                exit_code: 1,
                stdout: JSON.stringify({ error: { kind: "permission" } }),
              },
            }),
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "permission" } });

    await expect(
      run(
        {
          gmail: {
            gmailSearch: async () => {
              throw Object.assign(new Error("transport unavailable"), { code: "ETIMEDOUT" });
            },
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "transient" } });

    await expect(
      compile(messagesTemplate())(
        {
          seaglass: {
            recentMessages: async () => {
              throw Object.assign(new Error("stream reset"), {
                code: "tool_error",
                nativeCode: "ECONNRESET",
              });
            },
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "transient" } });

    for (const code of ["invalid_input", "input_contract"]) {
      await expect(
        compile(messagesTemplate())(
          {
            seaglass: {
              recentMessages: async () => {
                throw Object.assign(new Error("trusted permanent failure"), {
                  code,
                  nativeCode: "ECONNRESET",
                });
              },
            },
          },
          {},
        ),
      ).resolves.toEqual({ error: { kind: "schema" } });
    }

    await expect(
      compile(messagesTemplate())(
        {
          seaglass: {
            recentMessages: async () => {
              throw Object.assign(new Error("generic internal transport failure"), {
                code: "internal_error",
                nativeName: "TimeoutError",
              });
            },
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "transient" } });

    await expect(
      compile(messagesTemplate())(
        {
          seaglass: {
            recentMessages: async () => ({
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: { kind: "network" } }) }],
            }),
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "transient" } });
  });

  it("consumes the unchanged native MCP guest result shapes", async () => {
    const rawMessages = messagesResult([
      {
        message_id: 1,
        chat_id: 7,
        ts: 10,
        is_from_me: false,
        sender: "private sender",
        has_attachment: false,
      },
    ]);
    const projectedMessages = projectMcpCallToolResult(rawMessages);
    const guestMessages = consumeMcpCodeModeGuestResult(projectedMessages);
    await expect(
      compile(messagesTemplate())({ seaglass: { recentMessages: async () => guestMessages } }, {}),
    ).resolves.toMatchObject({ fire: false });

    const rawGmail = gmailResult({
      count: 0,
      externalContent: true,
      has_more: false,
      messages: [],
      nextPageToken: "",
    });
    const projectedGmail = projectMcpCallToolResult(rawGmail);
    const guestGmail = consumeMcpCodeModeGuestResult(projectedGmail);
    const gmailEmpty = await compile(gmailTemplate())(
      { gmail: { gmailSearch: async () => guestGmail } },
      {},
    );
    expect(gmailEmpty).toMatchObject({ fire: false });
    expect(
      JSON.parse(
        (
          gmailEmpty.state as {
            sources: { gmail: { fingerprint: string } };
          }
        ).sources.gmail.fingerprint,
      ),
    ).toMatchObject({
      v: 2,
      ids: [],
      coverage: { kind: "bounded_head", limit: 1, truncated: false, empty: true },
      floor: null,
    });
  });

  it.each([
    [4, "auth"],
    [6, "permission"],
    [7, "transient"],
    [8, "transient"],
    [10, "config"],
    [11, "transient"],
    [130, "transient"],
    [1, "schema"],
    [2, "schema"],
    [3, "schema"],
    [5, "schema"],
    [99, "schema"],
    [7.5, "schema"],
    ["7", "schema"],
    ["constructor", "schema"],
    ["__proto__", "schema"],
    [null, "schema"],
    [Number.NaN, "schema"],
    [undefined, "schema"],
  ])("classifies a gmail failure with exit_code %o as %s", async (exitCode, kind) => {
    const run = compile(gmailTemplate());
    for (const isError of [true, false]) {
      const result = await run(
        { gmail: { gmailSearch: async () => gmailFailure(exitCode, { isError }) } },
        {},
      );
      expect(result).toEqual({ error: { kind } });
      for (const detail of Object.values(gmailFailureText)) {
        expect(JSON.stringify(result)).not.toContain(detail);
      }
    }
  });

  it("classifies gmail failures by exit code before error text, through text stdout and the guest projection", async () => {
    const run = compile(gmailTemplate());
    const observe = (result: unknown) => run({ gmail: { gmailSearch: async () => result } }, {});
    await expect(observe(gmailFailure(7, { stdoutAsText: true }))).resolves.toEqual({
      error: { kind: "transient" },
    });

    const authText = JSON.stringify({ error: { kind: "auth" } });
    const conflicting = gmailFailure(7);
    await expect(
      observe({
        ...conflicting,
        structuredContent: { ...conflicting.structuredContent, stdout: authText },
      }),
    ).resolves.toEqual({ error: { kind: "transient" } });

    const guest = consumeMcpCodeModeGuestResult(projectMcpCallToolResult(gmailFailure(4)));
    await expect(observe(guest)).resolves.toEqual({ error: { kind: "auth" } });
  });

  it("normalizes loaded state and emits bounded native Calendar sweep intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const run = compile(messagesTemplate());
    const result = await run(messagesMcp([]), {
      state: {
        sources: {
          gmail: {
            fingerprint: JSON.stringify({ v: 2, ids: [] }),
            lastSuccessAt: 1,
            private: "drop",
          },
          messages: {
            fingerprint: JSON.stringify({
              items: [],
              coverage: {
                kind: "bounded_recent_window",
                limit: 50,
                truncated: false,
                empty: true,
              },
            }),
            lastSuccessAt: 1,
          },
          private: { body: "drop" },
        },
        continuations: [
          { id: "valid", source: "gmail", dueAt: 2_000_000, expiresAt: 3_000_000, fires: 1 },
          { id: "negative", source: "gmail", dueAt: 2_000_000, expiresAt: 3_000_000, fires: -1 },
          {
            id: "valid",
            source: "gmail",
            dueAt: 1_500_000,
            expiresAt: 3_500_000,
            fires: 0,
          },
        ],
        nextNativeSweepAt: 999_999,
        private: "drop",
      },
    });
    expect(result).toMatchObject({ fire: true });
    expect(result.message).toBe(JSON.stringify({ version: 1, kind: "native_source_sweep" }));
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.state).toMatchObject({
      continuations: [
        { id: "valid", source: "gmail", dueAt: 2_000_000, expiresAt: 3_000_000, fires: 1 },
      ],
      nextNativeSweepAt: 1_300_000,
    });
  });

  it.each(["messages", "gmail"] as const)(
    "%s: stores a bounded v2 head and fires only on new identities",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);

      const baseline = await observe(base);
      expect(baseline).toMatchObject({ fire: false });
      const stored = storedHead(baseline, source);
      expect(Object.keys(stored)).toEqual(["v", "ids", "coverage", "floor"]);
      expect(stored).toMatchObject({
        v: 2,
        coverage: { kind: head.coverageKind, limit: 100, truncated: true, empty: false },
        floor: head.at(10),
      });
      expect(stored.ids).toHaveLength(100);
      expect(stored.ids).toContain(head.key(0));
      expect(Buffer.byteLength(storedFingerprint(baseline, source))).toBeLessThan(8 * 1024);
      expect(Buffer.byteLength(JSON.stringify(baseline.state))).toBeLessThan(16 * 1024);

      const unchanged = await observe(base, { state: baseline.state });
      expect(unchanged).toMatchObject({ fire: false });

      // The oldest item aging out of the window is not a delta.
      const removalOnly = await observe(base.slice(0, 99), { state: unchanged.state });
      expect(removalOnly).toMatchObject({ fire: false });

      const added = await observe([[500, 2000], ...base.slice(0, 99)], {
        state: removalOnly.state,
      });
      expect(added).toMatchObject({ fire: true });
      expect(JSON.parse(String(added.message))).toMatchObject({
        kind: "source_delta",
        source,
        coverage: { truncated: true },
        uncertainty: null,
      });
      expect(deltaItems(added)).toEqual([head.item(500, 2000)]);
    },
  );

  // Serves a newest-first source the way each connector pages it: Messages by offset, Gmail by `before:`.
  function pagedMcp(source: Source, entries: readonly Entry[], calls: unknown[]) {
    const head = heads[source];
    const sorted = entries.toSorted((a, b) => b[1] - a[1]);
    const pageOf = (rows: readonly Entry[], offset: number) => ({
      rows: rows.slice(offset, offset + 100).map(([n, t]) => head.row(n, t)),
      hasMore: rows.length > offset + 100,
    });
    if (source === "messages") {
      return {
        seaglass: {
          recentMessages: async (args: { offset: number }) => {
            calls.push(args);
            const { rows, hasMore } = pageOf(sorted, args.offset);
            return messagesResult(rows, {
              ...liveWindow,
              offset: args.offset,
              hasMore,
              nextOffset: args.offset + rows.length,
            });
          },
        },
      };
    }
    return {
      gmail: {
        gmailSearch: async (args: { query: string }) => {
          calls.push(args);
          const before = /before:(\d+)/.exec(args.query)?.[1];
          const visible = before
            ? sorted.filter(([, t]) => (gmailEpoch + t * 1000) / 1000 < Number(before))
            : sorted;
          const { rows, hasMore } = pageOf(visible, 0);
          return gmailResult({ messages: rows, count: rows.length, has_more: hasMore });
        },
      },
    };
  }

  it.each(["messages", "gmail"] as const)(
    "%s: pages past a truncated head so a burst larger than one page is reported in full",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, run, observe } = driver(source);
      const baseline = await observe(base);
      const burst: Entry[] = Array.from({ length: 250 }, (_, i): Entry => [1000 + i, 5000 - i]);

      const calls: unknown[] = [];
      const result = await run(pagedMcp(source, [...burst, ...base], calls), {
        state: baseline.state,
      });
      expect(result).toMatchObject({ fire: true });
      expect(JSON.parse(String(result.message))).toMatchObject({ uncertainty: null });
      expect(deltaItems(result)).toHaveLength(250);
      expect(deltaItems(result)).toContainEqual(head.item(1249, 5000 - 249));
      expect(calls).toHaveLength(3);

      // Past the trigger's tool budget, the delta is partial and says so.
      const flood: Entry[] = Array.from({ length: 600 }, (_, i): Entry => [2000 + i, 9000 - i]);
      const partial = await run(pagedMcp(source, [...flood, ...base], []), {
        state: baseline.state,
      });
      // Gmail's `before:` cursor rereads each page's boundary second, so each extra page adds 99.
      expect(deltaItems(partial)).toHaveLength(source === "gmail" ? 496 : 500);
      expect(JSON.parse(String(partial.message))).toMatchObject({
        uncertainty: "older_matches_not_observed",
      });
    },
  );

  it("accepts the null next_offset Seaglass reports for a final short page", async () => {
    const run = compile(messagesTemplate(100));
    const rows = [messagesRow(1, 10), messagesRow(2, 5)];
    const result = await run(
      {
        seaglass: {
          recentMessages: async () => {
            const page = messagesResult(rows, { ...liveWindow });
            const text = JSON.parse(page.content[0].text) as Record<string, unknown>;
            page.content[0].text = JSON.stringify({ ...text, next_offset: null });
            return page;
          },
        },
      },
      { state: undefined },
    );
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ fire: false });
  });

  it.each(["messages", "gmail"] as const)(
    "%s: ignores older items exposed below the head floor and moves the floor",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);
      const baseline = await observe(base);

      // A head item is deleted and the page refills from below the previous floor.
      const refilled: Entry[] = [...base.filter(([n]) => n !== 40), [200, 5]];
      const exposed = await observe(refilled, { state: baseline.state });
      expect(exposed).toMatchObject({ fire: false });
      expect(storedHead(exposed, source).floor).toBe(head.at(5));

      const newer = await observe([[300, 1500], ...refilled.slice(0, 99)], {
        state: exposed.state,
      });
      expect(newer).toMatchObject({ fire: true });
      expect(deltaItems(newer)).toEqual([head.item(300, 1500)]);
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: fires for unseen items inside the observed range, including ties at the floor",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);
      const baseline = await observe(base);

      // Older than the newest item but newer than the floor, while the oldest item ages out.
      const late = await observe([...base.slice(0, 99), [300, 505]], { state: baseline.state });
      expect(late).toMatchObject({ fire: true });
      expect(deltaItems(late)).toEqual([head.item(300, 505)]);

      const tie = await observe([...base.slice(0, 99), [301, 10]], { state: baseline.state });
      expect(tie).toMatchObject({ fire: true });
      expect(deltaItems(tie)).toEqual([head.item(301, 10)]);
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: coverage flips alone do not fire and truncated pages must be newest-first",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, run, page, observe } = driver(source);

      const truncated = await observe(base);
      const complete = await observe(base, { state: truncated.state, hasMore: false });
      expect(complete).toMatchObject({ fire: false });
      expect(storedHead(complete, source).floor).toBeNull();
      await expect(observe(base, { state: complete.state })).resolves.toMatchObject({
        fire: false,
      });

      const oldestFirst = page(base).toReversed();
      await expect(run(head.mcp(oldestFirst, true), {})).resolves.toEqual({
        error: { kind: "incomplete" },
      });
      await expect(run(head.mcp(oldestFirst, false), {})).resolves.toMatchObject({ fire: false });
      // Equal timestamps are still non-increasing.
      await expect(observe(base.map(([n]): Entry => [n, 1000]))).resolves.toMatchObject({
        fire: false,
      });
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: fires for an unseen item whose timestamp cannot be read",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, run, page, observe } = driver(source);
      const baseline = await observe(base);

      // A complete page needs no readable timestamps, and the item cannot be proven old.
      const rows = [...page(base.slice(0, 99)), head.unreadable(700)];
      const unseen = await run(head.mcp(rows, false), { state: baseline.state });
      expect(unseen).toMatchObject({ fire: true });
      expect(deltaItems(unseen)).toEqual([{ ...head.item(700, 0), timestamp: "unreadable" }]);
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: takes the floor from the raw rows when duplicate rows conflict",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, run } = driver(source);
      // Deduping keeps the lexicographically smaller item, which here is the NEWER row
      // ("10" sorts before "9", thread "a" before "z"), so a floor taken after it would be too high.
      const rows =
        source === "messages"
          ? {
              newer: { message_id: 1, chat_id: 7, ts: 10 },
              older: { message_id: 1, chat_id: 7, ts: 9 },
              inside: { message_id: 2, chat_id: 7, ts: 9.5 },
              below: { message_id: 3, chat_id: 7, ts: 8.5 },
              insideItem: { id: 2, conversationId: 7, timestamp: 9.5 },
              floor: 9,
            }
          : {
              newer: { ...gmailRow(1, 20), threadId: "a" },
              older: { ...gmailRow(1, 10), threadId: "z" },
              inside: gmailRow(2, 15),
              below: gmailRow(3, 5),
              insideItem: head.item(2, 15),
              floor: head.at(10),
            };

      const seed = await run(head.mcp([rows.newer, rows.older], true), {});
      expect(seed).toMatchObject({ fire: false });
      expect(storedHead(seed, source)).toMatchObject({ floor: rows.floor });
      expect(storedHead(seed, source).ids).toHaveLength(1);

      // Between the duplicate timestamps, so it is inside the observed range and must fire.
      const late = await run(head.mcp([rows.newer, rows.inside], true), { state: seed.state });
      expect(late).toMatchObject({ fire: true });
      expect(deltaItems(late)).toEqual([rows.insideItem]);

      // Positively older than the raw minimum is still an exposed item.
      await expect(
        run(head.mcp([rows.newer, rows.below], true), { state: seed.state }),
      ).resolves.toMatchObject({ fire: false });
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: fires for an unseen identity unless every row carrying it is older than the floor",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);
      const baseline = await observe(base);
      const refilled = base.filter(([n]) => n !== 40 && n !== 41);

      // One row inside the observed range is enough, though deduping keeps the older, exposed row.
      const mixed = await observe([...refilled, [300, 500], [300, 5]], { state: baseline.state });
      expect(mixed).toMatchObject({ fire: true });
      expect(deltaItems(mixed)).toEqual([head.item(300, 5)]);

      const exposed = await observe([...refilled, [301, 6], [301, 5]], { state: baseline.state });
      expect(exposed).toMatchObject({ fire: false });
    },
  );

  it("accepts float Messages windows and rejects rows and truncated pages it cannot trust", async () => {
    const run = compile(messagesTemplate(100));
    const live = { ...liveWindow, hasMore: true };
    const rows = [30, 20, 10].map((t, n) => heads.messages.row(n, t));
    const incomplete = { error: { kind: "incomplete" } };
    const schema = { error: { kind: "schema" } };

    await expect(run(messagesMcp(rows, live), {})).resolves.toMatchObject({
      fire: false,
      state: {
        sources: {
          messages: {
            cursor: { sinceTs: liveWindow.sinceTs, beforeTs: liveWindow.beforeTs, nextOffset: 3 },
          },
        },
      },
    });
    await expect(
      run(messagesMcp(rows, { ...live, offset: 3, nextOffset: 6 }), {}),
    ).resolves.toEqual(incomplete);

    const unreadable = [heads.messages.unreadable(0)];
    await expect(run(messagesMcp(unreadable, live), {})).resolves.toEqual(schema);
    await expect(
      run(messagesMcp(unreadable, { ...live, hasMore: false }), {}),
    ).resolves.toMatchObject({ fire: false });
    await expect(run(messagesMcp(rows, { ...live, sinceTs: -1 }), {})).resolves.toEqual(schema);
    await expect(run(messagesMcp(rows, { ...live, nextOffset: 3.5 }), {})).resolves.toEqual(schema);
    // Zero is a valid window bound but not a valid row timestamp.
    await expect(
      run(messagesMcp(rows, { ...live, sinceTs: 0, beforeTs: 0 }), {}),
    ).resolves.toMatchObject({ fire: false });
    for (const ts of [null, 0, -1]) {
      await expect(
        run(messagesMcp([{ message_id: 1, chat_id: 7, ts }], live), {}),
      ).resolves.toEqual(schema);
    }

    // Row ids are positive safe integers; the "chat:message" identity key must stay unambiguous.
    for (const id of ["12", "1:2", 1.5, 0, -1, null, 2 ** 53]) {
      await expect(
        run(messagesMcp([{ message_id: id, chat_id: 7, ts: 10 }], liveWindow), {}),
      ).resolves.toEqual(schema);
      await expect(
        run(messagesMcp([{ message_id: 1, chat_id: id, ts: 10 }], liveWindow), {}),
      ).resolves.toEqual(schema);
    }

    // A legacy prior that stored the same ids as strings still maps to the same identity key.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const legacyPrior = (items: unknown[]) => ({
      sources: {
        messages: {
          fingerprint: JSON.stringify({
            items,
            coverage: { kind: "bounded_recent_window", limit: 100, truncated: false, empty: false },
          }),
          lastSuccessAt: 1,
        },
      },
      continuations: [],
      nextNativeSweepAt: 10_000_000,
    });
    const stringIdPrior = legacyPrior([{ id: "1", conversationId: "7", timestamp: 10 }]);
    const known = { message_id: 1, chat_id: 7, ts: 10 };
    await expect(
      run(messagesMcp([known], liveWindow), { state: stringIdPrior }),
    ).resolves.toMatchObject({ fire: false });
    const added = await run(
      messagesMcp([{ message_id: 2, chat_id: 7, ts: 11 }, known], liveWindow),
      { state: stringIdPrior },
    );
    expect(added).toMatchObject({ fire: true });
    expect(deltaItems(added)).toEqual([{ id: 2, conversationId: 7, timestamp: 11 }]);

    // Legacy items keep the lenient identity rule of the runtime that wrote them, unlike v2 keys.
    const looseKeyPrior = legacyPrior([{ id: "x", conversationId: "abc", timestamp: 10 }]);
    const unseen = await run(messagesMcp([known], liveWindow), { state: looseKeyPrior });
    expect(deltaItems(unseen)).toEqual([{ id: 1, conversationId: 7, timestamp: 10 }]);
  });

  it("needs readable Gmail timestamps only to prove a truncated head and fails closed on oversized state", async () => {
    const run = compile(gmailTemplate(100));
    const schema = { error: { kind: "schema" } };
    const unreadable = [{ id: "a1", threadId: "t1", internalDateIso: "not a timestamp" }];

    await expect(run(gmailMcp(unreadable), {})).resolves.toMatchObject({ fire: false });
    await expect(run(gmailMcp(unreadable, { hasMore: true }), {})).resolves.toEqual(schema);
    await expect(run(gmailMcp(unreadable, { nextPageToken: "opaque-next" }), {})).resolves.toEqual(
      schema,
    );

    const longIds = Array.from({ length: 100 }, (_, n) => ({
      id: String(n).padStart(100, "x"),
      threadId: null,
      internalDateIso: gmailIso(1000 - n),
    }));
    await expect(run(gmailMcp(longIds), {})).resolves.toEqual(schema);
  });

  it.each(["messages", "gmail"] as const)(
    "%s: carries over the legacy full-item state and rebaselines unusable state silently",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);
      const legacy = (entries: readonly Entry[], truncated: boolean, unreadable = false) => ({
        version: 1,
        sources: {
          [source]: {
            fingerprint: JSON.stringify({
              items: entries.map(([n, t]) => ({
                ...head.item(n, t),
                ...(unreadable ? { timestamp: "unreadable" } : {}),
              })),
              coverage: { kind: head.coverageKind, limit: 100, truncated, empty: false },
            }),
            lastSuccessAt: 1,
          },
        },
        continuations: [],
        nextNativeSweepAt: 10_000_000,
      });
      const complete = { hasMore: false };
      // The deployed runtime failed closed above 8 KiB, so its Gmail states held fewer than ~85 items.
      const stored = base.slice(0, 60);

      const unchanged = await observe(stored, { state: legacy(stored, false), ...complete });
      expect(unchanged).toMatchObject({ fire: false });
      expect(storedHead(unchanged, source)).toMatchObject({ v: 2, floor: null });
      const added = await observe(stored, { state: legacy(stored.slice(1), false), ...complete });
      expect(added).toMatchObject({ fire: true });
      expect(deltaItems(added)).toEqual([head.item(0, 1000)]);

      // A truncated legacy head applies the same floor rule, derived from its item timestamps.
      const refilled: Entry[] = [...stored.filter(([n]) => n !== 40), [200, 5]];
      await expect(observe(refilled, { state: legacy(stored, true) })).resolves.toMatchObject({
        fire: false,
      });
      const late = await observe([...stored.slice(0, 59), [300, 505]], {
        state: legacy(stored, true),
      });
      expect(deltaItems(late)).toEqual([head.item(300, 505)]);
      // Without a readable floor every unseen item counts as added.
      const noFloor = await observe(refilled, { state: legacy(stored, true, true) });
      expect(deltaItems(noFloor)).toEqual([head.item(200, 5)]);

      for (const fingerprint of [
        "not json",
        "[]",
        JSON.stringify({ v: 3, ids: ["unknown-version"] }),
        JSON.stringify({ v: 2, ids: [1] }),
        JSON.stringify({ items: [null], coverage: {} }),
        JSON.stringify({ items: [{}], coverage: {} }),
      ]) {
        const rebaselined = await observe(base, {
          state: { sources: { [source]: { fingerprint, lastSuccessAt: 1 } } },
        });
        expect(rebaselined).toMatchObject({ fire: false });
        expect(storedHead(rebaselined, source).v).toBe(2);
      }
    },
  );

  it.each(["messages", "gmail"] as const)(
    "%s: rebaselines silently when a v2 prior holds anything the writer cannot emit",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { head, observe } = driver(source);
      const coverage = (truncated: unknown) => ({
        kind: head.coverageKind,
        limit: 100,
        truncated,
        empty: false,
      });
      // The kind the other source writes: a prior carrying it was not written by this source.
      const otherKind = heads[source === "gmail" ? "messages" : "gmail"].coverageKind;
      const withKind = (kind: unknown, truncated = false) => ({ ...coverage(truncated), kind });
      // A usable complete prior holding item 0; an `undefined` field is dropped by JSON, i.e. missing.
      const prior = (fields: Record<string, unknown>) =>
        JSON.stringify({
          v: 2,
          ids: [head.key(0)],
          coverage: coverage(false),
          floor: null,
          ...fields,
        });
      const ids = (...keys: unknown[]) => prior({ ids: keys });
      const observeComplete = (fingerprint: string, entries: readonly Entry[] = [[1, 500]]) =>
        observe(entries, {
          state: { sources: { [source]: { fingerprint, lastSuccessAt: 1 } } },
          hasMore: false,
        });
      // JSON cannot write a non-finite number, but it can read one back from an overflowing literal.
      const overflowFloor = prior({ coverage: coverage(true), floor: 0 }).replace(
        '"floor":0',
        '"floor":1e999',
      );
      const unusable = [
        ids(""),
        ids("   "),
        ids(head.key(0), ""),
        ...(source === "messages"
          ? ["a:b", "0:1", "1:0", "1:2:3", "01:2", "12"].map((key) => ids(key))
          : []),
        prior({ floor: head.at(10) }),
        prior({ coverage: coverage(true), floor: "5" }),
        prior({ coverage: coverage(true), floor: "NaN" }),
        prior({ coverage: coverage(true), floor: [] }),
        prior({ coverage: coverage(true), floor: undefined }),
        overflowFloor,
        prior({ coverage: undefined }),
        prior({ coverage: [] }),
        prior({ coverage: coverage("true") }),
        prior({ coverage: coverage(1) }),
        prior({ coverage: coverage(null) }),
        prior({ coverage: withKind(otherKind) }),
        prior({ coverage: withKind(otherKind, true), floor: head.at(10) }),
        prior({ coverage: withKind(undefined) }),
        prior({ coverage: withKind(undefined, true), floor: head.at(10) }),
        prior({ coverage: withKind(["bounded_head"]) }),
        prior({ coverage: withKind("unknown") }),
      ];
      for (const fingerprint of unusable) {
        const result = await observeComplete(fingerprint);
        expect(result, fingerprint).toMatchObject({ fire: false });
        expect(storedHead(result, source).ids, fingerprint).toEqual([head.key(1)]);
      }

      // Usable priors are still compared, so the cases above are not quiet for another reason.
      expect(deltaItems(await observeComplete(prior({})))).toEqual([head.item(1, 500)]);
      // A truncated head without a floor (an empty truncated page) treats every unseen item as added.
      const noFloor = await observeComplete(prior({ coverage: coverage(true) }));
      expect(deltaItems(noFloor)).toEqual([head.item(1, 500)]);
      const floored = await observeComplete(
        prior({ coverage: coverage(true), floor: head.at(600) }),
        [
          [1, 700],
          [2, 500],
        ],
      );
      expect(deltaItems(floored)).toEqual([head.item(1, 700)]);
    },
  );
});
