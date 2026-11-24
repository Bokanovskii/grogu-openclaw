import { isDeepStrictEqual } from "node:util";
import { SqliteWorkerError } from "../../src/infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../../src/infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../src/infra/sqlite-worker-operation-settlement.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import type {
  ProtectedAutomationLifecycleAuthority,
  ProtectedAutomationLifecycleCommand,
  ProtectedAutomationLifecycleReceipt,
  ProtectedAutomationLifecycleWrite,
  ProtectedAutomationLifecycleAccess,
  ProtectedAutomationLifecycleOwnerAuthority,
} from "../../src/state/protected-automation-lifecycle.types.js";
import {
  protectedAutomationStorageLeaseKeys,
  protectedAutomationStorageLeases,
} from "./automation-storage-leases.js";
import { storageEntryOverheadBytes } from "./capacity.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type {
  ProtectedAutomationLifecycleAuthority,
  ProtectedAutomationLifecycleCommand,
  ProtectedAutomationLifecycleRun,
  ProtectedAutomationLifecycleUncertainCommit,
  ProtectedAutomationLifecycleOwnerAuthority,
  ProtectedAutomationOwnerInboxEntry,
} from "../../src/state/protected-automation-lifecycle.types.js";

/** Caller owns current member authority, admission closure and uncertain native-write recovery. */
export async function writeProtectedAutomationLifecycle(
  stateDir: string,
  original: ProtectedAutomationLifecycleCommand,
  authority: ProtectedAutomationLifecycleAuthority,
) {
  return writeLifecycle(stateDir, original, authority, { kind: "member" });
}

export async function writeProtectedAutomationLifecycleForOwner(
  stateDir: string,
  command: ProtectedAutomationLifecycleCommand,
  authority: ProtectedAutomationLifecycleOwnerAuthority,
) {
  const captured = structuredClone(command);
  return writeLifecycle(
    stateDir,
    captured,
    authority,
    { kind: "owner", ...structuredClone(authority.operator) },
    () => {
      authority.assertOwnerCurrent();
      if (captured.kind === "finish" || captured.kind === "delete") {
        authority.assertRunStopped(captured.automationId);
      }
    },
  );
}

async function writeLifecycle(
  stateDir: string,
  original: ProtectedAutomationLifecycleCommand,
  authority: ProtectedAutomationLifecycleAuthority,
  access: ProtectedAutomationLifecycleAccess,
  assertOwnerCurrent?: () => void,
) {
  const command = structuredClone(original);
  if (command.profileId !== authority.profileId) {
    throw new Error("Protected automation lifecycle authority does not match its owner.");
  }
  const context = captureProtectedStateWorkerContext(stateDir);
  const lease = protectedAutomationStorageLeases.reserve(
    protectedAutomationStorageLeaseKeys(
      context.admission.databasePath,
      command.automationId,
      command.profileId,
    ),
  );
  if (!lease) {
    throw new Error("Protected automation lifecycle identity could not be reserved.");
  }
  let enrollment: ReturnType<typeof authority.enrollPublication> | undefined;
  let reservation: Awaited<ReturnType<typeof authority.reserveStorage>> | undefined;
  let batch:
    | {
        change: NonNullable<ProtectedAutomationLifecycleWrite["replacement"]>;
        reservation: Awaited<ReturnType<typeof authority.reserveBatchReplacement>>;
      }
    | undefined;
  let replacement:
    | {
        previous: ProtectedAutomationLifecycleWrite["entries"][number];
        current: ProtectedAutomationLifecycleWrite["entries"][number];
        reservation: Awaited<ReturnType<typeof authority.reserveReplacement>>;
      }
    | undefined;
  const nativeState: {
    admission?: SqliteWorkerOperationAdmission;
    retained?: RetainedWorkerTransactionAdmission;
  } = {};
  let write: ProtectedAutomationLifecycleWrite | undefined;
  let expectedReceipt: ProtectedAutomationLifecycleReceipt | undefined;
  let reservationSettled = false;
  let storageSettled = false;
  let commitStarted = false;
  let writerSettled = false;
  let handedOff = false;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    authority.assertCurrent();
    assertOwnerCurrent?.();
  };
  const settleStorage = () => {
    if (!write || (write.entries.length > 0 && !reservation && !replacement && !batch)) {
      throw new Error("Protected automation lifecycle has no storage reservation.");
    }
    if (!reservationSettled) {
      if (batch) {
        batch.reservation.settle(batch.change.current);
      } else if (replacement) {
        replacement.reservation.settle(replacement.current);
      } else {
        reservation?.settle({ created: write.entries.length > 0, entries: write.entries });
      }
      reservationSettled = true;
    }
    if (!storageSettled) {
      // Retirement is idempotent in the capacity owner, including callback failures and rescans.
      authority.retireStorage(write.retired);
      if (write.retiredDefinition) {
        if (!authority.retireDefinition) {
          throw new Error("Protected automation deletion requires definition retirement.");
        }
        authority.retireDefinition(write.retiredDefinition);
      }
      storageSettled = true;
    }
  };
  const releaseStorage = () => {
    if (!reservationSettled) {
      if (batch) {
        batch.reservation.release(batch.change.previous);
      } else if (replacement) {
        replacement.reservation.release(replacement.previous);
      } else {
        reservation?.release();
      }
    }
  };
  const handOff = () => {
    const { admission, retained } = nativeState;
    if (!expectedReceipt || !admission || !retained) {
      return false;
    }
    authority.retainUncertainCommit({
      expectedReceipt,
      admission,
      retained,
      lease,
      storageSettlementAcknowledged: storageSettled,
      settleStorage,
      releaseStorage,
    });
    handedOff = true;
    return true;
  };
  try {
    if (command.kind === "remove" && !authority.retireDefinition) {
      throw new Error("Protected automation deletion requires definition retirement.");
    }
    enrollment = authority.enrollPublication();
    await lease.wait();
    await authority.revalidate();
    assertCurrent();
    const prepared = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "protectedAutomationLifecycle.prepare",
          input: { command, access, entryOverheadBytes: storageEntryOverheadBytes },
        }),
      { assertCurrent },
    );
    assertCurrent();
    if (prepared.status !== "prepared") {
      return prepared;
    }
    write = prepared.write;
    const bytes = write.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Protected automation lifecycle allocation is invalid.");
    }
    const [current] = write.entries;
    const previous =
      current && write.entries.length === 1
        ? write.retired.find((entry) => entry.id.split(":")[0] === current.id.split(":")[0])
        : undefined;
    if (write.replacement) {
      batch = {
        change: write.replacement,
        reservation: await authority.reserveBatchReplacement(write.replacement),
      };
    } else if (previous && current) {
      replacement = {
        previous,
        current,
        reservation: await authority.reserveReplacement({ previous, current }),
      };
    } else if (bytes > 0) {
      reservation = await authority.reserveStorage(bytes);
    }
    await authority.revalidate();
    assertCurrent();
    const facts = write;
    expectedReceipt = { kind: "protected-automation-lifecycle-committed", write };
    const receipt = expectedReceipt;
    commitStarted = true;
    const outcome = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "protectedAutomationLifecycle.commit", input: facts }),
      {
        assertCurrent,
        createAdmission: (operation) => {
          nativeState.retained = operation;
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (
              (request.stage !== "transaction" && request.stage !== "commit") ||
              !isDeepStrictEqual(request.facts, facts)
            ) {
              throw new Error("Protected automation lifecycle requires exact write admission.");
            }
            assertCurrent();
            if (!grant()) {
              throw new Error("Protected automation lifecycle write admission was not granted.");
            }
          });
          nativeState.admission = admission;
          observeSqliteWorkerCommittedFacts(admission, ({ facts: observed }) => {
            if (!isDeepStrictEqual(observed, receipt)) {
              throw new Error("Protected automation lifecycle commit receipt does not match.");
            }
            settleStorage();
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const { admission, retained } = nativeState;
    if (!admission || !retained) {
      commitStarted = false;
      if (!outcome.ok) {
        throw outcome.error;
      }
      throw new Error("Protected automation lifecycle completed without native admission.");
    }
    const native = await retained.settled;
    writerSettled =
      native.kind !== "unknown" ||
      native.nativeStopped === true ||
      admission.settlement?.kind === "completed";
    if (storageSettled && writerSettled) {
      if (!outcome.ok) {
        throw outcome.error;
      }
      assertCurrent();
      return outcome.value;
    }
    if (
      native.kind === "not-entered" ||
      (native.kind === "completed" &&
        admission.settlement?.kind === "completed" &&
        !admission.committed)
    ) {
      releaseStorage();
      reservation = undefined;
      replacement = undefined;
      batch = undefined;
      commitStarted = false;
      if (!outcome.ok) {
        throw outcome.error;
      }
      if (command.kind === "remove" && outcome.value.status !== "committed") {
        return outcome.value;
      }
      throw new Error("Protected automation lifecycle completed without a commit receipt.");
    }
    handOff();
    const error = new SqliteWorkerError(
      "Protected automation lifecycle requires native reconciliation",
      "outcome-unknown",
    );
    if (!outcome.ok) {
      error.cause = outcome.error;
    }
    throw error;
  } finally {
    if (!handedOff && commitStarted && (!writerSettled || !storageSettled)) {
      handOff();
    }
    if (!handedOff) {
      if (!commitStarted) {
        releaseStorage();
      }
      lease.release();
    }
    enrollment?.finish(handedOff ? "recovery-required" : "settled");
  }
}

type ReadAuthority = Pick<
  ProtectedAutomationLifecycleAuthority,
  "profileId" | "revalidate" | "assertCurrent"
>;

export async function listProtectedAutomationLifecycleRuns(
  stateDir: string,
  automationId: string,
  authority: ReadAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const profileId = authority.profileId;
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "protectedAutomationLifecycle.runs",
        input: { profileId, automationId },
      }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  return result;
}

export async function listProtectedAutomationOwnerInbox(
  stateDir: string,
  authority: ReadAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const profileId = authority.profileId;
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomationLifecycle.inbox", input: { profileId } }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  return result;
}

export async function readProtectedAutomationLastScheduledAttempt(
  stateDir: string,
  automationId: string,
  authority: ReadAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const profileId = authority.profileId;
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "protectedAutomationLifecycle.lastScheduledAttempt",
        input: { profileId, automationId },
      }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  return result;
}

export async function readProtectedAutomationRunChat(
  stateDir: string,
  automationId: string,
  authority: ReadAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const profileId = authority.profileId;
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "protectedAutomationLifecycle.runChat",
        input: { profileId, automationId },
      }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  return result;
}

export async function canReadProtectedIsolatedAutomationRunChat(
  stateDir: string,
  input: {
    action: "list" | "history" | "send" | "status" | "search";
    currentChatId: string;
    targetChatId: string;
  },
  authority: ReadAuthority,
) {
  if (
    (input.action !== "list" && input.action !== "history") ||
    input.currentChatId === input.targetChatId
  ) {
    return false;
  }
  const context = captureProtectedStateWorkerContext(stateDir);
  const originInput = { profileId: authority.profileId, chatId: input.targetChatId };
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "protectedAutomationLifecycle.isolatedRunChat", input: originInput }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
      },
    },
  );
  authority.assertCurrent();
  return result;
}

export async function readProtectedAutomationLifecycleStorageUsage(
  stateDir: string,
  assertCurrent: () => void,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "protectedAutomationLifecycle.storageUsage", input: undefined }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        assertCurrent();
      },
    },
  );
}

/** Startup/removal control sees only the active run reference, never a transcript or result text. */
export async function readProtectedAutomationInterruptedRunForOwner(
  stateDir: string,
  automationId: string,
  authority: ProtectedAutomationLifecycleOwnerAuthority,
) {
  const context = captureProtectedStateWorkerContext(stateDir);
  const input = {
    profileId: authority.profileId,
    automationId,
    access: { kind: "owner" as const, ...structuredClone(authority.operator) },
  };
  await authority.revalidate();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedAutomationLifecycle.interruptedRun", input }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        authority.assertCurrent();
        authority.assertOwnerCurrent();
      },
    },
  );
  authority.assertCurrent();
  authority.assertOwnerCurrent();
  return result;
}
