#!/usr/bin/env node
import { Command } from "commander";
import { reconcileManagedJobs, reconcileWorkerTriggers } from "./bootstrap.js";
import { stageGroguCompactionConfig } from "./compaction-config.js";
import {
  createPrivateArtifactDirectory,
  createVerifiedBackup,
  callNative,
  loadOperatorProfile,
  runNative,
  stageNativeRestore,
} from "./operator.js";
import { checkLivePolicy } from "./policy.js";
import { buildRelease, verifyRelease } from "./release.js";
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
    console.log(JSON.stringify(await stageGroguCompactionConfig(profile())));
  });

program
  .command("release-build <source>")
  .description("Build and verify a complete source-pinned native package; never activate it")
  .action(async (source: string) => {
    console.log(JSON.stringify(await buildRelease(profile(), source)));
  });

program
  .command("release-verify <manifest>")
  .description("Check immutable package digest and platform; never infer rollback compatibility")
  .action(async (manifest: string) => {
    console.log(JSON.stringify(await verifyRelease(profile(), manifest)));
  });

program
  .command("bootstrap")
  .description("Preview revision-checked native job metadata; preserve models, pauses and delivery")
  .option("--apply", "Apply only non-behavioral metadata changes", false)
  .action(async (options: { apply: boolean }) => {
    console.log(JSON.stringify(await reconcileManagedJobs(profile(), options.apply)));
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
  .description("Create and verify a complete native online archive; not a quiescent cutover")
  .action(async () => {
    console.log(JSON.stringify(await createVerifiedBackup(profile())));
  });

program
  .command("verify-archive <archive>")
  .description("Run native archive and SQLite inventory verification")
  .action(async (archive: string) => {
    const selected = profile();
    const directory = await createPrivateArtifactDirectory(selected.recoveryDir);
    await runNative(selected, ["backup", "verify", archive, "--json"], directory);
    console.log(JSON.stringify({ nativeVerification: "passed", privateReceipts: directory }));
  });

program
  .command("restore-stage <archive> <target>")
  .description(
    "Restore to empty staging using native ownership guards; never activate or start channels",
  )
  .action(async (archive: string, target: string) => {
    console.log(JSON.stringify(await stageNativeRestore(profile(), archive, target)));
  });

try {
  process.umask(0o077);
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Grogu maintenance failed");
  process.exitCode = 1;
}
