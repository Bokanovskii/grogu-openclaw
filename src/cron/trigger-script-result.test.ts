import { describe, expect, it } from "vitest";
import { parseTriggerResult } from "./trigger-script-result.js";

describe("parseTriggerResult worker source failures", () => {
  it("prefers an explicit returned trigger result over logged JSON errors", () => {
    expect(
      parseTriggerResult({
        status: "completed",
        value: { fire: false, state: { cursor: "stable" } },
        output: [
          {
            type: "json",
            value: { error: { kind: "transient" } },
          },
        ],
      } as never),
    ).toEqual({
      kind: "evaluated",
      fire: false,
      state: { cursor: "stable" },
    });
  });

  it.each(["transient", "timeout", "network", "incomplete", "unavailable"])(
    "keeps %s failures retryable",
    (kind) => {
      expect(
        parseTriggerResult({
          status: "completed",
          value: { error: { kind } },
          output: [],
        } as never),
      ).toEqual({
        kind: "error",
        code: "timeout",
        error: "worker source temporarily unavailable",
      });
    },
  );

  it.each(["auth", "permission", "config", "schema"])("keeps %s failures permanent", (kind) => {
    expect(
      parseTriggerResult({
        status: "completed",
        value: { error: { kind } },
        output: [],
      } as never),
    ).toEqual({
      kind: "error",
      code: "invalid_input",
      error: `worker source ${kind} failure`,
      sourceFailureKind: kind,
    });
  });
});
