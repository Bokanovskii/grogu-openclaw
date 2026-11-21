import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureProtectedAdmissionSchema,
  type ProtectedAdmissionDatabase,
} from "./protected-admission.js";

export type ProtectedPolicyOperation = {
  id: string;
  email: string;
  revision: number;
  desired: "approved" | "removed";
  state: "pending" | "unknown";
};

export function listPendingProtectedPolicy(database: OpenClawStateDatabase): {
  blocked: boolean;
  blockedPersonId?: string;
  operations: ProtectedPolicyOperation[];
} {
  ensureProtectedAdmissionSchema(database);
  const queries = getNodeSqliteKysely<ProtectedAdmissionDatabase>(database.db);
  const barrier = executeSqliteQuerySync(
    database.db,
    queries
      .selectFrom("protected_policy_barrier as barrier")
      .leftJoin("protected_admissions as admission", "admission.email", "barrier.email")
      .select(["barrier.id", "admission.id as person_id"])
      .where("barrier.id", "=", 1),
  ).rows[0];
  const rows = executeSqliteQuerySync(
    database.db,
    queries
      .selectFrom("protected_policy_sync as sync")
      .innerJoin("protected_admissions as admission", "admission.id", "sync.admission_id")
      .select([
        "admission.id",
        "admission.email",
        "admission.revision",
        "admission.status",
        "sync.state",
      ])
      .where("sync.state", "in", ["pending", "unknown"])
      .whereRef("sync.revision", "=", "admission.revision")
      .orderBy("admission.updated_at", "asc")
      .limit(1000),
  ).rows;
  return {
    blocked: barrier !== undefined,
    blockedPersonId: barrier?.person_id ?? undefined,
    operations: rows.flatMap((row) =>
      row.email && (row.state === "pending" || row.state === "unknown")
        ? [
            {
              id: row.id,
              email: row.email,
              revision: row.revision,
              desired: row.status,
              state: row.state,
            },
          ]
        : [],
    ),
  };
}

export function retryProtectedPolicy(
  database: OpenClawStateDatabase,
  input: { id: string; issuer: string },
): boolean {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "retry_policy" });
      const queries = getNodeSqliteKysely<ProtectedAdmissionDatabase>(db);
      const admission = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_admissions")
          .select(["revision", "email"])
          .where("id", "=", input.id)
          .where("issuer", "=", input.issuer),
      ).rows[0];
      if (!admission) {
        return false;
      }
      const barrier = executeSqliteQuerySync(
        db,
        queries.selectFrom("protected_policy_barrier").select(["email"]).where("id", "=", 1),
      ).rows[0];
      if (barrier && barrier.email !== admission.email) {
        return false;
      }
      const updated = executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_policy_sync")
          .set({ state: "pending" })
          .where("admission_id", "=", input.id)
          .where("revision", "=", admission.revision)
          .where("state", "in", barrier ? ["failed", "unknown", "pending"] : ["failed", "unknown"]),
      );
      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        queries.deleteFrom("protected_policy_barrier").where("id", "=", 1),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "retry_policy" });
      deferSqliteWorkerCommitReceipt(db, { status: "retry_policy" });
      return true;
    },
    { path: database.path },
    { operationLabel: "protected.policy.retry" },
  );
}

export function beginProtectedPolicy(
  database: OpenClawStateDatabase,
  input: { id: string; email: string; revision: number },
): boolean {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<ProtectedAdmissionDatabase>(db);
      const current = executeSqliteQuerySync(
        db,
        queries
          .selectFrom("protected_policy_sync as sync")
          .innerJoin("protected_admissions as admission", "admission.id", "sync.admission_id")
          .select("admission.id")
          .where("admission.id", "=", input.id)
          .where("admission.email", "=", input.email)
          .where("admission.revision", "=", input.revision)
          .where("sync.revision", "=", input.revision)
          .where("sync.state", "=", "pending"),
      ).rows[0];
      if (!current) {
        return false;
      }
      const inserted = executeSqliteQuerySync(
        db,
        queries
          .insertInto("protected_policy_barrier")
          .values({ id: 1, email: input.email, revision: input.revision })
          .onConflict((conflict) => conflict.column("id").doNothing()),
      );
      return Number(inserted.numAffectedRows ?? 0) === 1;
    },
    { path: database.path },
    { operationLabel: "protected.policy.begin" },
  );
}

export function settleProtectedPolicy(
  database: OpenClawStateDatabase,
  input: { id: string; email: string; revision: number; state: "synced" | "failed" | "unknown" },
): boolean {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const queries = getNodeSqliteKysely<ProtectedAdmissionDatabase>(db);
      if (input.state === "unknown") {
        executeSqliteQuerySync(
          db,
          queries
            .insertInto("protected_policy_barrier")
            .values({ id: 1, email: input.email, revision: input.revision })
            .onConflict((conflict) =>
              conflict.column("id").doUpdateSet({ email: input.email, revision: input.revision }),
            ),
        );
        const byEmail = executeSqliteQuerySync(
          db,
          queries
            .selectFrom("protected_admissions")
            .select(["id"])
            .where("email", "=", input.email),
        ).rows[0];
        if (byEmail) {
          executeSqliteQuerySync(
            db,
            queries
              .updateTable("protected_policy_sync")
              .set({ state: "unknown" })
              .where("admission_id", "=", byEmail.id),
          );
        }
        return true;
      }
      const barrier = executeSqliteQuerySync(
        db,
        queries
          .deleteFrom("protected_policy_barrier")
          .where("id", "=", 1)
          .where("email", "=", input.email)
          .where("revision", "=", input.revision),
      );
      if (Number(barrier.numAffectedRows ?? 0) !== 1) {
        throw new Error("Protected policy operation lost its reconciliation barrier.");
      }
      const current = executeSqliteQuerySync(
        db,
        queries.selectFrom("protected_admissions").select(["revision"]).where("id", "=", input.id),
      ).rows[0];
      if (!current || current.revision !== input.revision) {
        return false;
      }
      const updated = executeSqliteQuerySync(
        db,
        queries
          .updateTable("protected_policy_sync")
          .set({ state: input.state })
          .where("admission_id", "=", input.id)
          .where("revision", "=", input.revision)
          .where("state", "=", "pending"),
      );
      return Number(updated.numAffectedRows ?? 0) === 1;
    },
    { path: database.path },
    { operationLabel: "protected.policy.settle" },
  );
}
