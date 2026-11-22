import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createRuntimeToolMatcher } from "../../agents/tool-policy-match.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runCliAgentMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");

describe("native Cron plugin-service execution authority", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("forwards the live grant and saved cap to embedded execution without widening tools", async () => {
    mockRunCronFallbackPassthrough();
    const bindings = { web_fetch: { profileId: "synthetic-member" } };
    const assertCurrent = () => {};
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "Synthetic summary",
            toolsAllow: ["read"],
          },
        }),
        executionAuthority: {
          toolsAllow: ["web_fetch"],
          toolBindings: bindings,
          assertInvocationCurrent: assertCurrent,
        },
      }),
    );
    expect(result.status).toBe("ok");
    const request = requireRecord(runEmbeddedAgentMock.mock.calls[0]?.[0]);
    expect(request.toolBindings).toBe(bindings);
    expect(request.assertInvocationCurrent).toBe(assertCurrent);
    const cap = request.toolsAllow;
    if (!Array.isArray(cap) || !cap.every((entry): entry is string => typeof entry === "string")) {
      throw new Error("Embedded execution did not receive its runtime tool cap.");
    }
    const allowed = createRuntimeToolMatcher(cap);
    expect(allowed("read")).toBe(false);
    expect(allowed("web_fetch")).toBe(false);
  });

  it("rejects a CLI backend that cannot enforce plugin-service execution authority", async () => {
    mockRunCronFallbackPassthrough();
    isCliProviderMock.mockReturnValue(true);
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionAuthority: {
          toolsAllow: ["web_fetch"],
          toolBindings: {},
          assertInvocationCurrent: () => {},
        },
      }),
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("cannot enforce plugin-service Cron execution authority"),
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
