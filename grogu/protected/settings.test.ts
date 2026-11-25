import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import { resolveModelAsync } from "../../src/agents/embedded-agent-runner/model.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { protectedOpenClawConfig, sparky } from "./settings.js";

const serviceRoot = fileURLToPath(new URL("../..", import.meta.url));

// Sparky sends its reasoning on a separate field and the answer as plain content chunks.
async function* sparkyFrames() {
  const frame = (delta: object, finishReason: "stop" | null = null) => ({
    id: "chatcmpl-sparky",
    object: "chat.completion.chunk" as const,
    created: 1,
    model: sparky.id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  yield frame({ reasoning_content: "Checking the question." });
  yield frame({ content: "Hello " });
  yield frame({ content: "there.\n\n" });
  yield frame({ content: "Done." });
  yield frame({}, "stop");
}

// Without the model opt-in the transport marks the answer as terminal-only, which keeps every
// answer delta out of the reply stream until the model ends (live Sparky turns showed none).
test("the Sparky model Alcove resolves streams its answer live after reasoning", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-settings-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const resolved = await resolveModelAsync(
    sparky.provider,
    sparky.id,
    path.join(stateDir, "agents", "protected", "agent"),
    protectedOpenClawConfig(stateDir, serviceRoot),
    { skipAgentDiscovery: true },
  );
  assert.ok(resolved.model, resolved.error ?? "the Sparky model did not resolve");
  const { model } = resolved;
  assert.equal(model.params?.structuredReasoningStreaming, true);

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 1,
  };
  const events: AssistantMessageEvent[] = [];
  await processCompletionsStream(sparkyFrames(), output, model, {
    push: (event) => events.push(event),
  });

  assert.equal(output.openclawDelivery?.textPhaseRequiresTerminal, undefined);
  assert.deepEqual(
    events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])),
    ["Hello ", "there.\n\n", "Done."],
  );
});
