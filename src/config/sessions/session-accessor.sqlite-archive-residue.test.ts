import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { inspectSqliteTranscriptArchiveResidue } from "./session-accessor.sqlite-archive-artifact.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("SQLite transcript archive residue metadata", () => {
  it("reports interrupted-looking raw, compressed, ciphertext, and unattributed stages as unknown", async () => {
    const archiveRoot = tempDirs.make("openclaw-archive-residue-");
    const coldRoot = path.join(archiveRoot, "cold");
    fs.mkdirSync(coldRoot);
    const archiveNames = [
      "session.jsonl.deleted.2026-09-02T10-00-00.000Z.generation.jsonl-stage",
      "session.jsonl.deleted.2026-09-02T10-00-00.000Z.generation.zst.random.stage",
      "session.jsonl.deleted.2026-09-02T10-00-00.000Z.zst.random.tmp",
      "protected-ciphertext-looking.random.tmp",
      "unattributed.random.tmp",
    ];
    const coldNames = ["cold-raw.random.tmp", "cold-compressed.random.tmp.zst"];
    for (const name of archiveNames) {
      fs.writeFileSync(path.join(archiveRoot, name), "synthetic payload");
    }
    for (const name of coldNames) {
      fs.writeFileSync(path.join(coldRoot, name), Buffer.from([0, 1, 2]));
    }
    const readFileSync = vi.spyOn(fs, "readFileSync");

    const report = await inspectSqliteTranscriptArchiveResidue([archiveRoot, coldRoot]);

    expect(report.writerQuiescence).toBe("not-established");
    expect(report.candidates.map(({ root, name }) => path.join(root, name)).toSorted()).toEqual(
      [
        ...archiveNames.map((name) => path.join(archiveRoot, name)),
        ...coldNames.map((name) => path.join(coldRoot, name)),
      ].toSorted(),
    );
    expect(report.candidates.every(({ status }) => status === "unknown")).toBe(true);
    expect(report.candidates.every(({ metadata }) => metadata?.kind === "file")).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.races).toEqual([]);
    expect(report.truncations).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("reports root aliases and does not follow a candidate symlink", async () => {
    const root = tempDirs.make("openclaw-archive-residue-root-");
    const outside = tempDirs.make("openclaw-archive-residue-outside-");
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(root, alias, linkType);
    fs.symlinkSync(outside, path.join(root, "linked.tmp"), linkType);

    const report = await inspectSqliteTranscriptArchiveResidue([root, alias]);

    expect(report.candidates).toEqual([
      expect.objectContaining({
        root,
        name: "linked.tmp",
        status: "unknown",
        metadata: expect.objectContaining({ kind: "symlink" }),
      }),
    ]);
    expect(report.aliases).toContainEqual(
      expect.objectContaining({
        root: alias,
        reason: "duplicate-physical-root",
        aliasOf: root,
      }),
    );
    expect(report.errors).toEqual([]);
    expect(report.races).toEqual([]);
  });

  it("reports a stage that disappears during safe metadata enumeration", async () => {
    const root = tempDirs.make("openclaw-archive-residue-race-");
    const candidatePath = path.join(root, "disappeared.tmp");
    fs.writeFileSync(candidatePath, "synthetic payload");
    const failure = Object.assign(new Error("entry disappeared"), { code: "ENOENT" });
    const lstatSync = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((filePath) => {
      if (path.basename(filePath.toString()) === path.basename(candidatePath)) {
        throw failure;
      }
      return lstatSync(filePath);
    });

    const report = await inspectSqliteTranscriptArchiveResidue([root]);

    expect(report.candidates).toEqual([]);
    expect(report.races).toContainEqual({
      root,
      operation: "directory-enumeration",
      code: "path-mismatch",
    });
    expect(report.errors).toEqual([]);
  });

  it("reports bounded entry enumeration as truncated", async () => {
    const root = tempDirs.make("openclaw-archive-residue-truncated-");
    for (let index = 0; index < 513; index += 1) {
      fs.writeFileSync(path.join(root, `entry-${index}.data`), "");
    }

    const report = await inspectSqliteTranscriptArchiveResidue([root]);

    expect(report.scannedEntries).toBe(512);
    expect(report.truncations).toEqual([{ root, limit: "entries-per-root" }]);
  });

  it("reports roots that cannot be resolved", async () => {
    const missingRoot = path.join(tempDirs.make("openclaw-archive-residue-missing-"), "absent");

    const report = await inspectSqliteTranscriptArchiveResidue([missingRoot]);

    expect(report.candidates).toEqual([]);
    expect(report.errors).toEqual([{ root: missingRoot, operation: "open", code: "not-found" }]);
  });
});
