import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ProtectedShareSnapshotSchema } from "./protected-shares.js";

describe("protected share snapshot contract", () => {
  it("does not include live active-run state in chat copies", () => {
    const snapshot = {
      kind: "chat",
      title: "Shared conversation",
      chat: {
        id: "chat-1",
        title: "Shared conversation",
        version: "v1",
        updatedAt: 1,
        messages: [],
      },
    };

    expect(Value.Check(ProtectedShareSnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(ProtectedShareSnapshotSchema, {
        ...snapshot,
        chat: { ...snapshot.chat, activeRun: { id: "run-1" } },
      }),
    ).toBe(false);
  });
});
