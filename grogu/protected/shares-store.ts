import { isDeepStrictEqual } from "node:util";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import {
  captureProtectedShareStateGeneration,
  createProtectedShareWithAdmission,
  listProtectedSharesWithAuthority,
  prepareProtectedShareWithAuthority,
  readProtectedShareWithAuthority,
  revokeProtectedShareWithAdmission,
  type ProtectedShareAuthority,
  type ProtectedShareStorageAuthority,
} from "../../src/state/protected-share-operations.js";
import type {
  ProtectedShareEntry,
  ProtectedShareKind,
  ProtectedShareSnapshot,
} from "../../src/state/protected-shares.js";
import { storageEntryOverheadBytes } from "./capacity.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";

export type ProtectedShareRequest = {
  kind: ProtectedShareKind;
  routeId: string;
  recipientProfileIds: readonly string[];
  snapshot: ProtectedShareSnapshot;
  now: number;
};

function context(stateDir: string) {
  return captureProtectedStateWorkerContext(stateDir);
}

export async function createProtectedShare(
  stateDir: string,
  input: ProtectedShareRequest,
  authority: ProtectedShareStorageAuthority,
) {
  const workerContext = context(stateDir);
  const { generation, prepared } = await prepareProtectedShareWithAuthority(
    workerContext,
    {
      ownerProfileId: authority.profileId,
      kind: input.kind,
      routeId: input.routeId,
      recipientProfileIds: input.recipientProfileIds,
      snapshotJson: JSON.stringify(input.snapshot),
      entryOverheadBytes: storageEntryOverheadBytes,
      now: input.now,
    },
    authority,
  );
  if (prepared.status !== "prepared") {
    return prepared;
  }
  authority.assertCurrent();
  const result = await createProtectedShareWithAdmission(
    workerContext,
    { prepared, generation, now: input.now },
    authority,
  );
  if (typeof result === "string") {
    return { status: result };
  }
  return {
    status: "created" as const,
    generation: result.generation,
    resourceId: result.resourceId,
    grants: result.grants.map(({ id, recipientProfileId }) => ({
      grantId: id,
      recipientProfileId,
    })),
  };
}

export async function readProtectedShare(
  stateDir: string,
  input: { profileId: string; kind: ProtectedShareKind; routeId: string },
  authority: ProtectedShareAuthority,
) {
  return readProtectedShareWithAuthority(context(stateDir), input, authority);
}

export async function listProtectedShares(
  stateDir: string,
  input: { profileId: string; relation: "owner" | "recipient" },
  authority: ProtectedShareAuthority,
) {
  return listProtectedSharesWithAuthority(context(stateDir), input, authority);
}

export async function revokeProtectedShare(
  stateDir: string,
  input: { ownerProfileId: string; grantId: string },
  authority: ProtectedShareStorageAuthority,
) {
  const workerContext = context(stateDir);
  const generation = captureProtectedShareStateGeneration(workerContext);
  const retirements = await revokeProtectedShareWithAdmission(
    workerContext,
    {
      ...input,
      entryOverheadBytes: storageEntryOverheadBytes,
      generation,
    },
    authority,
  );
  return Array.isArray(retirements) ? { generation, retirements } : retirements;
}

export async function readProtectedShareStorageUsage(
  stateDir: string,
  profileId: string,
  assertCurrent: () => void,
): Promise<{
  generation: ReturnType<typeof captureProtectedShareStateGeneration>;
  entries: ProtectedShareEntry[];
}> {
  const workerContext = context(stateDir);
  const generation = captureProtectedShareStateGeneration(workerContext);
  const result = await runOpenClawStateWorkerOperation(
    workerContext,
    (scope) =>
      scope.execute({
        type: "protectedShares.storageUsage",
        input: { profileId, entryOverheadBytes: storageEntryOverheadBytes },
      }),
    {
      assertCurrent: () => {
        workerContext.admission.assertCurrent();
        assertCurrent();
      },
    },
  );
  workerContext.admission.assertCurrent();
  assertCurrent();
  const currentGeneration = captureProtectedShareStateGeneration(workerContext);
  if (!isDeepStrictEqual(currentGeneration, generation)) {
    throw new Error("Protected share inventory changed shared-state generation.");
  }
  return { generation, entries: result };
}
