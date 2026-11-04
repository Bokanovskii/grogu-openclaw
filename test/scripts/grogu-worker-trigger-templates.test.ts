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

function messagesTemplate(): WorkerTriggerTemplate {
  return workerTriggerTemplateSchema.parse({
    version: 1,
    templateId: "messages-metadata-v1",
    schemaSha256,
    toolsAllow: approvedTools,
    args: { since_ts: 100, limit: 50, offset: 0, include_text: false },
    maxItems: 50,
    continuation,
  });
}

function gmailTemplate(): WorkerTriggerTemplate {
  return workerTriggerTemplateSchema.parse({
    version: 1,
    templateId: "gmail-metadata-v1",
    schemaSha256,
    toolsAllow: approvedTools,
    args: {
      query: "newer_than:1d",
      max: 1,
      include_body: false,
      sanitize_content: true,
    },
    maxItems: 1,
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

function messagesResult(
  messages: unknown[],
  options: { hasMore?: boolean; nextOffset?: number } = {},
) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          source: "messages",
          observed_at_ts: 300,
          newest_source_ts: messages.length > 0 ? 200 : null,
          since_ts: 100,
          before_ts: 200,
          limit: 50,
          offset: 0,
          has_more: options.hasMore ?? false,
          next_offset: options.nextOffset ?? messages.length,
          messages,
        }),
      },
    ],
    isError: false,
  };
}

function messagesMcp(
  messages: unknown[],
  options: { hasMore?: boolean; nextOffset?: number } = {},
) {
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
                  id: "m1",
                  threadId: "t1",
                  internalDateIso: "2026-11-04T00:00:00Z",
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

    await expect(
      compile(messagesTemplate())(
        messagesMcp([{ message_id: 1, chat_id: 7, ts: 10 }], {
          hasMore: true,
          nextOffset: 1,
        }),
        {},
      ),
    ).resolves.toEqual({ error: { kind: "incomplete" } });
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
        String(
          (
            gmailEmpty.state as {
              sources: { gmail: { fingerprint: string } };
            }
          ).sources.gmail.fingerprint,
        ),
      ),
    ).toMatchObject({
      items: [],
      coverage: { kind: "bounded_head", limit: 1, truncated: false, empty: true },
    });
  });

  it("normalizes loaded state and emits bounded native Calendar sweep intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const run = compile(messagesTemplate());
    const result = await run(messagesMcp([]), {
      state: {
        sources: {
          gmail: { fingerprint: "[]", lastSuccessAt: 1, private: "drop" },
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
});
