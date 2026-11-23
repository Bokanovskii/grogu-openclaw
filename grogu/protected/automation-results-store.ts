import { isDeepStrictEqual } from "node:util";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import { observeSqliteWorkerCommittedFacts } from "../../src/infra/sqlite-worker-operation-admission.js";
import { createKeyedFifoLeaseRegistry } from "../../src/shared/keyed-fifo-lease.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import { prepareProtectedAutomationResultWriteAdmission } from "../../src/state/protected-automation-results-admission.js";
import { captureProtectedAutomationFinishedResult } from "../../src/state/protected-automation-results-input.js";
import type {
  PreparedProtectedAutomationFinishedResult,
  ProtectedAutomationResultAdmission,
  ProtectedAutomationResultCommitReceipt,
  ProtectedAutomationResultPublicationEnrollment,
  ProtectedAutomationResultStorageReservation,
} from "../../src/state/protected-automation-results.types.js";
import { protectedAutomationResultStorageEntries } from "./automation-results-storage.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

const resultLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.protectedAutomationResultLeases"),
);

export async function commitProtectedAutomationFinishedResult(
  stateDir: string,
  original: PreparedProtectedAutomationFinishedResult,
  authority: ProtectedAutomationResultAdmission,
) {
  const input = captureProtectedAutomationFinishedResult(original);
  if (authority.profileId !== input.centralOwnerProfileId) {
    throw new Error("Protected automation result authority does not match the owner.");
  }
  const context = captureProtectedStateWorkerContext(stateDir);
  const lease = resultLeases.reserve([
    JSON.stringify([context.admission.databasePath, input.jobId, input.runAtMs, input.runId]),
  ]);
  if (!lease) {
    throw new Error("Protected automation result identity could not be reserved.");
  }

  let reservation: ProtectedAutomationResultStorageReservation | undefined;
  let enrollment: ProtectedAutomationResultPublicationEnrollment | undefined;
  let settled = false;
  let handedOff = false;
  let commitStarted = false;
  let writerSettled = false;
  let write: ReturnType<typeof prepareProtectedAutomationResultWriteAdmission> | undefined;
  let expectedReceipt: ProtectedAutomationResultCommitReceipt | undefined;
  try {
    enrollment = authority.enrollPublication();
    await lease.wait();
    await authority.revalidate();
    authority.assertCurrent();
    const prepare = () =>
      runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type: "protectedAutomationResults.prepare", input }),
        { assertCurrent: () => authority.assertCurrent() },
      );
    const prepared = await prepare();
    authority.assertCurrent();
    if (prepared.status !== "prepared") {
      return prepared;
    }

    const entries = protectedAutomationResultStorageEntries(prepared.input);
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Protected automation result storage size is invalid.");
    }
    reservation = await authority.reserveStorage(bytes);
    await authority.revalidate();
    authority.assertCurrent();
    write = prepareProtectedAutomationResultWriteAdmission(
      context,
      prepared.input,
      bytes,
      entries,
      authority,
    );
    expectedReceipt = {
      kind: "protected-automation-result-committed",
      automationId: input.automationId,
      definitionRevision: input.definitionRevision,
      centralOwnerProfileId: input.centralOwnerProfileId,
      jobId: input.jobId,
      runAtMs: input.runAtMs,
      runId: input.runId,
      id: prepared.input.id,
      version: prepared.input.version,
      entries,
    };
    const operation = write;
    const receipt = expectedReceipt;
    const heldReservation = reservation;
    commitStarted = true;
    const outcome = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "protectedAutomationResults.commit", input: operation.facts }),
      {
        assertCurrent: () => authority.assertCurrent(),
        createAdmission: (retained) => {
          const created = operation.createAdmission(retained);
          observeSqliteWorkerCommittedFacts(created.admission, ({ facts }) => {
            if (!isDeepStrictEqual(facts, receipt)) {
              throw new Error("Protected automation result commit receipt does not match.");
            }
            heldReservation.settle({ created: true, entries });
            settled = true;
          });
          return created;
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const retained = operation.getRetained();
    const admission = operation.getAdmission();
    if (!retained || !admission) {
      commitStarted = false;
      if (!outcome.ok) {
        throw outcome.error;
      }
      throw new Error("Protected automation result completed without native admission.");
    }
    const native = await retained.settled;
    writerSettled =
      native.kind !== "unknown" ||
      native.nativeStopped === true ||
      admission.settlement?.kind === "completed";
    if (settled && writerSettled) {
      if (!outcome.ok) {
        throw outcome.error;
      }
      authority.assertCurrent();
      return outcome.value;
    }
    if (
      native.kind === "not-entered" ||
      (native.kind === "completed" &&
        admission.settlement?.kind === "completed" &&
        !admission.committed)
    ) {
      heldReservation.release();
      reservation = undefined;
      commitStarted = false;
      if (!outcome.ok) {
        await authority.revalidate();
        const existing = await prepare();
        authority.assertCurrent();
        if (existing.status !== "prepared") {
          return existing;
        }
        throw outcome.error;
      }
      throw new Error("Protected automation result completed without a commit receipt.");
    }

    handedOff = true;
    authority.retainUncertainCommit({
      expectedReceipt: receipt,
      reservation: heldReservation,
      reservationSettlementAcknowledged: settled,
      lease,
      admission,
      retained,
    });
    const error = new SqliteWorkerError(
      "Protected automation result commit requires native reconciliation",
      "outcome-unknown",
    );
    if (!outcome.ok) {
      error.cause = outcome.error;
    }
    throw error;
  } finally {
    if (!handedOff && commitStarted && reservation && write && expectedReceipt && !writerSettled) {
      const admission = write.getAdmission();
      const retained = write.getRetained();
      if (admission && retained) {
        handedOff = true;
        authority.retainUncertainCommit({
          expectedReceipt,
          reservation,
          reservationSettlementAcknowledged: settled,
          lease,
          admission,
          retained,
        });
      }
    }
    if (!handedOff) {
      if (reservation && !settled && !commitStarted) {
        reservation.release();
      }
      lease.release();
    }
    // Custody remains only when a possible commit has no settled writer.
    enrollment?.finish(
      handedOff || (commitStarted && !writerSettled) ? "recovery-required" : "settled",
    );
  }
}
