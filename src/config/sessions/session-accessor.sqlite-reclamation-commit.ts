import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  retainSqliteWriteAdmissionService,
  withSqliteWriteAdmissionService,
} from "../../infra/sqlite-transaction.js";

const COMMIT_DECISION_TIMEOUT_MS = 5_000;
const WAITING = 0;
const REJECTED = 2;
const COMMITTING = 3;
const SETTLED = 4;
const REQUESTED = 5;
const EXPIRED = 6;
const EXPIRED_SETTLED = 7;

/** A refused request may reuse its connection only after native rollback is confirmed. */
export class SqliteReclamationRequestRefusedError extends Error {}

export class SqliteReclamationCommitExpiredError extends SqliteReclamationRequestRefusedError {
  constructor() {
    super("SQLite session reclamation commit checkpoint expired");
  }
}

/** Preserve the reclamation owner's context when an unrelated synchronous writer helps. */
export async function withSqliteReclamationAuthorization<T>(
  buffer: SharedArrayBuffer,
  database: DatabaseSync | string,
  assertCurrent: () => void,
  run: (authorize: () => void) => Promise<T>,
): Promise<T> {
  const shared = new Int32Array(buffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let consumed = false;
  let failure: { error: unknown } | undefined;
  const authorize = () => {
    if (failure) {
      throw failure.error;
    }
    if (consumed) {
      return;
    }
    consumed = true;
    try {
      inOwnerContext(() => {
        assertCurrent();
        // Acceptance is the commit edge. Pending revocation wins this race;
        // accepted work keeps its writer permit and lifetime through native settlement.
        const decision = Atomics.compareExchange(shared, 0, REQUESTED, COMMITTING);
        if (decision !== REQUESTED) {
          if (decision === EXPIRED || decision === EXPIRED_SETTLED) {
            throw new SqliteReclamationCommitExpiredError();
          }
          throw new SqliteReclamationRequestRefusedError(
            "SQLite session reclamation commit checkpoint expired",
          );
        }
        Atomics.notify(shared, 0);
      });
    } catch (error) {
      failure = { error };
      rejectCommit(shared);
      throw error;
    }
  };
  const service = () => {
    if (Atomics.load(shared, 0) === REQUESTED) {
      try {
        authorize();
      } catch {
        // Rejection belongs to reclamation; its queued request propagates the error.
      }
    }
  };
  if (typeof database !== "string") {
    return await withSqliteWriteAdmissionService(database, service, () => run(authorize));
  }
  // The execution owner's admitted native location does not require a host connection.
  const release = retainSqliteWriteAdmissionService([database], service);
  try {
    return await run(authorize);
  } finally {
    release();
  }
}

function rejectCommit(shared: Int32Array): void {
  Atomics.compareExchange(shared, 0, WAITING, REJECTED);
  Atomics.compareExchange(shared, 0, REQUESTED, REJECTED);
  Atomics.notify(shared, 0);
}

/** Revoke a pending request before a synchronous native close can wait on its writer lock. */
export function revokeSqliteReclamationCommit(buffer: SharedArrayBuffer): void {
  rejectCommit(new Int32Array(buffer));
}

/** Called by the Worker while its deletion transaction still owns the writer lock. */
export function waitForSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  request: () => void,
): void {
  const shared = new Int32Array(buffer);
  if (Atomics.compareExchange(shared, 0, WAITING, REQUESTED) !== WAITING) {
    throw new SqliteReclamationRequestRefusedError("SQLite session reclamation commit was revoked");
  }
  request();
  Atomics.wait(shared, 0, REQUESTED, COMMIT_DECISION_TIMEOUT_MS);
  if (Atomics.load(shared, 0) !== COMMITTING) {
    // Only the worker's unaccepted deadline may be retried, never owner revocation.
    const decision = Atomics.compareExchange(shared, 0, REQUESTED, EXPIRED);
    if (decision === COMMITTING) {
      return;
    }
    if (decision === REQUESTED || decision === EXPIRED) {
      Atomics.notify(shared, 0);
      throw new SqliteReclamationCommitExpiredError();
    }
    throw new SqliteReclamationRequestRefusedError(
      "SQLite session reclamation commit was not authorized",
    );
  }
}

/** Publish only after the transaction ended or its connection successfully closed. */
export function markSqliteReclamationSettled(buffer: SharedArrayBuffer | undefined): void {
  if (buffer) {
    const shared = new Int32Array(buffer);
    // A queued parent commit request must still distinguish timeout from revocation.
    const expired = Atomics.compareExchange(shared, 0, EXPIRED, EXPIRED_SETTLED);
    if (expired !== EXPIRED && expired !== EXPIRED_SETTLED) {
      Atomics.store(shared, 0, SETTLED);
    }
    Atomics.notify(shared, 0);
  }
}
