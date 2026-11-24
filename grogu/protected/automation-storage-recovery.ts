import { isDeepStrictEqual } from "node:util";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";
import type {
  ProtectedAutomationLifecycleUncertainCommit,
  ProtectedAutomationRetirementUncertainCommit,
} from "../../src/state/protected-automation-lifecycle.types.js";
import type { ProtectedAutomationResultUncertainCommit } from "../../src/state/protected-automation-results.types.js";

type RetainedAutomationWrite =
  | ProtectedAutomationLifecycleUncertainCommit
  | ProtectedAutomationRetirementUncertainCommit
  | ProtectedAutomationResultUncertainCommit;

/** One host publication lifecycle, shared by result and metadata producers. No SQLite on the host. */
export function createProtectedAutomationStorageRecoveryOwner(assertOwnerCurrent: () => void) {
  const pending = new Map<SqliteWorkerOperationAdmission, RetainedAutomationWrite>();
  let enrolled = 0;
  let closed = false;
  let untrackedRecovery = false;
  const idleWaiters = new Set<() => void>();
  let reconciling: Promise<{ resolved: number; pending: number }> | undefined;
  const enroll = () => {
    enrolled++;
    let finished = false;
    return {
      finish(outcome: "settled" | "recovery-required") {
        if (finished) {
          return;
        }
        finished = true;
        enrolled--;
        if (outcome === "recovery-required" && pending.size === 0) {
          untrackedRecovery = true;
        }
        if (enrolled === 0) {
          for (const resolve of idleWaiters) {
            resolve();
          }
          idleWaiters.clear();
        }
      },
    };
  };
  const retain = (handle: RetainedAutomationWrite) => {
    const existing = pending.get(handle.admission);
    if (existing) {
      return;
    }
    pending.set(handle.admission, handle);
  };
  const reconcile = async () => {
    assertOwnerCurrent();
    let resolved = 0;
    for (const [admission, handle] of Array.from(pending)) {
      const native = await handle.retained.settled;
      assertOwnerCurrent();
      admission.service();
      const writerStopped =
        native.kind !== "unknown" ||
        native.nativeStopped === true ||
        admission.settlement?.kind === "completed";
      if (!writerStopped) {
        continue;
      }
      const receipt = admission.committed;
      if (receipt) {
        const matches =
          "verifyReceipt" in handle
            ? handle.verifyReceipt(receipt.facts)
            : isDeepStrictEqual(receipt.facts, handle.expectedReceipt);
        if (native.kind === "not-entered" || !matches) {
          throw new SqliteWorkerError(
            "Automation recovery receipt does not match",
            "outcome-unknown",
          );
        }
        assertOwnerCurrent();
        handle.settleStorage();
      } else if (
        native.kind === "not-entered" ||
        (native.kind === "completed" && admission.settlement?.kind === "completed")
      ) {
        assertOwnerCurrent();
        handle.releaseStorage();
      } else {
        // A stopped writer without a receipt is not proof of rollback.
        continue;
      }
      assertOwnerCurrent();
      handle.lease.release();
      pending.delete(admission);
      resolved++;
    }
    return { resolved, pending: pending.size };
  };
  return {
    enrollPublication() {
      if (closed || pending.size || untrackedRecovery) {
        throw new SqliteWorkerError("Automation publication requires storage recovery", "closed");
      }
      if (enrolled >= 128) {
        throw new SqliteWorkerError("Automation publication capacity reached", "overloaded");
      }
      return enroll();
    },
    enrollMaintenance() {
      assertOwnerCurrent();
      if (!closed || pending.size || enrolled || untrackedRecovery) {
        throw new SqliteWorkerError(
          "Automation maintenance requires closed, settled publication",
          "closed",
        );
      }
      return enroll();
    },
    retainUncertainCommit: (handle: ProtectedAutomationLifecycleUncertainCommit) => retain(handle),
    retainUncertainResultCommit: (handle: ProtectedAutomationResultUncertainCommit) =>
      retain(handle),
    retainUncertainRemovalCommit: (handle: ProtectedAutomationRetirementUncertainCommit) =>
      retain(handle),
    retainUncertainCreateCommit: (handle: ProtectedAutomationRetirementUncertainCommit) =>
      retain(handle),
    reconcile() {
      if (!reconciling) {
        reconciling = reconcile().finally(() => {
          reconciling = undefined;
        });
      }
      return reconciling;
    },
    close() {
      closed = true;
    },
    reopen() {
      assertOwnerCurrent();
      if (pending.size || enrolled || untrackedRecovery) {
        throw new SqliteWorkerError(
          "Automation publication still requires recovery",
          "outcome-unknown",
        );
      }
      closed = false;
    },
    status() {
      return {
        pending: pending.size,
        enrolled,
        admissionClosed: closed || pending.size > 0 || untrackedRecovery,
        untrackedRecovery,
      };
    },
    assertSettled() {
      if (pending.size || enrolled || untrackedRecovery) {
        throw new SqliteWorkerError("Automation storage still owns native work", "outcome-unknown");
      }
    },
    waitForIdle(signal: AbortSignal) {
      signal.throwIfAborted();
      if (enrolled === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          idleWaiters.delete(done);
          reject(signal.reason);
        };
        idleWaiters.add(done);
        signal.addEventListener("abort", aborted, { once: true });
      });
    },
  };
}
