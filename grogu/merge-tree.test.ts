import assert from "node:assert/strict";
import test from "node:test";
import { parseMergeTreeNameOnlyZ } from "./merge-tree.js";

test("reads a successful tree without depending on informational text", () => {
  assert.deepEqual(parseMergeTreeNameOnlyZ(`${"a".repeat(40)}\u0000`), {
    tree: "a".repeat(40),
    conflicts: [],
  });
});

test("stops conflict paths at the stable empty NUL field", () => {
  assert.deepEqual(
    parseMergeTreeNameOnlyZ(
      `${"b".repeat(40)}\u0000src/one.ts\u0000ui/two.ts\u0000\u00001\u0000src/one.ts\u0000Auto-merging\u0000`,
    ),
    {
      tree: "b".repeat(40),
      conflicts: ["src/one.ts", "ui/two.ts"],
    },
  );
});
