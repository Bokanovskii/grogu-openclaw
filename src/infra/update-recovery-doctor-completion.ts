import { randomUUID } from "node:crypto";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { root as safeRoot } from "./fs-safe.js";
import { withRecoveryMetadata } from "./update-recovery-backup-reader.js";
import type { UpdateRecoveryBaselineRef } from "./update-recovery-baseline-capture.js";
import {
  doctorCaptureCompletionSchema,
  standaloneDoctorCaptureId,
} from "./update-recovery-doctor-completion-contract.js";
import { canonicalEntryPath } from "./update-recovery-path.js";
import { readUpdateRunDriver, sameUpdateRunDriver } from "./update-run-driver.js";

/** The original Doctor publishes this only after clean repair and maintenance release. */
export async function completeStandaloneDoctorCapture(params: {
  ref: UpdateRecoveryBaselineRef;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = { ...params.env };
  await withRecoveryMetadata(params.ref, async ({ manifest, outcome, pin }) => {
    const driver = readUpdateRunDriver();
    if (
      !driver ||
      !standaloneDoctorCaptureId.test(manifest.runId) ||
      manifest.schemaVersion !== 2 ||
      manifest.generation?.kind !== "baseline" ||
      manifest.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir(env)) ||
      manifest.configPath !== canonicalEntryPath(resolveConfigPath(env)) ||
      outcome ||
      !sameUpdateRunDriver(manifest.creator, driver) ||
      manifest.drivers.length !== 1 ||
      !sameUpdateRunDriver(manifest.drivers[0]!, driver)
    ) {
      throw new Error("Doctor completion requires its original sealed capture and live process.");
    }
    await withUpdateCommandExecutor(`doctor-completion-${randomUUID()}`, async (executor) => {
      const fence = await executor.enter(manifest.installRoot);
      await pin.assertCurrent();
      fence.assertCurrent();
      const reply = await withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(
          { env },
          { type: "updateRecoveryRetirement.read", input: { runId: manifest.runId } },
          { current: true, preferIndependentWarmRead: true },
        ),
      );
      fence.assertCurrent();
      if (
        !reply?.ok ||
        reply.type !== "updateRecoveryRetirement.read" ||
        reply.run ||
        reply.activeRun ||
        reply.pendingRecovery
      ) {
        throw new Error("Doctor completion is deferred while update recovery is unverified.");
      }
      const source = await safeRoot(params.ref.directory, {
        symlinks: "reject",
        hardlinks: "reject",
      });
      await pin.assertCurrent();
      // Maintenance has restored the Gateway. Publish only the owned capture artifact,
      // never reopen its live canonical database through an offline writer.
      await source.createJson(
        "outcome.json",
        {
          status: "committed",
          manifestSha256: params.ref.manifestSha256,
          doctorCompletion: doctorCaptureCompletionSchema.parse({
            manifestSha256: params.ref.manifestSha256,
            completedAtMs: Date.now(),
            driver,
          }),
        },
        { atomic: true, durable: true, mode: 0o600, assertBeforeMutation: fence.assertCurrent },
      );
    });
  });
}
