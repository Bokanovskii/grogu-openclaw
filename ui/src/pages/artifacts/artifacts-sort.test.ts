import { describe, expect, it } from "vitest";
import { formatArtifactSize, sortArtifactEntries } from "./artifacts-sort.ts";

const entries = [
  { path: "b.md", name: "b.md", kind: "file" as const, size: 10, updatedAtMs: 300 },
  { path: "research", name: "research", kind: "directory" as const, updatedAtMs: 100 },
  { path: "a.md", name: "a.md", kind: "file" as const, size: 10, updatedAtMs: 200 },
  { path: "plans", name: "plans", kind: "directory" as const, updatedAtMs: 400 },
];

describe("sortArtifactEntries", () => {
  it("lists folders first, then newest files when sorting by recent", () => {
    expect(sortArtifactEntries(entries, "recent").map((e) => e.name)).toEqual([
      "plans",
      "research",
      "b.md",
      "a.md",
    ]);
  });

  it("sorts alphabetically within folders and files by name", () => {
    expect(sortArtifactEntries(entries, "name").map((e) => e.name)).toEqual([
      "plans",
      "research",
      "a.md",
      "b.md",
    ]);
  });
});

describe("formatArtifactSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatArtifactSize(512)).toBe("512 B");
    expect(formatArtifactSize(2048)).toBe("2.0 KB");
    expect(formatArtifactSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
