import { assertExclusiveServiceStateOwner } from "../../src/infra/gateway-state-owner.js";
import { admitProtectedPhysicalAgentStorage } from "./agent-storage.js";

type ProtectedStateOwner = {
  readonly databasePath: string;
  assertCurrent(this: void): void;
  retain(this: void): () => void;
};

export type ProtectedAgentPhysicalEnrollment = {
  readonly operation: string;
  /** Call only after exact committed publication or proven rollback. */
  settle(this: void): void;
};

export type ProtectedAgentPhysicalAdmission = {
  /** Synchronous; pass as the writer's in-transaction and commit-edge authority. */
  assert(this: void): void;
  /** Enroll before native initiation; an unsettled enrollment is UNKNOWN custody. */
  enroll(this: void, operation: string): ProtectedAgentPhysicalEnrollment;
};

export type ProtectedAgentPhysicalFence = ProtectedAgentPhysicalAdmission & {
  /** Seals admission; resolves once every enrollment settles. Settlement stays permitted. */
  stop(this: void): Promise<void>;
  unsettled(this: void): string[];
};

type Phase = "recovering" | "open" | "sealed";

// One fence per owner lifetime, so a failed recovery cannot be retried in-process.
const fencedOwners = new WeakSet<ProtectedStateOwner>();

/**
 * The protected physical writer fence. Cross-process exclusion is the
 * exclusive-service state owner; this adds boot refusal of earlier foreign
 * openers, pre-initiation enrollment, and owner retention through settlement.
 * Recovery runs asynchronously under the fence before ordinary admission opens.
 */
export async function acquireProtectedAgentPhysicalFence(params: {
  stateOwner: ProtectedStateOwner;
  recover?: (recovery: ProtectedAgentPhysicalAdmission) => Promise<void>;
}): Promise<ProtectedAgentPhysicalFence> {
  const { stateOwner } = params;
  if (fencedOwners.has(stateOwner)) {
    throw new Error(
      "Protected agent storage was already fenced for this owner; restart the service.",
    );
  }
  assertExclusiveServiceStateOwner(stateOwner.databasePath);
  admitProtectedPhysicalAgentStorage(stateOwner.assertCurrent);
  // A refused admission started no work and may be retried; recovery may not.
  fencedOwners.add(stateOwner);
  let phase: Phase = "recovering";
  const pending = new Set<ProtectedAgentPhysicalEnrollment>();
  let drained: (() => void) | undefined;
  let stopped: Promise<void> | undefined;
  const admission = (admitted: Phase): ProtectedAgentPhysicalAdmission => {
    const assert = () => {
      if (phase !== admitted) {
        throw new Error(
          phase === "sealed"
            ? "Protected agent storage is stopping; new physical work is refused."
            : "Protected agent storage is still recovering; retry after startup completes.",
        );
      }
      stateOwner.assertCurrent();
      assertExclusiveServiceStateOwner(stateOwner.databasePath);
    };
    return {
      assert,
      enroll(operation) {
        assert();
        const releaseOwner = stateOwner.retain();
        const enrollment: ProtectedAgentPhysicalEnrollment = {
          operation,
          settle() {
            if (!pending.delete(enrollment)) {
              return;
            }
            releaseOwner();
            if (pending.size === 0) {
              drained?.();
            }
          },
        };
        pending.add(enrollment);
        return enrollment;
      },
    };
  };
  if (params.recover) {
    // A failed recovery keeps this hold: its outcome is unknown until restart.
    const releaseRecovery = stateOwner.retain();
    try {
      await params.recover(admission("recovering"));
      if (pending.size > 0) {
        throw new Error(
          `Protected agent recovery left unsettled work: ${[...pending].map((entry) => entry.operation).join(", ")}.`,
        );
      }
    } catch (error) {
      phase = "sealed";
      throw error;
    }
    releaseRecovery();
  }
  stateOwner.assertCurrent();
  phase = "open";
  const ordinary = admission("open");
  return {
    ...ordinary,
    stop() {
      phase = "sealed";
      stopped ??=
        pending.size === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              drained = resolve;
            });
      return stopped;
    },
    unsettled: () => [...pending].map((enrollment) => enrollment.operation),
  };
}
