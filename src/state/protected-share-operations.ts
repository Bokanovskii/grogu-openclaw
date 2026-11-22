import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import type {
  PreparedProtectedShare,
  ProtectedShareEntry,
  ProtectedShareRetirement,
  ProtectedShareStateGeneration,
} from "./protected-shares.js";
import type { ProtectedShareWorkerOperations } from "./protected-shares.worker.js";

export type ProtectedShareReservation = {
  settle(result: { created: boolean; entries: readonly ProtectedShareEntry[] }): void;
  release(): void;
};

export type ProtectedShareStorageAdmission = {
  release(): void;
  reserveStoredData(bytes: number): ProtectedShareReservation;
  retiredStoredData(changes: readonly ProtectedShareRetirement[]): void;
};

export type ProtectedShareAuthority = {
  profileId: string;
  assertCurrent: () => void;
};

export type ProtectedShareStorageAuthority = ProtectedShareAuthority & {
  admitStorage: () => Promise<ProtectedShareStorageAdmission>;
};

export function captureProtectedShareStateGeneration(
  context: OpenClawStateWorkerContext,
): ProtectedShareStateGeneration {
  context.admission.assertCurrent();
  const integrity = context.admission.captureIntegrity?.();
  if (!integrity) {
    throw new Error("Protected sharing requires a captured shared-state generation.");
  }
  return {
    databaseIdentity: createHash("sha256")
      .update(JSON.stringify([integrity.identity.key, integrity.identity.birthtime ?? null]))
      .digest("hex"),
    epoch: integrity.epoch.toString(),
  };
}

function assertProtectedShareStateGeneration(
  context: OpenClawStateWorkerContext,
  expected: ProtectedShareStateGeneration,
): void {
  context.admission.assertCurrent();
  if (!isDeepStrictEqual(captureProtectedShareStateGeneration(context), expected)) {
    throw new Error("Protected sharing shared-state generation changed.");
  }
}

function assertAuthorityCurrent(
  context: OpenClawStateWorkerContext,
  authority: ProtectedShareAuthority,
): void {
  context.admission.assertCurrent();
  authority.assertCurrent();
}

export async function prepareProtectedShareWithAuthority(
  context: OpenClawStateWorkerContext,
  input: ProtectedShareWorkerOperations["protectedShares.prepare"]["input"],
  authority: ProtectedShareAuthority,
): Promise<{ generation: ProtectedShareStateGeneration; prepared: PreparedProtectedShare }> {
  if (input.ownerProfileId !== authority.profileId) {
    throw new Error("Protected share owner does not match the current member.");
  }
  const generation = captureProtectedShareStateGeneration(context);
  const prepared = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedShares.prepare", input: structuredClone(input) }),
    { assertCurrent: () => assertAuthorityCurrent(context, authority) },
  );
  assertAuthorityCurrent(context, authority);
  assertProtectedShareStateGeneration(context, generation);
  return { generation, prepared };
}

function createGrantAdmission(
  context: OpenClawStateWorkerContext,
  authority: ProtectedShareAuthority,
  prepared: Extract<PreparedProtectedShare, { status: "prepared" }>,
  generation: ProtectedShareStateGeneration,
  reservation: ProtectedShareReservation,
  onCommitted: (entries: readonly ProtectedShareEntry[]) => void,
): SqliteWorkerAdmissionFactory {
  const baseFacts = {
    kind: "protected-share",
    action: "create",
    ownerProfileId: prepared.ownerProfileId,
    resourceId: prepared.resourceId,
    resourceKind: prepared.kind,
    routeId: prepared.routeId,
    generation,
  };
  const storageFacts = { ...baseFacts, entries: prepared.entries };
  const admittedFacts = { ...baseFacts, storage: storageFacts };
  return (operation) => {
    let storageAdmitted = false;
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      assertAuthorityCurrent(context, authority);
      assertProtectedShareStateGeneration(context, generation);
      if (request.stage === "transaction" && isDeepStrictEqual(request.facts, baseFacts)) {
        grant();
        return;
      }
      if (request.stage === "transaction" && isDeepStrictEqual(request.facts, admittedFacts)) {
        if (storageAdmitted) {
          throw new Error("Protected share storage was admitted more than once.");
        }
        if (
          !grant(() => {
            storageAdmitted = true;
          })
        ) {
          throw new Error("Protected share storage admission was refused.");
        }
        return;
      }
      if (request.stage === "commit" && isDeepStrictEqual(request.facts, baseFacts)) {
        if (!storageAdmitted) {
          throw new Error("Protected share commit has no stored-data reservation.");
        }
        grant();
        return;
      }
      throw new Error("Protected share mutation requires exact member and storage admission.");
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      if (
        !isDeepStrictEqual(facts, {
          ...baseFacts,
          storage: { entries: prepared.entries },
        })
      ) {
        throw new Error("Protected share commit receipt does not match its reservation.");
      }
      assertAuthorityCurrent(context, authority);
      assertProtectedShareStateGeneration(context, generation);
      onCommitted(prepared.entries ?? []);
    });
    void operation.settled.then((outcome) => {
      if (outcome.kind !== "unknown" && !admission.committed) {
        reservation.release();
      }
    });
    return { admission, nativeLocations: [context.admission.databasePath] };
  };
}

export async function createProtectedShareWithAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedShareWorkerOperations["protectedShares.create"]["input"],
  authority: ProtectedShareStorageAuthority,
): Promise<Awaited<ProtectedShareWorkerOperations["protectedShares.create"]["output"]>> {
  const capturedInput = structuredClone(input);
  const prepared = capturedInput.prepared;
  const generation = capturedInput.generation;
  assertProtectedShareStateGeneration(context, generation);
  if (prepared.ownerProfileId !== authority.profileId) {
    throw new Error("Protected share owner does not match the current member.");
  }
  if (prepared.status !== "prepared") {
    throw new TypeError("Protected share must be prepared before storage admission.");
  }
  if (!prepared.entries.length) {
    throw new TypeError("Protected share must include storage entries.");
  }
  const bytes = prepared.entries.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Protected share reservation size is invalid.");
  }
  assertAuthorityCurrent(context, authority);
  assertProtectedShareStateGeneration(context, generation);
  const storage = await authority.admitStorage();
  let reservation: ProtectedShareReservation;
  try {
    assertAuthorityCurrent(context, authority);
    assertProtectedShareStateGeneration(context, generation);
    reservation = storage.reserveStoredData(bytes);
  } catch (error) {
    storage.release();
    throw error;
  }
  let admissionCreated = false;
  try {
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "protectedShares.create",
          input: capturedInput,
        }),
      {
        assertCurrent: () => {
          assertAuthorityCurrent(context, authority);
          assertProtectedShareStateGeneration(context, generation);
        },
        createAdmission: (operation) => {
          admissionCreated = true;
          return createGrantAdmission(
            context,
            authority,
            prepared,
            generation,
            reservation,
            (entries) => {
              reservation.settle({ created: true, entries });
            },
          )(operation);
        },
      },
    );
    assertAuthorityCurrent(context, authority);
    assertProtectedShareStateGeneration(context, generation);
    if (
      typeof result !== "string" &&
      (!isDeepStrictEqual(result.entries, prepared.entries) ||
        !isDeepStrictEqual(
          result.grants,
          prepared.grants?.map(({ id, recipientProfileId }) => ({ id, recipientProfileId })),
        ) ||
        !isDeepStrictEqual(result.generation, generation) ||
        result.resourceId !== prepared.resourceId)
    ) {
      throw new Error("Protected share result does not match its committed reservation.");
    }
    return result;
  } catch (error) {
    if (!admissionCreated) {
      reservation.release();
    }
    throw error;
  }
}

export async function readProtectedShareWithAuthority(
  context: OpenClawStateWorkerContext,
  input: ProtectedShareWorkerOperations["protectedShares.read"]["input"],
  authority: ProtectedShareAuthority,
) {
  if (input.profileId !== authority.profileId) {
    throw new Error("Protected share reader does not match the current member.");
  }
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedShares.read", input }),
    { assertCurrent: () => assertAuthorityCurrent(context, authority) },
  );
  assertAuthorityCurrent(context, authority);
  return result;
}

export async function listProtectedSharesWithAuthority(
  context: OpenClawStateWorkerContext,
  input: ProtectedShareWorkerOperations["protectedShares.list"]["input"],
  authority: ProtectedShareAuthority,
) {
  if (input.profileId !== authority.profileId) {
    throw new Error("Protected share listing does not match the current member.");
  }
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "protectedShares.list", input }),
    { assertCurrent: () => assertAuthorityCurrent(context, authority) },
  );
  assertAuthorityCurrent(context, authority);
  return result;
}

export async function revokeProtectedShareWithAdmission(
  context: OpenClawStateWorkerContext,
  input: ProtectedShareWorkerOperations["protectedShares.revoke"]["input"],
  authority: ProtectedShareStorageAuthority,
) {
  if (input.ownerProfileId !== authority.profileId) {
    throw new Error("Protected share revoker does not match the current member.");
  }
  assertAuthorityCurrent(context, authority);
  const capturedInput = structuredClone(input);
  const generation = capturedInput.generation;
  assertProtectedShareStateGeneration(context, generation);
  const baseFacts = {
    kind: "protected-share",
    action: "revoke",
    ownerProfileId: authority.profileId,
    grantId: input.grantId,
    generation,
  };
  const storage = await authority.admitStorage();
  let admissionCreated = false;
  let receiptApplied = false;
  let committedRetirements: ProtectedShareRetirement[] | undefined;
  let storageReleased = false;
  const releaseStorage = () => {
    if (!storageReleased) {
      storageReleased = true;
      storage.release();
    }
  };
  const applyRetirement = (changes: readonly ProtectedShareRetirement[]) => {
    if (receiptApplied) {
      throw new Error("Protected share retirement receipt was applied more than once.");
    }
    assertAuthorityCurrent(context, authority);
    assertProtectedShareStateGeneration(context, generation);
    storage.retiredStoredData(changes);
    committedRetirements = changes.map((change) => structuredClone(change));
    receiptApplied = true;
    releaseStorage();
  };
  try {
    assertAuthorityCurrent(context, authority);
  } catch (error) {
    releaseStorage();
    throw error;
  }
  let result: Awaited<ProtectedShareWorkerOperations["protectedShares.revoke"]["output"]>;
  try {
    result = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "protectedShares.revoke",
          input: capturedInput,
        }),
      {
        assertCurrent: () => {
          assertAuthorityCurrent(context, authority);
          assertProtectedShareStateGeneration(context, generation);
        },
        createAdmission: (operation) => {
          admissionCreated = true;
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            assertAuthorityCurrent(context, authority);
            assertProtectedShareStateGeneration(context, generation);
            if (
              (request.stage !== "transaction" && request.stage !== "commit") ||
              !isDeepStrictEqual(request.facts, baseFacts) ||
              !grant()
            ) {
              throw new Error("Protected share revocation requires current owner authority.");
            }
          });
          observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
            if (!isObject(facts) || !isDeepStrictEqual(omitRetirement(facts), baseFacts)) {
              throw new Error("Protected share revocation receipt is invalid.");
            }
            if (!Array.isArray(facts.retired)) {
              throw new Error("Protected share revocation receipt has no retirement entries.");
            }
            applyRetirement(resultRetirementFacts(facts.retired));
          });
          void operation.settled.then((outcome) => {
            if (outcome.kind !== "unknown" && !receiptApplied && !admission.committed) {
              releaseStorage();
            }
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } catch (error) {
    if (!admissionCreated) {
      releaseStorage();
    }
    throw error;
  }
  if (!admissionCreated) {
    releaseStorage();
  }
  assertAuthorityCurrent(context, authority);
  assertProtectedShareStateGeneration(context, generation);
  if (
    (Array.isArray(result) && !isDeepStrictEqual(result, committedRetirements)) ||
    (!Array.isArray(result) && committedRetirements !== undefined)
  ) {
    throw new Error("Protected share revocation result does not match its committed receipt.");
  }
  return result;
}

function resultRetirementFacts(value: unknown): ProtectedShareRetirement[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        isObject(entry) &&
        isObject(entry.removed) &&
        typeof entry.removed.id === "string" &&
        typeof entry.removed.profileId === "string" &&
        typeof entry.removed.bytes === "number" &&
        Number.isSafeInteger(entry.removed.bytes) &&
        entry.removed.bytes >= 0 &&
        (entry.retained === undefined ||
          (isObject(entry.retained) &&
            typeof entry.retained.id === "string" &&
            typeof entry.retained.profileId === "string" &&
            typeof entry.retained.bytes === "number" &&
            Number.isSafeInteger(entry.retained.bytes) &&
            entry.retained.bytes >= 0)),
    )
  ) {
    throw new Error("Protected share retirement entries are invalid.");
  }
  return value as ProtectedShareRetirement[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitRetirement(value: Record<string, unknown>): Record<string, unknown> {
  const { retired: _retired, ...rest } = value;
  return rest;
}
