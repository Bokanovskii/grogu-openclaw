import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGroguPrivateProfile,
  parseGroguPrivateProfile,
  readGroguPrivateProfileDocument,
} from "./grogu-private-profile.js";
import { createGroguRuntimeFixture } from "./grogu-runtime.test-support.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
const fixture = () => {
  const result = createGroguRuntimeFixture();
  fixtures.push(result);
  return result;
};
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.splice(0).forEach((f) => f.cleanup());
});

describe("private runtime profile admission", () => {
  it("is opt-in and retains one immutable process generation shared with operator readers", () => {
    vi.stubEnv("GROGU_PROFILE_FILE", undefined);
    expect(loadGroguPrivateProfile()).toBeUndefined();
    const f = fixture();
    fs.writeFileSync(
      f.profileFile,
      JSON.stringify({ ...f.profile, operator: { gatewayPort: 12345 } }),
      { mode: 0o600 },
    );
    const document = readGroguPrivateProfileDocument(f.profileFile);
    expect(document?.operator).toEqual({ gatewayPort: 12345 });
    const profile = loadGroguPrivateProfile(f.profileFile);
    fs.writeFileSync(f.profileFile, "not JSON");
    expect(loadGroguPrivateProfile(f.profileFile)).toBe(profile);
    expect(readGroguPrivateProfileDocument(f.profileFile)).toBe(document);
    expect(Object.isFrozen(profile?.bindings.researchCheckpoint?.tracks)).toBe(true);
  });

  it.each(["relative.json", "", " /absolute.json"])(
    "rejects an explicitly unsafe selection %j",
    (value) => {
      expect(() => readGroguPrivateProfileDocument(value)).toThrow();
    },
  );

  it.each(["symlink", "hardlink", "permissions", "oversized", "schema"])(
    "rejects %s profiles",
    (kind) => {
      const f = fixture();
      let target = f.profileFile;
      if (kind === "symlink") {
        target = path.join(f.directory, "alias.json");
        fs.symlinkSync(f.profileFile, target);
      }
      if (kind === "hardlink") {
        fs.linkSync(f.profileFile, path.join(f.directory, "alias.json"));
      }
      if (kind === "permissions") {
        fs.chmodSync(f.profileFile, 0o644);
      }
      if (kind === "oversized") {
        fs.writeFileSync(f.profileFile, " ".repeat(1_048_577));
      }
      if (kind === "schema") {
        fs.writeFileSync(f.profileFile, '{"schemaVersion":2}');
      }
      expect(() => readGroguPrivateProfileDocument(target)).toThrow(/Cannot admit/);
    },
  );

  it.each([
    { workspace: "relative", tracks: ["alpha"] },
    { workspace: "/synthetic", tracks: [] },
    { workspace: "/synthetic", tracks: ["alpha", "alpha"] },
    { workspace: "/synthetic", tracks: [" alpha"] },
    { workspace: "/synthetic", tracks: ["alpha"], artifactPrefix: "../escape/" },
    { workspace: "/synthetic", tracks: ["alpha"], artifactPrefix: "/absolute/" },
  ])("rejects malformed checkpoint binding %#", (binding) => {
    expect(() =>
      parseGroguPrivateProfile({ schemaVersion: 1, bindings: { researchCheckpoint: binding } }),
    ).toThrow(/Invalid Grogu/);
  });
});
