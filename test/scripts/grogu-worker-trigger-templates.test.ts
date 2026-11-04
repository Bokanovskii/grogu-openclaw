import { describe, expect, it } from "vitest";
import {
  evaluateWorkerTrigger,
  renderWorkerTriggerScript,
  workerTriggerTemplateSchema,
  type WorkerTriggerTemplate,
} from "../../grogu/worker-trigger-templates.js";

const schemaSha256 = "a".repeat(64);
const continuation = {
  delayMs: 60_000,
  intervalMs: 60_000,
  maxOpen: 8,
  maxFires: 3,
  ttlMs: 24 * 60 * 60_000,
};

function messagesTemplate(): WorkerTriggerTemplate {
  return workerTriggerTemplateSchema.parse({
    version: 1,
    source: "messages",
    tool: {
      server: "seaglass",
      name: "recent_messages",
      schemaSha256,
      args: { since_ts: 100, limit: 50, offset: 0, include_text: false },
    },
    result: {
      complete: "complete",
      items: "messages",
      cursor: "next_offset",
      fields: {
        id: "message_id",
        secondaryId: "chat_id",
        timestamp: "timestamp",
      },
    },
    maxItems: 50,
    continuation,
  });
}

describe("private worker trigger templates", () => {
  it("enforces reviewed source-specific read-only MCP contracts", () => {
    expect(() =>
      workerTriggerTemplateSchema.parse({
        ...messagesTemplate(),
        tool: {
          ...messagesTemplate().tool,
          args: { include_text: true },
        },
      }),
    ).toThrow(/metadata-only recent_messages/);

    expect(() =>
      workerTriggerTemplateSchema.parse({
        version: 1,
        source: "gmail",
        tool: {
          server: "gmail",
          name: "gmail_search",
          schemaSha256,
          args: {
            query: "newer_than:1d",
            max: 1,
            include_body: false,
            sanitize_content: true,
          },
        },
        result: {
          complete: "structuredContent.exit_code",
          completeValue: 0,
          guards: [
            { path: "isError", equals: false },
            { path: "structuredContent.tool", equals: "gmail_search" },
            { path: "structuredContent.risk", equals: "read" },
          ],
          items: "structuredContent.messages",
          cursor: "structuredContent.cursor",
          fields: {
            id: "message_id",
            secondaryId: "thread_id",
            timestamp: "timestamp",
            status: "status",
          },
        },
        maxItems: 1,
        continuation,
      }),
    ).not.toThrow();

    expect(() =>
      workerTriggerTemplateSchema.parse({
        version: 1,
        source: "calendar",
        tool: {
          server: "calendar",
          name: "icloud_calendar_events",
          schemaSha256,
          args: { from: "2026-11-03", to: "2026-11-10", calendar: "default", limit: 20 },
        },
        result: {
          complete: "complete",
          items: "events",
          cursor: "cursor",
          fields: {
            id: "uid",
            secondaryId: "recurrence",
            timestamp: "updated",
            start: "start",
            end: "end",
            status: "status",
          },
        },
        maxItems: 20,
        continuation,
      }),
    ).not.toThrow();
  });

  it("treats only structurally complete empty observations as quiet success", () => {
    const template = messagesTemplate();
    const quiet = evaluateWorkerTrigger({
      template,
      observation: {
        complete: true,
        messages: [],
        next_offset: 0,
        private_body: "must not survive",
      },
      previousState: undefined,
      nowMs: 1_000,
    });
    expect(quiet).toMatchObject({ fire: false });
    expect(JSON.stringify(quiet)).not.toContain("private_body");

    expect(() =>
      evaluateWorkerTrigger({
        template,
        observation: {
          complete: false,
          failure: { kind: "permission", private: "omitted" },
          messages: [],
        },
        previousState: undefined,
        nowMs: 1_000,
      }),
    ).toThrow(/worker_source_failure/);
  });

  it("emits metadata-only deltas and bounded due continuations without new items", () => {
    const template = messagesTemplate();
    const baseline = evaluateWorkerTrigger({
      template,
      observation: { complete: true, messages: [], next_offset: 0 },
      previousState: undefined,
      nowMs: 1_000,
    });
    const changed = evaluateWorkerTrigger({
      template,
      observation: {
        complete: true,
        messages: [
          {
            message_id: "opaque-message",
            chat_id: 42,
            timestamp: 2_000,
            text: "private body",
          },
        ],
        next_offset: 1,
      },
      previousState: baseline.state,
      nowMs: 2_000,
    });
    expect(changed).toMatchObject({ fire: true });
    expect(changed.message).toContain("source_delta");
    expect(changed.message).not.toContain("private body");

    const due = evaluateWorkerTrigger({
      template,
      observation: {
        complete: true,
        messages: [
          {
            message_id: "opaque-message",
            chat_id: 42,
            timestamp: 2_000,
            text: "different private body",
          },
        ],
        next_offset: 1,
      },
      previousState: changed.state,
      nowMs: 62_000,
    });
    expect(due).toMatchObject({ fire: true });
    expect(due.message).toContain("continuation_due");
    expect(due.message).not.toContain("private body");
  });

  it("renders a self-contained MCP trigger without embedding source data", async () => {
    const script = renderWorkerTriggerScript(messagesTemplate());
    expect(script).toContain("MCP[template.tool.server][template.tool.name]");
    expect(script).toContain("include_text");
    expect(script).not.toContain("private body");
    expect(script.length).toBeLessThan(65_536);

    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (mcp: unknown, trigger: unknown) => Promise<unknown>;
    const run = new AsyncFunction("MCP", "trigger", script);
    await expect(
      run(
        {
          seaglass: {
            recent_messages: async () => ({
              complete: true,
              messages: [],
              next_offset: 0,
            }),
          },
        },
        { state: undefined },
      ),
    ).resolves.toMatchObject({ fire: false, state: { version: 1 } });
  });
});
