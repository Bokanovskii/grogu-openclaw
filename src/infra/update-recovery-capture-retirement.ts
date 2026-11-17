import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { capturePathRemovalGuard, removePathWithinRoot } from "./fs-safe-remove.js";
import { root as safeRoot } from "./fs-safe.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { withRecoveryMetadata } from "./update-recovery-backup-reader.js";
import { standaloneDoctorCaptureId } from "./update-recovery-doctor-completion-contract.js";
import { canonicalEntryPath } from "./update-recovery-path.js";
import { recordedUpdateRunDrivers } from "./update-run-activity.js";
import { inspectUpdateRunDriver, sameUpdateRunDriver } from "./update-run-driver.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type CaptureRetirementResult = {
  eligible: string[];
  retired: string[];
  protected: { path: string; reason: string }[];
  warnings: string[];
};

async function readCaptureRetirementRun(
  env: NodeJS.ProcessEnv,
  runId: string,
  assertCurrent: () => void,
): Promise<UpdateRunRecord | undefined> {
  assertCurrent();
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      { env },
      { type: "updateRecoveryRetirement.read", input: { runId } },
      { current: true, preferIndependentWarmRead: true },
    ),
  );
  assertCurrent();
  if (!reply?.ok || reply.type !== "updateRecoveryRetirement.read") {
    throw new Error("Authoritative update history is unavailable.");
  }
  if (reply.activeRun || reply.pendingRecovery) {
    throw new Error("Update/repair work remains unfinished.");
  }
  return reply.run;
}

function isCompletedCaptureRun(
  run: UpdateRunRecord | undefined,
  retireSettledManualCopies: boolean,
): boolean {
  return Boolean(
    run &&
    run.phase === "finished" &&
    run.finishedAtMs !== null &&
    (run.status === "succeeded" ||
      (retireSettledManualCopies &&
        run.status === "failed" &&
        !run.origin.updateRecoveryCapture &&
        run.verification.recovery?.serviceRestartSafe === true)),
  );
}

/** Recorded settlement is evidence; the native executor supplies current deletion authority. */
export async function retireCompletedUpdateRecoveryCaptures(params: {
  env: NodeJS.ProcessEnv;
  apply: boolean;
  minimumAgeMs: number;
  retireSettledManualCopies?: { installRoot: string };
}): Promise<CaptureRetirementResult> {
  if (typeof params.apply !== "boolean") {
    throw new TypeError("Capture retirement requires an explicit apply boolean.");
  }
  if (!Number.isFinite(params.minimumAgeMs) || params.minimumAgeMs < 0) {
    throw new RangeError("Capture retirement minimumAgeMs must be finite and nonnegative.");
  }
  const { apply, minimumAgeMs, retireSettledManualCopies } = params;
  const result: CaptureRetirementResult = {
    eligible: [],
    retired: [],
    protected: [],
    warnings: [],
  };
  const env = { ...params.env };
  const stateDir = resolvePathViaExistingAncestorSync(resolveStateDir(env));
  const root = resolveUpdateCaptureRoot(stateDir);
  const configPath = canonicalEntryPath(resolveConfigPath(env));
  const assertPrivateDirectory = async (directory: string) => {
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid !== undefined && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("Capture directory ownership or permissions are unverified.");
    }
    const source = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
    if (
      (await source.readText(UPDATE_CAPTURE_PRIVACY_MARKER, { maxBytes: 128 })) !==
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT
    ) {
      throw new Error("Capture privacy marker is unverified.");
    }
  };
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      result.warnings.push(`Update capture cleanup unavailable: ${formatErrorMessage(error)}`);
    }
    return result;
  }
  try {
    await assertPrivateDirectory(root);
  } catch (error) {
    result.protected.push({ path: root, reason: formatErrorMessage(error) });
    return result;
  }
  const rootPin = await pinDirectory(root);
  const rootGuard = capturePathRemovalGuard(root);
  const retire = async (
    directory: string,
    pin: Awaited<ReturnType<typeof pinDirectory>>,
    assertCurrent: () => void,
    inspect: () => Promise<void>,
  ) => {
    await inspect();
    await rootPin.assertCurrent();
    await pin.assertCurrent();
    const guard = capturePathRemovalGuard(directory);
    if (!guard) {
      throw new Error("Capture disappeared before retirement.");
    }
    await inspect();
    result.eligible.push(directory);
    if (apply) {
      await removePathWithinRoot({
        rootDir: root,
        relativePath: path.basename(directory),
        recursive: true,
        force: false,
        assertBeforeMutation: () => {
          assertCurrent();
          rootGuard?.();
          guard();
        },
      });
      result.retired.push(directory);
    }
  };
  try {
    for (const name of names.toSorted()) {
      if (name === UPDATE_CAPTURE_PRIVACY_MARKER || name === ".DS_Store") {
        continue;
      }
      const directory = path.join(root, name);
      try {
        await rootPin.assertCurrent();
        await assertPrivateDirectory(directory);
        const manifestEntry = await fs
          .lstat(path.join(directory, "manifest.json"))
          .catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return undefined;
            }
            throw error;
          });
        // An unsealed original cannot be restored. Its run still owns writer settlement.
        if (!manifestEntry && retireSettledManualCopies) {
          const pin = await pinDirectory(directory);
          try {
            await withUpdateCommandExecutor(`capture-cleanup-${randomUUID()}`, async (executor) => {
              const fence = await executor.enter(retireSettledManualCopies.installRoot);
              await retire(directory, pin, fence.assertCurrent, async () => {
                const run = await readCaptureRetirementRun(env, name, fence.assertCurrent);
                if (
                  !run ||
                  !isCompletedCaptureRun(run, true) ||
                  run.origin.updateRecoveryCapture ||
                  run.steps.some((step) => step.step === "driver:identity-unavailable")
                ) {
                  throw new Error("Unsealed capture has no settled, unreferenced update owner.");
                }
                const drivers = recordedUpdateRunDrivers(run);
                if (
                  !drivers.length ||
                  drivers.some((driver) => inspectUpdateRunDriver(driver) !== "dead")
                ) {
                  throw new Error("Unsealed capture writer settlement is unverified.");
                }
                const completedAtMs = run.finishedAtMs;
                if (
                  typeof completedAtMs !== "number" ||
                  !Number.isFinite(completedAtMs) ||
                  completedAtMs > Date.now()
                ) {
                  throw new Error("Capture completion time is unverified.");
                }
                const source = await safeRoot(directory, {
                  symlinks: "reject",
                  hardlinks: "reject",
                });
                const allowed = new Set([
                  UPDATE_CAPTURE_PRIVACY_MARKER,
                  ".DS_Store",
                  "payload",
                  "database.databases",
                ]);
                if ((await source.list(".")).some((entry) => !allowed.has(entry))) {
                  throw new Error("Unsealed capture contains unrecognized recovery artifacts.");
                }
                let latestWriteMs = completedAtMs;
                const pending = ["."];
                for (const relativePath of pending) {
                  const stat = await source.stat(relativePath);
                  if (
                    stat.isSymbolicLink ||
                    (!stat.isDirectory && !stat.isFile) ||
                    (stat.isFile && stat.nlink !== 1) ||
                    !Number.isFinite(stat.mtimeMs)
                  ) {
                    throw new Error("Capture write history is unverified.");
                  }
                  const parts = relativePath.split(path.sep);
                  const metadata =
                    relativePath === UPDATE_CAPTURE_PRIVACY_MARKER || relativePath === ".DS_Store";
                  const payload =
                    parts.length === 2 &&
                    parts[0] === "payload" &&
                    /^(0|[1-9]\d*)$/u.test(parts[1] ?? "");
                  const staging = parts[0] === "database.databases";
                  if (
                    stat.isFile
                      ? (!metadata && !payload) ||
                        (relativePath !== ".DS_Store" && Math.floor(stat.mtimeMs) > completedAtMs)
                      : relativePath !== "." && relativePath !== "payload" && !staging
                  ) {
                    throw new Error("Unsealed capture has unfinished or unrecognized content.");
                  }
                  latestWriteMs = Math.max(latestWriteMs, stat.mtimeMs);
                  if (stat.isDirectory) {
                    for (const entry of await source.list(relativePath)) {
                      pending.push(path.join(relativePath, entry));
                    }
                  }
                }
                fence.assertCurrent();
                if (Date.now() - latestWriteMs < minimumAgeMs) {
                  throw new Error("Capture remains within the requested recovery window.");
                }
              });
            });
          } finally {
            await pin.close();
          }
          continue;
        }
        await withRecoveryMetadata(
          { directory, manifestPath: path.join(directory, "manifest.json") },
          async ({ manifest, ref, outcome, pin }) => {
            if (
              manifest.runId !== name ||
              manifest.schemaVersion !== 2 ||
              manifest.generation?.kind !== "baseline" ||
              manifest.stateDir !== stateDir ||
              manifest.configPath !== configPath
            ) {
              throw new Error("Capture identity does not match the selected original state.");
            }
            const allowed = new Set([
              UPDATE_CAPTURE_PRIVACY_MARKER,
              "manifest.json",
              "outcome.json",
              "payload",
              "database.databases",
              ".DS_Store",
            ]);
            const entries = await fs.readdir(directory);
            if (entries.some((entry) => !allowed.has(entry))) {
              throw new Error(
                "Capture has later generations, retained code, or unrecognized artifacts.",
              );
            }
            // Backup workers set XDG_CACHE_HOME to their staging directory. SQLite's
            // cache owner can leave this empty parent after retiring its scratch.
            const drainedDatabaseDirectories = new Set([
              "database.databases",
              path.join("database.databases", "openclaw"),
            ]);
            if (entries.includes("database.databases")) {
              const { buildBackupArchivePath } = await import("../commands/backup-shared.js");
              for (const entry of manifest.entries) {
                if (entry.kind !== "file" || !entry.sqlite) {
                  continue;
                }
                let parent = path.join(
                  "database.databases",
                  path.posix.dirname(buildBackupArchivePath("", entry.sourcePath)),
                );
                while (parent !== "database.databases") {
                  drainedDatabaseDirectories.add(parent);
                  parent = path.dirname(parent);
                }
              }
            }
            await withUpdateCommandExecutor(`capture-cleanup-${randomUUID()}`, async (executor) => {
              const fence = await executor.enter(manifest.installRoot);
              const inspect = async () => {
                const run = await readCaptureRetirementRun(env, name, fence.assertCurrent);
                const doctorCompletion = outcome?.doctorCompletion;
                const standalone = standaloneDoctorCaptureId.test(name);
                if (
                  standalone
                    ? run !== undefined ||
                      !doctorCompletion ||
                      doctorCompletion.manifestSha256 !== ref.manifestSha256 ||
                      !sameUpdateRunDriver(doctorCompletion.driver, manifest.creator) ||
                      doctorCompletion.completedAtMs < Date.parse(manifest.createdAt) ||
                      doctorCompletion.completedAtMs > Date.now()
                    : !isCompletedCaptureRun(
                        run,
                        retireSettledManualCopies !== undefined && outcome === undefined,
                      )
                ) {
                  throw new Error(
                    "Update completion is unverified or update/repair work remains unfinished.",
                  );
                }
                const capture = run?.origin.updateRecoveryCapture;
                const drivers = run
                  ? recordedUpdateRunDrivers(run)
                  : doctorCompletion
                    ? [doctorCompletion.driver]
                    : [];
                if (
                  (capture &&
                    (capture.manifestSha256 !== ref.manifestSha256 ||
                      capture.status === "restore-failed" ||
                      capture.restored ||
                      capture.forwardResolution)) ||
                  (!standalone && doctorCompletion !== undefined) ||
                  (outcome && (outcome.status !== "committed" || outcome.error)) ||
                  !manifest.drivers.length ||
                  !drivers.length ||
                  !manifest.drivers.every((driver) =>
                    drivers.some((recorded) => sameUpdateRunDriver(recorded, driver)),
                  ) ||
                  [manifest.creator, ...manifest.drivers, ...drivers].some(
                    (driver) => inspectUpdateRunDriver(driver) !== "dead",
                  )
                ) {
                  throw new Error(
                    "Capture outcome or originating process settlement is unverified.",
                  );
                }
                const completedAtMs = standalone
                  ? doctorCompletion?.completedAtMs
                  : run?.finishedAtMs;
                if (
                  typeof completedAtMs !== "number" ||
                  !Number.isFinite(completedAtMs) ||
                  completedAtMs < Date.parse(manifest.createdAt) ||
                  completedAtMs > Date.now()
                ) {
                  throw new Error("Capture completion time is unverified.");
                }
                const source = await safeRoot(directory, {
                  symlinks: "reject",
                  hardlinks: "reject",
                });
                let latestWriteMs = completedAtMs;
                const pending = ["."];
                for (const relativePath of pending) {
                  const stat = await source.stat(relativePath);
                  if (
                    (relativePath === "database.databases" ||
                      relativePath.startsWith(`database.databases${path.sep}`)) &&
                    (!stat.isDirectory || !drainedDatabaseDirectories.has(relativePath))
                  ) {
                    throw new Error(
                      `Capture has unfinished or unrecognized database staging: ${relativePath}`,
                    );
                  }
                  if (
                    stat.isSymbolicLink ||
                    (!stat.isDirectory && !stat.isFile) ||
                    (relativePath === ".DS_Store" && !stat.isFile) ||
                    (stat.isFile && stat.nlink !== 1) ||
                    !Number.isFinite(stat.mtimeMs)
                  ) {
                    throw new Error("Capture write history is unverified.");
                  }
                  latestWriteMs = Math.max(latestWriteMs, stat.mtimeMs);
                  if (stat.isDirectory) {
                    for (const entry of await source.list(relativePath, { withFileTypes: true })) {
                      pending.push(path.join(relativePath, entry.name));
                    }
                  }
                }
                fence.assertCurrent();
                if (Date.now() - latestWriteMs < minimumAgeMs) {
                  throw new Error("Capture remains within the requested recovery window.");
                }
              };
              await retire(directory, pin, fence.assertCurrent, inspect);
            });
          },
        );
      } catch (error) {
        result.protected.push({ path: directory, reason: formatErrorMessage(error) });
      }
    }
  } finally {
    await rootPin.close();
  }
  return result;
}
