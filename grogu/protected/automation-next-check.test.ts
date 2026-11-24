import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDurationMs } from "../../src/cli/parse-duration.js";
import { AUTOMATIONS_CHAT_PLUGIN_ID } from "./automations-chat/contract.js";
import { createNextCheckTool } from "./automations-chat/next-check.js";

void test("next_check accepts only a duration from the still-current protected turn", async () => {
  const turn = new AbortController();
  const assertInvocationCurrent = () => turn.signal.throwIfAborted();
  const proposed: number[] = [];
  const tool = createNextCheckTool({
    assertInvocationCurrent,
    toolRuntimeBindings: {
      [AUTOMATIONS_CHAT_PLUGIN_ID]: {
        parseDurationMs,
        proposeNextCheck: (delayMs: number) => proposed.push(delayMs),
      },
    },
  });
  assert.ok(tool);
  for (const params of [{ in: "at lunch" }, { in: "0s" }, { in: "15m", jobId: "other" }]) {
    assert.equal((await tool.execute("invalid", params)).details.status, "invalid");
  }
  assert.deepEqual(proposed, []);
  const result = await tool.execute("valid", { in: "1m30s" });
  assert.deepEqual(result.details, {
    status: "proposed",
    proposedDelayMs: 90_000,
    writeApplied: false,
  });
  turn.abort(new Error("turn revoked"));
  await assert.rejects(tool.execute("retained", { in: "5m" }), /turn revoked/);
  assert.deepEqual(proposed, [90_000]);
});
