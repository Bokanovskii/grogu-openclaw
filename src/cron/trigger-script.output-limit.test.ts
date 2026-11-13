import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { renderWorkerTriggerScript } from "../../grogu/worker-trigger-templates.js";
import { mcpTool } from "../agents/code-mode.test-support.js";
import { projectMcpCallToolResult } from "../agents/mcp-content.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

describe("cron script output boundary", () => {
  it.each([
    { mode: "trigger", channel: "return" },
    { mode: "trigger", channel: "json" },
    { mode: "payload", channel: "return" },
    { mode: "payload", channel: "json" },
  ] as const)(
    "rejects a truncated $channel result for $mode without settling stale output",
    async ({ mode, channel }) => {
      const config: OpenClawConfig = { tools: { codeMode: { maxOutputBytes: 12288 } } };
      const runtime = createCronScriptRuntimeFixture({
        config,
        prepareRuntime: async () => ({
          context: { config, agentId: "main", sessionKey: "cron:synthetic:trigger" },
          createTools: async () => [],
        }),
      });
      const input = {
        jobId: "synthetic-output-limit",
        script:
          'json({fire: false, notify: "stale", state: {cursor: "stale"}}); ' +
          'const current = {fire: true, message: "x".repeat(12288), notify: "x".repeat(12288), state: {cursor: "current"}}; ' +
          (channel === "return" ? "return current;" : "json(current);"),
        state: null,
        toolsAllow: [],
      };
      const result = await (mode === "trigger"
        ? runtime.evaluateTrigger(input)
        : runtime.executePayload(input));
      expect(result).toEqual({
        kind: "error",
        code: "output_limit_exceeded",
        error: `cron ${mode === "trigger" ? "trigger" : "script payload"} result was truncated; return a smaller complete result`,
      });
    },
  );

  it.each(["trigger", "payload"] as const)(
    "accepts a complete returned %s decision despite oversized diagnostic output",
    async (mode) => {
      const config: OpenClawConfig = { tools: { codeMode: { maxOutputBytes: 12288 } } };
      const runtime = createCronScriptRuntimeFixture({
        config,
        prepareRuntime: async () => ({
          context: { config, agentId: "main", sessionKey: "cron:synthetic:trigger" },
          createTools: async () => [],
        }),
      });
      const input = {
        jobId: "synthetic-complete-result",
        script: 'text("x".repeat(12288)); return {fire: false, state: {cursor: "current"}};',
        state: null,
        toolsAllow: [],
      };
      const result = await (mode === "trigger"
        ? runtime.evaluateTrigger(input)
        : runtime.executePayload(input));
      expect(result).toEqual(
        mode === "trigger"
          ? { kind: "evaluated", fire: false, state: { cursor: "current" } }
          : { kind: "completed", stateChanged: true, state: { cursor: "current" } },
      );
    },
  );

  it("rejects a rendered Messages burst at the configured output budget without changing the prior cursor", async () => {
    const config: OpenClawConfig = { tools: { codeMode: { maxOutputBytes: 12288 } } };
    let burst = false;
    let calls = 0;
    const tool = mcpTool({
      name: "seaglass__recent_messages",
      serverName: "seaglass",
      toolName: "recent_messages",
      execute: async (_id, input) => {
        calls += 1;
        if (!isRecord(input) || (input.offset !== 0 && input.offset !== 100)) {
          throw new Error("Unexpected synthetic Messages page offset");
        }
        const offset = input.offset;
        const rows = Array.from({ length: burst ? 200 : 1 }, (_, n) => ({
          message_id: 5_000_000 + n,
          chat_id: 100,
          ts: 1000 + n,
        })).toReversed();
        return projectMcpCallToolResult({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                source: "messages",
                since_ts: 100,
                before_ts: 2000,
                limit: 100,
                offset,
                has_more: burst && offset === 0,
                next_offset: burst && offset === 0 ? 100 : null,
                messages: rows.slice(offset, offset + 100),
              }),
            },
          ],
        });
      },
    });
    const runtime = createCronScriptRuntimeFixture({
      config,
      prepareRuntime: async () => ({
        context: { config, agentId: "main", sessionKey: "cron:synthetic:trigger" },
        createTools: async () => [tool],
      }),
    });
    const input = {
      jobId: "synthetic-messages-burst",
      script: renderWorkerTriggerScript({
        version: 1,
        templateId: "messages-metadata-v1",
        schemaSha256: "16f483176747c72d4e27fe9c8cd4c645c48d4f6aa6aadaded3bdbe2ca89495b1",
        toolsAllow: ["seaglass__recent_messages"],
        args: { limit: 100, offset: 0, include_text: false },
        maxItems: 100,
        continuation: {
          delayMs: 60_000,
          intervalMs: 60_000,
          nativeSweepIntervalMs: 300_000,
          maxOpen: 8,
          maxFires: 2,
          ttlMs: 86_400_000,
        },
      }),
      state: null,
      toolsAllow: ["seaglass__recent_messages"],
    };
    const initial = await runtime.evaluateTrigger(input);
    if (initial.kind !== "evaluated") {
      throw new Error(`Initial source baseline failed: ${JSON.stringify(initial)}`);
    }
    expect(initial.fire).toBe(false);
    const prior = structuredClone(initial.state);
    burst = true;
    await expect(runtime.evaluateTrigger({ ...input, state: initial.state })).resolves.toEqual({
      kind: "error",
      code: "output_limit_exceeded",
      error: "cron trigger result was truncated; return a smaller complete result",
    });
    expect(initial.state).toEqual(prior);
    expect(calls).toBe(3);
  });
});
