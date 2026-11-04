import { describe, expect, it } from "vitest";
import { parseMergeTreeNameOnlyZ } from "./merge-tree.js";

describe("parseMergeTreeNameOnlyZ", () => {
  it("reads a successful tree without depending on informational text", () => {
    expect(parseMergeTreeNameOnlyZ(`${"a".repeat(40)}\u0000`)).toEqual({
      tree: "a".repeat(40),
      conflicts: [],
    });
  });

  it("stops conflict paths at the stable empty NUL field", () => {
    expect(
      parseMergeTreeNameOnlyZ(
        `${"b".repeat(40)}\u0000src/one.ts\u0000ui/two.ts\u0000\u00001\u0000src/one.ts\u0000Auto-merging\u0000`,
      ),
    ).toEqual({
      tree: "b".repeat(40),
      conflicts: ["src/one.ts", "ui/two.ts"],
    });
  });
});
