import { expect, it, vi } from "vitest";
import {
  bindSubagentBeforeDeleteCleanupHook,
  runSubagentBeforeDeleteCleanupHook,
} from "./subagent-registry-child-result-hook.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const run = (childSessionIdentity?: SubagentRunRecord["childSessionIdentity"]) =>
  ({
    runId: "r1",
    childSessionKey: "agent:main:subagent:c",
    childSessionIdentity,
    execution: { status: "terminal", outcome: { status: "ok" } },
    completion: { required: false, resultText: "Research result" },
  }) as SubagentRunRecord;

it("passes the exact child generation and fails closed without identity or on rejection", async () => {
  const hook = vi.fn();
  const identity = { sessionId: "s1", lifecycleRevision: "v1" };
  const entry = run(identity);
  await runSubagentBeforeDeleteCleanupHook(entry, identity);
  bindSubagentBeforeDeleteCleanupHook(entry, hook);
  await runSubagentBeforeDeleteCleanupHook(entry, identity);
  expect(hook).toHaveBeenCalledWith({
    runId: "r1",
    sessionKey: "agent:main:subagent:c",
    sessionId: "s1",
    lifecycleRevision: "v1",
    outcome: { status: "ok" },
    resultText: "Research result",
  });
  const bare = run();
  bindSubagentBeforeDeleteCleanupHook(bare, hook);
  await expect(runSubagentBeforeDeleteCleanupHook(bare, identity)).rejects.toThrow("identity");
  const failingIdentity = { sessionId: "s2", lifecycleRevision: "v2" };
  const failing = run(failingIdentity);
  bindSubagentBeforeDeleteCleanupHook(failing, () => {
    throw new Error("no authority");
  });
  await expect(runSubagentBeforeDeleteCleanupHook(failing, failingIdentity)).rejects.toThrow(
    "no authority",
  );
});
