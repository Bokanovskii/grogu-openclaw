import { mkdirSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflowSource } from "./workflow-source.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workflowFixture() {
  const root = tempDirs.make("openclaw-workflow-source-");
  const active = path.join(root, ".github/workflows");
  const archive = path.join(root, ".github/upstream-workflows");
  mkdirSync(active, { recursive: true });
  mkdirSync(archive);
  return { active, archive };
}

describe("workflow fixture source", () => {
  it.each([
    { active: true, archived: false, expected: "active definition\n" },
    { active: false, archived: true, expected: "archived definition\n" },
  ])("reads the maintained definition ($active, $archived)", (entry) => {
    const { active, archive } = workflowFixture();
    if (entry.active) {
      writeFileSync(path.join(active, "ci.yml"), "active definition\n");
    }
    if (entry.archived) {
      writeFileSync(path.join(archive, "ci.yml"), "archived definition\n");
    }
    expect(readWorkflowSource(path.join(active, "ci.yml"))).toEqual(Buffer.from(entry.expected));
  });

  it("preserves exact archived bytes for policy hashing", () => {
    const { active, archive } = workflowFixture();
    const bytes = Buffer.from([0xff, 0x00, 0x80, 0x0a]);
    writeFileSync(path.join(archive, "plugin-npm-release.yml"), bytes);
    expect(readWorkflowSource(path.join(active, "plugin-npm-release.yml"))).toEqual(bytes);
  });

  it("refuses competing active and archived definitions", () => {
    const { active, archive } = workflowFixture();
    writeFileSync(path.join(active, "ci.yml"), "active definition\n");
    writeFileSync(path.join(archive, "ci.yml"), "archived definition\n");
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow(
      "competing active and archived workflow definitions",
    );
  });

  it("fails explicitly when neither definition exists", () => {
    const { active, archive } = workflowFixture();
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow(
      path.join(archive, "ci.yml"),
    );
  });

  it.skipIf(process.platform === "win32")("refuses a dangling archived symlink", () => {
    const { active, archive } = workflowFixture();
    writeFileSync(path.join(active, "ci.yml"), "active definition\n");
    symlinkSync("missing.yml", path.join(archive, "ci.yml"));
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow(
      "competing active and archived workflow definitions",
    );
  });

  it.skipIf(process.platform === "win32")("refuses a dangling active entry", () => {
    const { active, archive } = workflowFixture();
    symlinkSync("missing.yml", path.join(active, "ci.yml"));
    writeFileSync(path.join(archive, "ci.yml"), "archived definition\n");
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow(
      new Error(
        `Resolve unreadable active workflow entry before using its archive: ${path.join(active, "ci.yml")}`,
      ),
    );
  });

  it("preserves archive inspection errors instead of treating them as absence", () => {
    const { active, archive } = workflowFixture();
    writeFileSync(path.join(active, "ci.yml"), "active definition\n");
    rmdirSync(archive);
    writeFileSync(archive, "not a directory");
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("does not hide an invalid active path with an archived definition", () => {
    const { active, archive } = workflowFixture();
    mkdirSync(path.join(active, "ci.yml"));
    writeFileSync(path.join(archive, "ci.yml"), "archived definition\n");
    expect(() => readWorkflowSource(path.join(active, "ci.yml"))).toThrow();
  });

  it("does not substitute an archive for a missing action definition", () => {
    const { active, archive } = workflowFixture();
    const action = path.join(active, "../actions/fixture/action.yml");
    writeFileSync(path.join(archive, "action.yml"), "unrelated archived definition\n");
    expect(() => readWorkflowSource(action)).toThrow(action);
  });
});
