import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitReleaseManifest,
  createToolchainEnvironment,
  parsePackageMetadata,
  resolveToolchainPnpm,
} from "../../grogu/release.js";

const target = { platform: "darwin", arch: "arm64", node: "26.12.1" };
const manifest = {
  schemaVersion: 1,
  sourceCommit: "1".repeat(40),
  upstreamCommit: "2".repeat(40),
  packageVersion: "2026.10.7",
  node: target.node,
  pnpm: "12.15.0",
  platform: target.platform,
  arch: target.arch,
  stateSchemaVersion: 20,
  agentSchemaVersion: 25,
  updateAdmissionProtocol: 1,
  filename: "openclaw-synthetic.tgz",
  sha256: "3".repeat(64),
  rollbackCertified: false,
};

describe("immutable candidate admission", () => {
  it("maps the committed native nested schema metadata into the release manifest", () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(parsePackageMetadata(packageMetadata)).toMatchObject({
      version: packageMetadata.version,
      stateSchemaVersion: packageMetadata.openclaw.schemaVersions.state,
      agentSchemaVersion: packageMetadata.openclaw.schemaVersions.agent,
      updateAdmissionProtocol: packageMetadata.openclaw.updateAdmissionProtocol,
    });
    expect(() =>
      parsePackageMetadata({
        ...packageMetadata,
        openclaw: {
          stateSchemaVersion: 20,
          agentSchemaVersion: 25,
          updateAdmissionProtocol: 1,
        },
      }),
    ).toThrow();
  });

  it("admits the pnpm selected by the final child PATH, including a Node-bin shadow", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grogu-release-toolchain-"));
    const nodeBin = path.join(root, "node-bin");
    const pnpmBin = path.join(root, "pnpm-bin");
    mkdirSync(nodeBin);
    mkdirSync(pnpmBin);
    for (const directory of [nodeBin, pnpmBin]) {
      const binary = path.join(directory, "pnpm");
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o755);
    }
    try {
      const resolved = await resolveToolchainPnpm(path.join(nodeBin, "node"), {
        PATH: [pnpmBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      });
      expect(resolved.pnpmPath).toBe(path.join(nodeBin, "pnpm"));
      expect(resolved.environment.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
        nodeBin,
        nodeBin,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts selected Node and pnpm directories before inherited PATH entries", () => {
    const environment = createToolchainEnvironment(
      "/pinned/node/bin/node",
      "/pinned/pnpm/bin/pnpm",
      { PATH: "/system/bin" },
    );
    expect(environment.PATH?.split(":").slice(0, 3)).toEqual([
      "/pinned/node/bin",
      "/pinned/pnpm/bin",
      "/system/bin",
    ]);
  });

  it("refuses platform, architecture or Node skew even when numeric state schemas match", () => {
    expect(admitReleaseManifest(manifest, target).rollbackCertified).toBe(false);
    for (const incompatible of [
      { ...manifest, platform: "linux" },
      { ...manifest, arch: "x64" },
      { ...manifest, node: "26.12.2" },
      { ...manifest, rollbackCertified: true },
    ]) {
      expect(() => admitReleaseManifest(incompatible, target)).toThrow();
    }
  });

  it("rejects path traversal and incomplete artifact provenance", () => {
    for (const invalid of [
      { ...manifest, filename: "../openclaw.tgz" },
      { ...manifest, filename: "/openclaw.tgz" },
      { ...manifest, sha256: "" },
      { ...manifest, sourceCommit: "main" },
    ]) {
      expect(() => admitReleaseManifest(invalid, target)).toThrow();
    }
  });
});
