import { describe, expect, it } from "vitest";
import { compareStableRelease } from "../../grogu/upstream.js";

const release = (tag: string) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: "https://github.com/openclaw/openclaw/releases",
});

describe("stable upstream admission", () => {
  it("compares calendar versions numerically, never by publication date or lexically", () => {
    expect(compareStableRelease("v2026.9.30", release("v2026.10.7")).newer).toBe(true);
    expect(compareStableRelease("v2026.10.7", release("v2026.10.7")).newer).toBe(false);
    expect(compareStableRelease("v2026.10.7", release("v2026.9.30")).newer).toBe(false);
  });

  it("refuses drafts, prereleases and malformed or missing latest-release identities", () => {
    for (const candidate of [
      { ...release("v2026.10.8"), draft: true },
      { ...release("v2026.10.8"), prerelease: true },
      release("v2026.10.8-beta.1"),
      release(""),
      null,
      undefined,
    ]) {
      expect(() => compareStableRelease("v2026.10.7", candidate)).toThrow();
    }
  });
});
