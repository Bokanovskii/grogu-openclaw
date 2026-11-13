import { describe, expect, it } from "vitest";
import { pickLastNonEmptyTextFromPayloads, resolveCronPayloadOutcome } from "./helpers.js";

type TextPayload = { text?: string | undefined; isError?: boolean | undefined };

const textPayloadPickerCases: Array<{
  name: string;
  payloads: TextPayload[];
  expected: string | undefined;
}> = [
  {
    name: "last non-empty text picks real text over error payload",
    payloads: [{ text: "Real output" }, { text: "Service error", isError: true }],
    expected: "Real output",
  },
  {
    name: "last non-empty text falls back to error payload when no real text exists",
    payloads: [{ text: "Service error", isError: true }],
    expected: "Service error",
  },
  {
    name: "last non-empty text returns undefined for empty payloads",
    payloads: [],
    expected: undefined,
  },
];

describe("text payload pickers", () => {
  it.each(textPayloadPickerCases)("$name", ({ payloads, expected }) => {
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe(expected);
  });
});

describe("cron delivery outcomes", () => {
  it.each([
    { name: "quiet run", visible: [], expectedText: undefined, expectedKind: "empty" },
    {
      name: "owner update",
      visible: [{ text: "The delivery estimate changed." }],
      expectedText: "The delivery estimate changed.",
      expectedKind: "visible",
    },
    {
      name: "attachment",
      visible: [{ mediaUrl: "https://example.com/update.png" }],
      expectedText: undefined,
      expectedKind: "visible",
    },
  ] as const)(
    "excludes thinking from delivery and summaries for $name",
    ({ visible, expectedText, expectedKind }) => {
      const outcome = resolveCronPayloadOutcome({
        payloads: [{ text: "Private automation planning.", isReasoning: true }, ...visible],
        preferFinalAssistantVisibleText: false,
      });

      expect(outcome.deliveryPayloads).toEqual(visible);
      expect(outcome.outputText).toBe(expectedText);
      expect(outcome.summary).toBe(expectedText);
      expect(outcome.deliveryDisposition.kind).toBe(expectedKind);
      expect(JSON.stringify(outcome)).not.toContain("Private automation planning.");
    },
  );

  it("preserves a runtime failure when the only model payload is thinking", () => {
    const outcome = resolveCronPayloadOutcome({
      payloads: [{ text: "Private automation planning.", isReasoning: true }],
      runLevelError: "The automation runtime failed.",
    });

    expect(outcome.hasFatalErrorPayload).toBe(true);
    expect(outcome.deliveryPayloads).toEqual([
      { text: "cron isolated run failed: The automation runtime failed.", isError: true },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("Private automation planning.");
  });

  it("keeps NO_REPLY as a silent heartbeat acknowledgement", () => {
    expect(
      resolveCronPayloadOutcome({ payloads: [{ text: "NO_REPLY" }] }).deliveryDisposition,
    ).toEqual({ kind: "heartbeat", controlOnly: true });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});
