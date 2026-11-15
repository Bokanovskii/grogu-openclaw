import { formatErrorMessage } from "../../infra/errors.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdatePackageCompletionParams } from "./update-command-finish-types.js";
import { completeGroguPackageCacheMaintenance } from "./update-command-grogu-cache-maintenance.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";

/** Share verified retirement and unverified recovery retention across finalizers. */
export async function recordUpdatePackageCompletion(
  params: UpdatePackageCompletionParams,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<UpdateCommandFailure | void> {
  const transaction = params.packageTransaction;
  if (!transaction) {
    return completeGroguPackageCacheMaintenance(params, result, assertCurrent);
  }
  if (
    isUpdateGatewayReadinessPending(result) ||
    (result.status === "ok" &&
      params.opts.run?.completionOwner === "gateway-restart" &&
      params.opts.run.gatewayRestartRequired === true)
  ) {
    assertCurrent();
    const message = `Gateway readiness is pending; backup retirement deferred for ${transaction.backupRoot}. Verify readiness before cleanup.`;
    result.steps.push({
      name: "package-backup-retention",
      command: "openclaw update",
      cwd: result.root ?? params.root,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message },
    });
    defaultRuntime.error(message);
    return;
  }
  let cleanupFailure: unknown;
  // Progress goes to the human channel only; --json owns stdout and records the
  // retention outcome as a step, so this line must not leak into machine output.
  if (!params.opts.json) {
    defaultRuntime.log("Finishing update: checking package backup retention and cleanup.");
  }
  // Doctor can revoke restoration after capture. Both local and migrated
  // finalization retire the retained parent's transaction through this boundary.
  if (params.databaseBackup?.restoreRefusal) {
    transaction.databaseBackupRoot = undefined;
  }
  const retained: UpdateStepResult | void = await transaction
    .complete({ activationVerified: result.status === "ok" }, assertCurrent)
    .catch((error: unknown) => {
      assertCurrent();
      if (error instanceof UpdateCommandPendingRecoveryFailure) {
        throw error;
      }
      cleanupFailure = error;
      return {
        name: "package-backup-retention",
        command: "openclaw update",
        cwd: result.root ?? params.root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `Update backup cleanup failed: ${formatErrorMessage(error)}. Inspect ${transaction.backupRoot} before manual cleanup.`,
      };
    });
  assertCurrent();
  if (!retained) {
    return completeGroguPackageCacheMaintenance(params, result, assertCurrent);
  }
  const step = { ...retained, stderrTail: retained.stderrTail };
  if (step.exitCode !== 0) {
    const recoveryPath = `Recovery transaction backup path: ${transaction.backupRoot}`;
    if (!step.advisory) {
      step.warnings = [...(step.warnings ?? []), recoveryPath];
    }
    if (!step.stderrTail?.includes(transaction.backupRoot)) {
      step.stderrTail = [step.stderrTail, recoveryPath].filter(Boolean).join("\n");
    }
  }
  result.steps = [...result.steps, step];
  if (result.status !== "ok" && !result.recovery?.packageRollbackVerified) {
    defaultRuntime.error(step.stderrTail);
    return;
  }
  if (step.exitCode !== 0 && step.advisory?.kind !== "recoverable-maintenance") {
    // A caller's successful activation does not establish recovery/cleanup safety.
    // Unknown exceptions and unqualified completion refusals must fail the command.
    return new UpdateCommandFailure(
      { ...result, status: "error", reason: "package-backup-retention-failed", failedStep: step },
      1,
      step.stderrTail ?? "Package backup completion was not verified.",
      { cause: cleanupFailure },
    );
  }
  if (step.exitCode === 0 && !step.advisory && !step.warnings?.length) {
    return completeGroguPackageCacheMaintenance(params, result, assertCurrent);
  }
}
