#!/usr/bin/env node
import { Command } from "commander";
import {
  bootstrapGroguWidgetSandbox,
  reconcileManagedJobs,
  reconcileWorkerTriggers,
} from "./bootstrap.js";
import { stageGroguCompactionConfig } from "./compaction-config.js";
import {
  createPrivateArtifactDirectory,
  callNative,
  loadOperatorProfile,
  runNative,
  stageNativeRestore,
} from "./operator.js";
import { bootstrapGroguPlugins } from "./plugins.js";
import { checkLivePolicy } from "./policy.js";
import { buildRelease, verifyRelease } from "./release.js";
import { withGroguStorageLock } from "./storage-artifacts.js";
import { bootstrapGroguStorage, cleanupGroguStorage } from "./storage.js";
import { checkUpstream } from "./upstream.js";

const program = new Command()
  .name("grogu-maint")
  .description("Git-managed Grogu maintenance; native OpenClaw owns state and service lifecycle")
  .option("--profile <file>", "Protected private profile; never commit this file");

function profile() {
  const options = program.opts<{ profile?: string }>();
  if (!options.profile) {
    throw new Error("--profile is required for state or service maintenance");
  }
  return loadOperatorProfile(options.profile);
}

program
  .command("compaction-stage")
  .description(
    "Write validated candidate, apply, rollback and recovery artifacts; never change live config",
  )
  .action(async () => {
    const selected = profile();
    console.log(
      JSON.stringify(
        await withGroguStorageLock(selected, () => stageGroguCompactionConfig(selected)),
      ),
    );
  });

program
  .command("release-build <source>")
  .description("Build and verify a complete source-pinned native package; never activate it")
  .action(async (source: string) => {
    const selected = profile();
    console.log(
      JSON.stringify(await withGroguStorageLock(selected, () => buildRelease(selected, source))),
    );
  });

program
  .command("release-verify <manifest>")
  .description("Check immutable package digest and platform; never infer rollback compatibility")
  .action(async (manifest: string) => {
    const selected = profile();
    console.log(
      JSON.stringify(await withGroguStorageLock(selected, () => verifyRelease(selected, manifest))),
    );
  });

program
  .command("bootstrap")
  .description("Reconcile native jobs, storage policy, and the single-origin widget default")
  .option("--apply", "Apply native policy and widget configuration; the Gateway may restart", false)
  .action(async (options: { apply: boolean }) => {
    const selected = profile();
    const jobs = await reconcileManagedJobs(selected, options.apply);
    const storage = await bootstrapGroguStorage(selected, options.apply);
    // Apply restart-requiring configuration after the remaining bootstrap calls.
    const widgets = await bootstrapGroguWidgetSandbox(selected, options.apply);
    console.log(JSON.stringify({ jobs, storage, widgets }));
    if (storage.backups.deferred.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("storage-bootstrap")
  .description("Disable local full-backup schedules and install hourly model-free cleanup")
  .option("--apply", "Apply the small-disk storage policy", false)
  .action(async (options: { apply: boolean }) => {
    const result = await bootstrapGroguStorage(profile(), options.apply);
    console.log(JSON.stringify(result));
    if (result.backups.deferred.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("storage-cleanup")
  .description("Retire completed temporary artifacts; preserve active or unknown recovery")
  .option("--apply", "Permanently remove eligible temporary artifacts", false)
  .action(async (options: { apply: boolean }) => {
    const result = await cleanupGroguStorage(profile(), options.apply);
    console.log(JSON.stringify(result));
    if (result.backups.deferred.length > 0 || result.updateCaptures.warnings.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("plugins-bootstrap")
  .description("Preview or install the pinned Grogu plugin packages")
  .option("--apply", "Install missing packages and repair approved installations", false)
  .option("--accept-capabilities", "Accept reviewed plugin capabilities", false)
  .action(async (options: { apply: boolean; acceptCapabilities: boolean }) => {
    const result = await bootstrapGroguPlugins(profile(), options);
    console.log(JSON.stringify(result));
    if (result.plugins.some((plugin) => plugin.action === "conflict")) {
      process.exitCode = 1;
    }
  });

program
  .command("workers-bootstrap")
  .description(
    "Preview deterministic private-source trigger installation; no model request or live write by default",
  )
  .option("--apply", "Apply revision-checked trigger changes after review", false)
  .action(async (options: { apply: boolean }) => {
    console.log(JSON.stringify(await reconcileWorkerTriggers(profile(), options.apply)));
  });

program
  .command("upstream-check")
  .description(
    "Read the designated stable upstream release; never mutate production or invoke a model",
  )
  .requiredOption("--source <directory>", "Explicit private downstream Git checkout")
  .action(async (options: { source: string }) => {
    console.log(JSON.stringify(await checkUpstream(options.source)));
  });

program
  .command("status")
  .description("Check the native service and read-scope connectivity without invoking a model")
  .action(async () => {
    const selected = profile();
    const directory = await createPrivateArtifactDirectory(selected.recoveryDir);
    await runNative(
      selected,
      ["gateway", "status", "--port", String(selected.gatewayPort), "--require-rpc", "--json"],
      directory,
    );
    await callNative(selected, "health", {}, directory);
    console.log(JSON.stringify({ serviceReadCheck: "passed", privateReceipts: directory }));
  });

program
  .command("policy-check")
  .description("Read native config and jobs; fail if automatic routing or channel queueing drifted")
  .action(async () => {
    const result = await checkLivePolicy(profile());
    console.log(JSON.stringify(result));
    if (!result.passed) {
      process.exitCode = 1;
    }
  });

program
  .command("backup")
  .description("Retired: Grogu does not create local full backups")
  .action(() => {
    throw new Error(
      "Grogu local full backups are disabled. Update recovery copies are temporary; use storage-cleanup to inspect them.",
    );
  });

program
  .command("verify-archive <archive>")
  .description("Run native archive and SQLite inventory verification")
  .action(async (archive: string) => {
    const selected = profile();
    await withGroguStorageLock(selected, async () => {
      const directory = await createPrivateArtifactDirectory(selected.recoveryDir);
      await runNative(selected, ["backup", "verify", archive, "--json"], directory);
      console.log(JSON.stringify({ nativeVerification: "passed", privateReceipts: directory }));
    });
  });

program
  .command("restore-stage <archive> <target>")
  .description(
    "Restore to empty staging using native ownership guards; never activate or start channels",
  )
  .action(async (archive: string, target: string) => {
    const selected = profile();
    console.log(
      JSON.stringify(
        await withGroguStorageLock(selected, () => stageNativeRestore(selected, archive, target)),
      ),
    );
  });

try {
  process.umask(0o077);
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Grogu maintenance failed");
  process.exitCode = 1;
}
