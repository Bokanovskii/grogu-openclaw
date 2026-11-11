import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import { z } from "zod";
import {
  CronAddResultSchema,
  CronJobSchema,
} from "../packages/gateway-protocol/src/schema/cron.js";
import type { CronJob, CronAddParams } from "../packages/gateway-protocol/src/schema/cron.types.js";
import {
  backupScheduleModeForDeclaration,
  isScheduledBackupCommand,
} from "../src/cron/backup-command.js";
import { retireCompletedUpdateRecoveryCaptures } from "../src/infra/update-recovery-capture-retirement.js";
import {
  callNative,
  createPrivateArtifactDirectory,
  listNativeJobs,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";
import {
  cleanupGroguArtifacts,
  TEMPORARY_ARTIFACT_LIFETIME_MS,
  withGroguStorageLock,
} from "./storage-artifacts.js";

const STORAGE_CLEANUP_DECLARATION = "grogu-storage-cleanup-v1";
const LEGACY_BACKUP_MARKER = "GROGU_BACKUP_OBSERVABILITY_V1";
const execute = promisify(execFile);
const storageConfigSchema = z
  .object({
    valid: z.literal(true),
    runtimeConfig: z
      .object({
        cron: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
        storage: z
          .object({
            locations: z
              .record(z.string(), z.object({ provider: z.string() }).passthrough())
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

function localFullBackupJobs(
  jobs: readonly CronJob[],
  filesystemLocations: ReadonlySet<string>,
): CronJob[] {
  return jobs.filter((job) => {
    if (job.payload.kind === "agentTurn") {
      return job.payload.message.includes(LEGACY_BACKUP_MARKER);
    }
    if (
      job.payload.kind !== "command" ||
      backupScheduleModeForDeclaration(job.declarationKey) !== "offsite" ||
      !isScheduledBackupCommand(job)
    ) {
      return false;
    }
    const locationFlag = job.payload.argv.indexOf("--to");
    const location = locationFlag === -1 ? undefined : job.payload.argv[locationFlag + 1];
    return location !== undefined && filesystemLocations.has(location);
  });
}

function storageCleanupJob(profile: OperatorProfile): CronAddParams {
  return {
    declarationKey: STORAGE_CLEANUP_DECLARATION,
    name: "Grogu temporary storage cleanup",
    description:
      "Disable local full-backup schedules and retire completed temporary recovery and release artifacts. No model calls.",
    enabled: true,
    schedule: { kind: "every", everyMs: 60 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "command",
      argv: [
        profile.runtime.node,
        path.join(path.dirname(profile.runtime.cli), "dist", "grogu-maint.js"),
        "--profile",
        profile.profileFile,
        "storage-cleanup",
        "--apply",
      ],
      timeoutSeconds: 900,
    },
    delivery: { mode: "none" },
  };
}

async function disableLocalBackups(profile: OperatorProfile, directory: string, apply: boolean) {
  const snapshot = storageConfigSchema.parse(
    await callNative(profile, "config.get", {}, directory),
  );
  const filesystemLocations = new Set(
    Object.entries(snapshot.runtimeConfig.storage?.locations ?? {})
      .filter(([, location]) => location.provider === "filesystem")
      .map(([name]) => name),
  );
  const jobs = await listNativeJobs(profile, directory);
  if (apply && snapshot.runtimeConfig.cron?.enabled === false) {
    throw new Error("Enable the native cron scheduler before applying Grogu storage policy");
  }
  const selected = localFullBackupJobs(jobs, filesystemLocations).filter((job) => job.enabled);
  const disabled: string[] = [];
  const deferred: string[] = [];
  for (const job of selected) {
    if (job.state.runningAtMs !== undefined) {
      deferred.push(job.id);
      continue;
    }
    if (!job.configRevision) {
      throw new Error("A local backup job has no configuration revision; rerun after upgrading");
    }
    if (apply) {
      const updated = await callNative(
        profile,
        "cron.update",
        { id: job.id, expectedConfigRevision: job.configRevision, patch: { enabled: false } },
        directory,
      );
      if (!Value.Check(CronJobSchema, updated) || updated.enabled) {
        throw new Error("Native backup schedule did not disable");
      }
    }
    disabled.push(job.id);
  }
  return { disabled, deferred, cronEnabled: snapshot.runtimeConfig.cron?.enabled !== false };
}

export async function bootstrapGroguStorage(profile: OperatorProfile, apply = false) {
  return withGroguStorageLock(profile, async () => {
    if (apply) {
      const maintenance = path.join(path.dirname(profile.runtime.cli), "dist", "grogu-maint.js");
      if (!(await stat(maintenance)).isFile()) {
        throw new Error("Install the Grogu release with dist/grogu-maint.js before bootstrap");
      }
      await execute(profile.runtime.node, [maintenance, "storage-cleanup", "--help"], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    }
    const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
    const backups = await disableLocalBackups(profile, directory, apply);
    if (!backups.cronEnabled) {
      throw new Error("Enable the native cron scheduler before installing Grogu storage cleanup");
    }
    const job = storageCleanupJob(profile);
    if (apply) {
      const response = await callNative(profile, "cron.add", job, directory);
      if (!Value.Check(CronAddResultSchema, response)) {
        throw new Error("Native storage cleanup installation returned an invalid receipt");
      }
      const installed = "job" in response ? response.job : response;
      if (installed.declarationKey !== STORAGE_CLEANUP_DECLARATION || !installed.enabled) {
        throw new Error("Enable the native Grogu storage cleanup job, then rerun bootstrap");
      }
    }
    await writePrivateReceipt(directory, "storage-maintenance.json", {
      schemaVersion: 1,
      operation: "storage-bootstrap",
      completed: true,
    });
    return {
      mode: apply ? "applied" : "preview",
      backups,
      cleanupJob: job,
      privateReceipts: directory,
    };
  });
}

export async function cleanupGroguStorage(profile: OperatorProfile, apply = false) {
  return withGroguStorageLock(profile, async (assertCurrent) => {
    const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
    const backups = await disableLocalBackups(profile, directory, apply);
    const artifacts = await cleanupGroguArtifacts(profile, { apply, assertCurrent });
    const updateCaptures = await retireCompletedUpdateRecoveryCaptures({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: profile.stateDir,
        OPENCLAW_CONFIG_PATH: profile.configFile,
        OPENCLAW_OAUTH_DIR: profile.oauthDir,
      },
      apply,
      minimumAgeMs: TEMPORARY_ARTIFACT_LIFETIME_MS,
    });
    await writePrivateReceipt(directory, "storage-maintenance.json", {
      schemaVersion: 1,
      operation: "storage-cleanup",
      completed: true,
    });
    return {
      mode: apply ? "applied" : "preview",
      backups,
      artifacts,
      updateCaptures,
      privateReceipts: directory,
    };
  });
}
