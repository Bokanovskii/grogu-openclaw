import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGroguRuntimeFixture } from "./grogu-runtime.test-support.js";
import { assertResearchCheckpointCandidate } from "./research-checkpoint-guard.js";
import { createEditTool } from "./sessions/tools/edit.js";
import { createWriteTool } from "./sessions/tools/write.js";

const authority = vi.hoisted(() => ({ current: true }));
// mock-isolation: Keep the real process-wide source guard outside this authority fixture.
vi.mock("./agent-tool-source-execution-guard.js", () => ({
  captureAgentToolSourceExecutionGuard: (signal?: AbortSignal) => () => {
    signal?.throwIfAborted();
    if (!authority.current) {
      throw new Error("authority revoked");
    }
  },
}));
let f: ReturnType<typeof createGroguRuntimeFixture>;
beforeEach(() => {
  f = createGroguRuntimeFixture();
  authority.current = true;
  vi.stubEnv("GROGU_PROFILE_FILE", f.profileFile);
});
afterEach(() => {
  vi.unstubAllEnvs();
  f.cleanup();
});
const value = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    completedSlices: 1,
    nextTrack: "beta",
    lastCompletedTrack: "alpha",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastArtifact: "slices/report.json",
    ...overrides,
  });
const candidate = (
  content: string,
  filePath = path.join(f.workspace, "continuous-state.json"),
  mutationKey = filePath,
) => assertResearchCheckpointCandidate({ filePath, mutationKey, content });
function saveArtifact() {
  fs.mkdirSync(path.join(f.workspace, "slices"));
  fs.writeFileSync(path.join(f.workspace, "slices/report.json"), "{}");
}

describe("critical checkpoint mutation boundary", () => {
  it("validates write and edit before mutation and never recovers a validation failure as success", async () => {
    saveArtifact();
    const checkpoint = path.join(f.workspace, "continuous-state.json");
    await createWriteTool(f.workspace).execute(
      "write",
      { path: checkpoint, content: value() },
      undefined,
    );
    await expect(
      createEditTool(f.workspace).execute(
        "edit",
        {
          path: checkpoint,
          edits: [{ oldText: '"completedSlices":1', newText: '"completedSlices":-1' }],
        },
        undefined,
      ),
    ).rejects.toMatchObject({ name: "ResearchCheckpointValidationError" });
    expect(fs.readFileSync(checkpoint, "utf8")).toBe(value());
    await expect(
      createWriteTool(f.workspace).execute("write", { path: checkpoint, content: "{" }, undefined),
    ).rejects.toMatchObject({ code: "RESEARCH_CHECKPOINT_INVALID_JSON" });
    expect(fs.readFileSync(checkpoint, "utf8")).toBe(value());
  });

  it("uses exact native sandbox identity, not checkpoint basename or workspace prefix", async () => {
    await candidate("invalid JSON", path.join(f.directory, "continuous-state.json"));
    await expect(
      candidate(
        "invalid JSON",
        "/sandbox/continuous-state.json",
        `sandbox\0${path.join(f.workspace, "continuous-state.json")}`,
      ),
    ).rejects.toMatchObject({ code: "RESEARCH_CHECKPOINT_INVALID_JSON" });
    vi.stubEnv("GROGU_PROFILE_FILE", undefined);
    await candidate("invalid JSON");
  });

  it.each([
    { completedSlices: -1 },
    { completedSlices: 1.1 },
    { nextTrack: "unknown" },
    { tracks: ["alpha", "alpha"] },
    { updatedAt: "yesterday" },
    { currentSlice: { track: "unknown" } },
    { lastArtifact: null },
    { lastArtifact: "../outside.json" },
    { lastArtifact: "continuous-state.json" },
  ])("rejects invalid progress or unsafe artifact %#", async (override) => {
    await expect(candidate(value(override))).rejects.toMatchObject({
      name: "ResearchCheckpointValidationError",
    });
  });

  it.each(["missing", "directory", "symlink", "hardlink"])(
    "requires a saved regular artifact without %s escape",
    async (kind) => {
      fs.mkdirSync(path.join(f.workspace, "slices"));
      const artifact = path.join(f.workspace, "slices/report.json");
      const outside = path.join(f.directory, "outside.json");
      fs.writeFileSync(outside, "{}");
      if (kind === "directory") {
        fs.mkdirSync(artifact);
      }
      if (kind === "symlink") {
        fs.symlinkSync(outside, artifact);
      }
      if (kind === "hardlink") {
        fs.linkSync(outside, artifact);
      }
      await expect(candidate(value())).rejects.toMatchObject({
        code: "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
      });
    },
  );

  it("accepts the configured artifact prefix and rechecks authority after asynchronous artifact admission", async () => {
    saveArtifact();
    await candidate(value({ lastArtifact: "plans/synthetic/slices/report.json" }));
    const pending = candidate(value());
    authority.current = false;
    await expect(pending).rejects.toThrow(/authority revoked/);
  });
});
