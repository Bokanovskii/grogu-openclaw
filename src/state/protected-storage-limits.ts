import type { DatabaseSync } from "node:sqlite";
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

export type ProtectedStorageLimit = {
  profileId: string | null;
  exempt: boolean;
  customLimitBytes: number | null;
};

const kysely = (db: DatabaseSync) => getNodeSqliteKysely<ProtectedAdmissionDatabase>(db);

function readLimit(
  db: DatabaseSync,
  input: { id: string; issuer: string; ownerSubject: string },
): ProtectedStorageLimit | undefined {
  const row = executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("protected_admissions as admission")
      .leftJoin("protected_storage_limits as custom", "custom.admission_id", "admission.id")
      .select(["admission.subject", "admission.profile_id", "custom.limit_bytes"])
      .where("admission.id", "=", input.id)
      .where("admission.issuer", "=", input.issuer)
      .where("admission.status", "=", "approved"),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  const exempt = row.subject === input.ownerSubject;
  return {
    profileId: row.profile_id,
    exempt,
    customLimitBytes: exempt ? null : (row.limit_bytes ?? null),
  };
}

export function readProtectedStorageLimit(
  database: OpenClawStateDatabase,
  input: { id: string; issuer: string; ownerSubject: string },
): ProtectedStorageLimit | undefined {
  ensureProtectedAdmissionSchema(database);
  return readLimit(database.db, input);
}

/** Returns the custom limit for an approved member profile, or null for the default. */
export function readProtectedProfileStorageLimit(
  database: OpenClawStateDatabase,
  input: { profileId: string; issuer: string },
): number | null {
  ensureProtectedAdmissionSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    kysely(database.db)
      .selectFrom("protected_admissions as admission")
      .innerJoin("protected_storage_limits as custom", "custom.admission_id", "admission.id")
      .select("custom.limit_bytes")
      .where("admission.profile_id", "=", input.profileId)
      .where("admission.issuer", "=", input.issuer)
      .where("admission.status", "=", "approved"),
  ).rows[0];
  return row?.limit_bytes ?? null;
}

/** Compare-and-set the custom limit; `limitBytes: null` restores the default. */
export function setProtectedStorageLimit(
  database: OpenClawStateDatabase,
  input: {
    id: string;
    issuer: string;
    ownerSubject: string;
    expectedLimitBytes: number | null;
    limitBytes: number | null;
    now: number;
  },
): ProtectedStorageLimit | "exempt" | "version_conflict" | undefined {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "storage_limit" });
      const current = readLimit(db, input);
      if (!current) {
        return undefined;
      }
      if (current.exempt) {
        return "exempt";
      }
      if (current.customLimitBytes !== input.expectedLimitBytes) {
        return "version_conflict";
      }
      const limitBytes = input.limitBytes;
      if (limitBytes === null) {
        executeSqliteQuerySync(
          db,
          kysely(db).deleteFrom("protected_storage_limits").where("admission_id", "=", input.id),
        );
      } else {
        executeSqliteQuerySync(
          db,
          kysely(db)
            .insertInto("protected_storage_limits")
            .values({ admission_id: input.id, limit_bytes: limitBytes, updated_at: input.now })
            .onConflict((conflict) =>
              conflict
                .column("admission_id")
                .doUpdateSet({ limit_bytes: limitBytes, updated_at: input.now }),
            ),
        );
      }
      const result = { ...current, customLimitBytes: limitBytes };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "storage_limit" });
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { path: database.path },
    { operationLabel: "protected.storage-limit.set" },
  );
}
