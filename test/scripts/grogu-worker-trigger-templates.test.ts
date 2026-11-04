import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderWorkerTriggerScript,
  workerTriggerScriptSha256,
  workerTriggerTemplateSchema,
  type WorkerTriggerTemplate,
} from "../../grogu/worker-trigger-templates.js";

const schemaSha256 = "a".repeat(64);
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
    toolsAllow: ["seaglass__recent_messages"],
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
    toolsAllow: ["gmail__gmail_search"],
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

function messagesMcp(messages: unknown[]) {
  return {
    seaglass: {
      recentMessages: async () => ({
        messages,
        since_ts: 100,
        before_ts: 200,
        next_offset: 0,
      }),
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
        toolsAllow: ["seaglass__recent_messages", "message"],
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
    expect(messages).not.toContain("icloud_calendar_events");
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
        { message_id: "b", chat_id: "chat", timestamp: 20, text: "private body" },
        { message_id: "a", chat_id: "chat", timestamp: 10, text: "other body" },
      ]),
      {},
    );
    expect(initial.fire).toBe(false);
    expect(JSON.stringify(initial)).not.toContain("private body");

    vi.setSystemTime(2_000);
    const reordered = await run(
      messagesMcp([
        { message_id: "a", chat_id: "chat", timestamp: 10, text: "changed body" },
        { message_id: "b", chat_id: "chat", timestamp: 20 },
        { message_id: "a", chat_id: "chat", timestamp: 10 },
      ]),
      { state: initial.state },
    );
    expect(reordered.fire).toBe(false);
    expect(JSON.stringify(reordered)).not.toContain("changed body");

    const malformed = await run(
      messagesMcp([{ message_id: null, chat_id: "chat", timestamp: 10 }]),
      { state: reordered.state },
    );
    expect(malformed).toEqual({ error: { kind: "schema" } });
  });

  it("requires complete Gmail pages and preserves typed source failures", async () => {
    const run = compile(gmailTemplate());
    const partial = await run(
      {
        gmail: {
          gmailSearch: async () => ({
            isError: false,
            structuredContent: {
              tool: "gmail_search",
              risk: "read",
              exit_code: 0,
              complete: false,
              hasMore: true,
              messages: [],
            },
          }),
        },
      },
      {},
    );
    expect(partial).toEqual({ error: { kind: "incomplete" } });

    const ambiguousFullPage = await run(
      {
        gmail: {
          gmailSearch: async () => ({
            isError: false,
            structuredContent: {
              tool: "gmail_search",
              risk: "read",
              exit_code: 0,
              messages: [{ message_id: "m1", timestamp: 10 }],
            },
          }),
        },
      },
      {},
    );
    expect(ambiguousFullPage).toEqual({ error: { kind: "incomplete" } });

    const completeFullPage = await run(
      {
        gmail: {
          gmailSearch: async () => ({
            isError: false,
            structuredContent: {
              tool: "gmail_search",
              risk: "read",
              exit_code: 0,
              hasMore: false,
              messages: [{ message_id: "m1", timestamp: 10, body: "private" }],
            },
          }),
        },
      },
      {},
    );
    expect(completeFullPage).toMatchObject({ fire: false });
    expect(JSON.stringify(completeFullPage)).not.toContain("private");

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
      compile(messagesTemplate())(
        {
          seaglass: {
            recentMessages: async () => ({
              isError: true,
              error: { kind: "network" },
              structuredContent: {},
            }),
          },
        },
        {},
      ),
    ).resolves.toEqual({ error: { kind: "transient" } });
  });

  it("normalizes loaded state and emits bounded native Calendar sweep intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const run = compile(messagesTemplate());
    const result = await run(messagesMcp([]), {
      state: {
        sources: {
          gmail: { fingerprint: "[]", lastSuccessAt: 1, private: "drop" },
          messages: { fingerprint: "[]", lastSuccessAt: 1 },
          private: { body: "drop" },
        },
        continuations: [
          { id: "valid", source: "gmail", dueAt: 2_000_000, expiresAt: 3_000_000, fires: 1 },
          { id: "negative", source: "gmail", dueAt: 2_000_000, expiresAt: 3_000_000, fires: -1 },
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
