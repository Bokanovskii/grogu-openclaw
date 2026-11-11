import { lstatSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { root as safeRoot } from "@openclaw/fs-safe";
import { z } from "zod";
import { withFileLock } from "../src/infra/file-lock.js";
import { isPathInside } from "../src/infra/path-guards.js";
import type { OperatorProfile } from "./operator.js";

export const TEMPORARY_ARTIFACT_LIFETIME_MS = 24 * 60 * 60_000;

const artifactDirectory = /^\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}$/;
const archiveReceipt = z.object({
  verified: z.literal(true),
  archivePath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const releaseReceipt = z.object({
  filename: z.string().regex(/^openclaw-[a-zA-Z0-9._-]+\.tgz$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const failedReleaseReceipt = z.object({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
const maintenanceReceipt = z.object({
  schemaVersion: z.literal(1),
  operation: z.enum(["storage-bootstrap", "storage-cleanup"]),
  completed: z.literal(true),
});

export type ArtifactCleanupResult = {
  eligible: string[];
  removed: string[];
  protected: { path: string; reason: string }[];
};

/** Builders, archive readers, and cleanup share one installation-scoped lock. */
export async function withGroguStorageLock<T>(
  profile: OperatorProfile,
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  return withFileLock(
    profile.profileFile,
    {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 0,
      staleRecovery: "remove-if-definitely-stale",
    },
    async () => {
      const lockPath = `${await realpath(profile.profileFile)}.lock`;
      const identity = lstatSync(lockPath);
      const assertCurrent = () => {
        const current = lstatSync(lockPath);
        if (
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        ) {
          throw new Error("Grogu storage maintenance lost its lock; no more files will be removed");
        }
      };
      return run(assertCurrent);
    },
  );
}

export async function cleanupGroguArtifacts(
  profile: OperatorProfile,
  options: { apply: boolean; assertCurrent: () => void },
): Promise<ArtifactCleanupResult> {
  const result: ArtifactCleanupResult = { eligible: [], removed: [], protected: [] };
  const now = Date.now();
  for (const [directory, kind] of [
    [profile.recoveryDir, "backup"],
    [profile.releasesDir, "release"],
  ] as const) {
    let identity;
    try {
      identity = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      (process.getuid && identity.uid !== process.getuid()) ||
      (identity.mode & 0o077) !== 0
    ) {
      throw new Error(
        `Storage cleanup requires an owner-only, non-aliased directory: ${directory}`,
      );
    }
    const root = await safeRoot(directory, {
      symlinks: "reject",
      hardlinks: "reject",
      assertBeforeMutation: options.assertCurrent,
    });
    for (const name of await root.list(".")) {
      if (!artifactDirectory.test(name)) {
        continue;
      }
      const candidate = path.join(directory, name);
      const protectedPaths = [
        profile.runtime.cli,
        profile.runtime.node,
        profile.stateDir,
        profile.configFile,
        profile.oauthDir,
        profile.profileFile,
        process.cwd(),
      ];
      if (
        protectedPaths.some((file) => isPathInside(candidate, file)) ||
        isPathInside(profile.stateDir, candidate)
      ) {
        result.protected.push({ path: candidate, reason: "live-installation-or-state" });
        continue;
      }
      const entry = await root.stat(name);
      if (!entry.isDirectory) {
        result.protected.push({ path: candidate, reason: "not-an-artifact-directory" });
        continue;
      }
      const files = await root.list(name);
      const maintenance = kind === "backup" && files.includes("storage-maintenance.json");
      const failedRelease =
        kind === "release" &&
        !files.includes("release-manifest.json") &&
        files.includes("release-build-failed.json");
      const receiptName = maintenance
        ? "storage-maintenance.json"
        : kind === "backup"
          ? "backup-provenance.json"
          : failedRelease
            ? "release-build-failed.json"
            : "release-manifest.json";
      if (!files.includes(receiptName)) {
        result.protected.push({ path: candidate, reason: "no-completed-artifact-receipt" });
        continue;
      }
      const raw = await root.readJson(path.join(name, receiptName), { maxBytes: 64 * 1024 });
      let payload: string;
      let allowed: (file: string) => boolean;
      if (maintenance) {
        maintenanceReceipt.parse(raw);
        allowed = (file) => file === receiptName || /^native-[a-f0-9-]+\.json$/.test(file);
      } else if (kind === "backup") {
        const receipt = archiveReceipt.parse(raw);
        payload = path.basename(receipt.archivePath);
        if (
          path.resolve(receipt.archivePath) !== path.join(path.resolve(candidate), payload) ||
          !payload.endsWith("-openclaw-backup.tar.gz")
        ) {
          throw new Error(`Backup receipt does not identify a local archive: ${candidate}`);
        }
        allowed = (file) =>
          [payload, receiptName].includes(file) || /^native-[a-f0-9-]+\.json$/.test(file);
      } else if (failedRelease) {
        const receipt = failedReleaseReceipt.parse(raw);
        const packageName = new RegExp(
          `^openclaw-${receipt.sourceCommit}-(darwin|linux)-(arm64|x64)\\.tgz$`,
        );
        allowed = (file) =>
          [receiptName, "release-build-output.json"].includes(file) || packageName.test(file);
      } else {
        payload = releaseReceipt.parse(raw).filename;
        allowed = (file) =>
          [payload, receiptName, "release-build-output.json"].includes(file) ||
          /^native-[a-f0-9-]+\.json$/.test(file);
      }
      if (files.some((file) => !allowed(file))) {
        result.protected.push({ path: candidate, reason: "unrecognized-artifact-content" });
        continue;
      }
      let lastWrite = entry.mtimeMs;
      for (const file of files) {
        const stat = await root.stat(path.join(name, file));
        if (!stat.isFile || stat.nlink !== 1) {
          throw new Error(`Artifact contains an aliased or nonregular file: ${candidate}`);
        }
        lastWrite = Math.max(lastWrite, stat.mtimeMs);
      }
      if (now - lastWrite < TEMPORARY_ARTIFACT_LIFETIME_MS) {
        result.protected.push({ path: candidate, reason: "temporary-artifact-within-24-hours" });
        continue;
      }
      options.assertCurrent();
      result.eligible.push(candidate);
      if (options.apply) {
        await root.remove(name, { recursive: true, maxDepth: 1, maxEntries: 1000 });
        result.removed.push(candidate);
      }
    }
  }
  return result;
}
