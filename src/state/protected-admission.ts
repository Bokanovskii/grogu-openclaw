import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely as getTypedSqliteKysely,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import {
  hasProtectedAutomationMemberStorage,
  retireProtectedAutomationMemberDefinitions,
  retireProtectedAutomationMemberStorage,
} from "./protected-automation-lifecycle-cleanup.js";
import { removeProtectedMemberAutomationSharingRows } from "./protected-automation-sharing.js";
import type { ProtectedAutomationStorageUsage } from "./protected-automations.js";
import { removeProtectedMemberFeedbackRows } from "./protected-feedback-reports.js";
import type { ProtectedStoredDataRetirement } from "./protected-feedback.js";
import { removeProtectedMemberSharingRows } from "./protected-sharing.js";

export type ProtectedAccessRequest = {
  id: string;
  email: string;
  name: string;
  note: string;
  status: "open" | "approved" | "denied" | "removed" | "withdrawn";
  createdAt: number;
  updatedAt: number;
  subject?: string;
  profileId?: string;
  policyState?: "pending" | "synced" | "failed" | "unknown";
};

export type ProtectedAdmission = {
  id: string;
  email: string | null;
  issuer: string;
  subject?: string;
  profileId?: string;
  lastActiveAt?: number;
  status: "approved" | "removed";
  revision: number;
  policyState?: "pending" | "synced" | "failed" | "unknown";
};

export type ProtectedAdmissionRemovalInput = {
  id: string;
  issuer: string;
  ownerSubject: string;
  now: number;
  storageOverheadBytes: number;
  retireAutomationStorage?: true;
  expectedProfileId?: string | null;
  expectedRevision?: number;
};

export type ProtectedAdmissionAutomationRetirementFacts = {
  kind: "protected-member-automation-retirement";
  id: string;
  issuer: string;
  ownerSubject: string;
  now: number;
  expectedProfileId: string | null;
  expectedRevision: number;
};

export type ProtectedAdmissionDatabase = {
  protected_access_requests: {
    id: string;
    email: string;
    name: string;
    note: string;
    receipt_hash: string;
    status: ProtectedAccessRequest["status"];
    edit_window_start: number;
    edit_count: number;
    created_at: number;
    updated_at: number;
  };
  protected_admissions: {
    id: string;
    email: string | null;
    issuer: string;
    subject: string | null;
    profile_id: string | null;
    last_active_at: number | null;
    status: ProtectedAdmission["status"];
    revision: number;
    created_at: number;
    updated_at: number;
  };
  protected_admission_migrations: {
    issuer: string;
    completed_at: number;
  };
  protected_policy_sync: {
    admission_id: string;
    revision: number;
    state: "pending" | "synced" | "failed" | "unknown";
  };
  protected_policy_barrier: { id: number; email: string; revision: number };
  protected_storage_limits: { admission_id: string; limit_bytes: number; updated_at: number };
};

const getNodeSqliteKysely = (db: DatabaseSync) =>
  getTypedSqliteKysely<ProtectedAdmissionDatabase>(db);

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_access_requests",
  migrateExistingTables: ["protected_automations"],
  additionalTables: [
    "protected_admissions",
    "protected_admission_migrations",
    "protected_policy_sync",
    "protected_policy_barrier",
    "protected_storage_limits",
    "protected_usage_daily",
    "protected_usage_runs",
  ],
  indexes: ["idx_protected_usage_daily_day", "idx_protected_usage_runs_day"],
  endMarker: "  ON protected_usage_runs(day);\n",
  operationLabel: "protected.admission.schema",
});
export function ensureProtectedAdmissionSchema(database: OpenClawStateDatabase): void {
  ensureSchema({ database, path: database.path });
}

export function normalizeProtectedEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return undefined;
  }
  return email;
}

export function setProtectedRequestStatus(
  database: OpenClawStateDatabase,
  input: {
    id: string;
    status: "approved" | "denied";
    now: number;
    issuer: string;
  },
): ProtectedAccessRequest | "admission_conflict" | undefined {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: input.status });
      const row = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select(["id", "email", "name", "note", "status", "created_at", "updated_at"])
          .where("id", "=", input.id),
      ).rows[0];
      if (!row) {
        return undefined;
      }
      if (row.status !== "open") {
        return undefined;
      }
      const existing =
        input.status === "approved"
          ? executeSqliteQuerySync(
              db,
              getNodeSqliteKysely(db)
                .selectFrom("protected_admissions")
                .select(["id", "revision", "status", "issuer"])
                .where("email", "=", row.email),
            ).rows[0]
          : undefined;
      if (existing && (existing.status === "removed" || existing.issuer !== input.issuer)) {
        return "admission_conflict";
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_access_requests")
          .set({ status: input.status, updated_at: input.now })
          .where("id", "=", input.id),
      );
      if (input.status === "approved") {
        const email = String(row.email);
        const revision = existing ? Number(existing.revision) + 1 : 1;
        const admissionId = existing?.id ?? randomUUID();
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .insertInto("protected_admissions")
            .values({
              id: admissionId,
              email,
              issuer: input.issuer,
              subject: null,
              profile_id: null,
              last_active_at: null,
              status: "approved",
              revision,
              created_at: input.now,
              updated_at: input.now,
            })
            .onConflict((conflict) =>
              conflict.column("email").doUpdateSet({
                issuer: input.issuer,
                status: "approved",
                revision,
                updated_at: input.now,
              }),
            ),
        );
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .insertInto("protected_policy_sync")
            .values({ admission_id: admissionId, revision, state: "pending" })
            .onConflict((conflict) =>
              conflict.column("admission_id").doUpdateSet({ revision, state: "pending" }),
            ),
        );
      }
      const result = {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        note: String(row.note),
        status: input.status,
        createdAt: Number(row.created_at),
        updatedAt: input.now,
      };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: input.status });
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { path: database.path },
    { operationLabel: "protected.access-request.status" },
  );
}

export function migrateProtectedSubjects(
  database: OpenClawStateDatabase,
  input: { subjects: readonly string[]; issuer: string; now: number },
): number {
  ensureProtectedAdmissionSchema(database);
  let inserted = 0;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const completed = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admission_migrations")
          .select(["issuer"])
          .where("issuer", "=", input.issuer),
      ).rows[0];
      if (completed) {
        return;
      }
      for (const subject of input.subjects) {
        const existing = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .selectFrom("protected_admissions")
            .select(["id"])
            .where("issuer", "=", input.issuer)
            .where("subject", "=", subject),
        ).rows[0];
        if (existing) {
          continue;
        }
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db).insertInto("protected_admissions").values({
            id: randomUUID(),
            email: null,
            issuer: input.issuer,
            subject,
            profile_id: null,
            last_active_at: null,
            status: "approved",
            revision: 1,
            created_at: input.now,
            updated_at: input.now,
          }),
        );
        inserted++;
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .insertInto("protected_admission_migrations")
          .values({ issuer: input.issuer, completed_at: input.now }),
      );
    },
    { path: database.path },
    { operationLabel: "protected.admission.migrate" },
  );
  return inserted;
}

export function addProtectedSubject(
  database: OpenClawStateDatabase,
  input: { issuer: string; subject: string; now: number },
): "added" | "existing" | "removed" {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["status"])
          .where("issuer", "=", input.issuer)
          .where("subject", "=", input.subject),
      ).rows[0];
      if (current) {
        return current.status === "removed" ? "removed" : "existing";
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db).insertInto("protected_admissions").values({
          id: randomUUID(),
          email: null,
          issuer: input.issuer,
          subject: input.subject,
          profile_id: null,
          last_active_at: null,
          status: "approved",
          revision: 1,
          created_at: input.now,
          updated_at: input.now,
        }),
      );
      return "added";
    },
    { path: database.path },
    { operationLabel: "protected.admission.add-subject" },
  );
}

export function bindProtectedAdmission(
  database: OpenClawStateDatabase,
  input: { issuer: string; email: string; subject: string; now: number },
): boolean {
  const email = normalizeProtectedEmail(input.email);
  if (!email) {
    return false;
  }
  ensureProtectedAdmissionSchema(database);
  let allowed = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: input.subject });
      const byEmail = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["id", "issuer", "subject", "profile_id", "status", "revision"])
          .where("email", "=", email),
      ).rows[0];
      const bySubject = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["id", "email", "status", "revision"])
          .where("issuer", "=", input.issuer)
          .where("subject", "=", input.subject),
      ).rows[0];
      if (bySubject) {
        if (bySubject.status !== "approved" || (bySubject.email && bySubject.email !== email)) {
          return;
        }
        const mergedApproval = byEmail && byEmail.id !== bySubject.id;
        if (mergedApproval) {
          if (
            byEmail.issuer !== input.issuer ||
            byEmail.status !== "approved" ||
            byEmail.subject !== null ||
            byEmail.profile_id !== null
          ) {
            return;
          }
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely(db).deleteFrom("protected_admissions").where("id", "=", byEmail.id),
          );
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely(db)
              .deleteFrom("protected_policy_sync")
              .where("admission_id", "=", byEmail.id),
          );
        }
        const revision =
          Math.max(bySubject.revision, byEmail?.revision ?? 0) + (mergedApproval ? 1 : 0);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .updateTable("protected_admissions")
            .set({
              email,
              revision,
              updated_at: input.now,
            })
            .where("id", "=", bySubject.id),
        );
        if (bySubject.email === null) {
          const state = mergedApproval ? "pending" : "synced";
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely(db)
              .insertInto("protected_policy_sync")
              .values({ admission_id: bySubject.id, revision, state })
              .onConflict((conflict) =>
                conflict.column("admission_id").doUpdateSet({ revision, state }),
              ),
          );
        }
        allowed = true;
      } else if (
        byEmail &&
        byEmail.issuer === input.issuer &&
        byEmail.status === "approved" &&
        byEmail.subject === null
      ) {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .updateTable("protected_admissions")
            .set({ subject: input.subject, updated_at: input.now })
            .where("id", "=", byEmail.id),
        );
        allowed = true;
      } else {
        return;
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: input.subject });
      deferSqliteWorkerCommitReceipt(db, { subject: input.subject });
    },
    { path: database.path },
    { operationLabel: "protected.admission.bind" },
  );
  return allowed;
}

export function listProtectedAdmissions(database: OpenClawStateDatabase): ProtectedAdmission[] {
  ensureProtectedAdmissionSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely(database.db)
      .selectFrom("protected_admissions as admission")
      .leftJoin("protected_policy_sync as sync", "sync.admission_id", "admission.id")
      .select([
        "admission.id",
        "admission.email",
        "admission.issuer",
        "admission.subject",
        "admission.profile_id",
        "admission.last_active_at",
        "admission.status",
        "admission.revision",
        "sync.state as policy_state",
      ])
      .orderBy("admission.updated_at", "desc"),
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    email: row.email,
    issuer: String(row.issuer),
    subject: row.subject === null ? undefined : String(row.subject),
    profileId: row.profile_id === null ? undefined : String(row.profile_id),
    lastActiveAt: row.last_active_at ?? undefined,
    status: row.status,
    revision: Number(row.revision),
    policyState: row.policy_state ?? undefined,
  }));
}

export function isProtectedAdmissionCurrent(
  database: OpenClawStateDatabase,
  input: { id: string; profileId: string; issuer: string; subject: string; revision: number },
): boolean {
  return Boolean(
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely(database.db)
        .selectFrom("protected_admissions")
        .select("id")
        .where("id", "=", input.id)
        .where("profile_id", "=", input.profileId)
        .where("issuer", "=", input.issuer)
        .where("subject", "=", input.subject)
        .where("revision", "=", input.revision)
        .where("status", "=", "approved"),
    ).rows[0],
  );
}

export function removeProtectedAdmission(
  database: OpenClawStateDatabase,
  input: ProtectedAdmissionRemovalInput,
): ProtectedAdmission | "owner_protected" | undefined {
  if (!Number.isSafeInteger(input.storageOverheadBytes) || input.storageOverheadBytes < 0) {
    throw new Error("Protected member removal storage overhead is invalid.");
  }
  let retirementFacts: ProtectedAdmissionAutomationRetirementFacts | undefined;
  if (input.retireAutomationStorage === true) {
    const expectedProfileId = input.expectedProfileId;
    const expectedRevision = input.expectedRevision;
    if (
      (expectedProfileId !== null &&
        (typeof expectedProfileId !== "string" || !expectedProfileId)) ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "Member retirement requires its exact admission revision and accounting profile.",
      );
    }
    retirementFacts = {
      kind: "protected-member-automation-retirement",
      id: input.id,
      issuer: input.issuer,
      ownerSubject: input.ownerSubject,
      now: input.now,
      expectedProfileId,
      expectedRevision,
    };
  }
  const removalFacts = retirementFacts ?? "removed";
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: removalFacts });
      const admission = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["id", "email", "issuer", "subject", "profile_id", "status", "revision"])
          .where("id", "=", input.id)
          .where("issuer", "=", input.issuer),
      ).rows[0];
      // Fenced owner recovery may retire older removal leftovers without reactivating the member.
      if (!admission || (admission.status !== "approved" && !retirementFacts)) {
        return undefined;
      }
      if (admission.subject === input.ownerSubject) {
        return "owner_protected";
      }
      if (
        retirementFacts &&
        (admission.profile_id !== retirementFacts.expectedProfileId ||
          admission.revision !== retirementFacts.expectedRevision)
      ) {
        throw new Error(
          "Member retirement target changed; refresh its admission and writer fence.",
        );
      }
      const profileId = admission.profile_id;
      if (!retirementFacts && profileId && hasProtectedAutomationMemberStorage(db, profileId)) {
        throw new Error("Member removal requires fenced automation storage retirement authority.");
      }
      const retiredStoredData =
        retirementFacts && profileId ? retireProtectedAutomationMemberStorage(db, profileId) : [];
      const revision = admission.revision + 1;
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_admissions")
          .set({ status: "removed", revision, updated_at: input.now })
          .where("id", "=", admission.id),
      );
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .deleteFrom("protected_storage_limits")
          .where("admission_id", "=", admission.id),
      );
      const retiredStoredDataChanges: ProtectedStoredDataRetirement[] = profileId
        ? [
            ...removeProtectedMemberFeedbackRows(db, profileId, input.storageOverheadBytes),
            ...[
              ...removeProtectedMemberSharingRows(db, profileId, input.storageOverheadBytes),
              ...removeProtectedMemberAutomationSharingRows(
                db,
                profileId,
                input.storageOverheadBytes,
              ),
            ].map((removed) => ({ removed })),
          ]
        : [];
      let retiredAutomations: ProtectedAutomationStorageUsage["entries"] = [];
      if (profileId && getAdmittedSqliteSchemaFacts(db)?.tables.has("protected_automations")) {
        retiredAutomations = retireProtectedAutomationMemberDefinitions(
          db,
          profileId,
          Boolean(retirementFacts),
        );
      }
      if (admission.email) {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .updateTable("protected_access_requests")
            .set({ status: "removed", updated_at: input.now })
            .where("email", "=", admission.email)
            .where("status", "in", ["open", "approved"]),
        );
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .insertInto("protected_policy_sync")
            .values({ admission_id: admission.id, revision, state: "pending" })
            .onConflict((conflict) =>
              conflict.column("admission_id").doUpdateSet({ revision, state: "pending" }),
            ),
        );
      }
      const result: ProtectedAdmission = {
        id: admission.id,
        email: admission.email,
        issuer: admission.issuer,
        subject: admission.subject ?? undefined,
        profileId: admission.profile_id ?? undefined,
        status: "removed",
        revision,
      };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: removalFacts });
      deferSqliteWorkerCommitReceipt(db, {
        ...result,
        retiredAutomations,
        retiredStoredData,
        retiredStoredDataChanges,
        ...(retirementFacts
          ? {
              kind: "protected-member-automation-retired",
              ownerSubject: retirementFacts.ownerSubject,
              previousRevision: retirementFacts.expectedRevision,
            }
          : {}),
      });
      return result;
    },
    { path: database.path },
    { operationLabel: "protected.admission.remove" },
  );
}

export function bindProtectedProfile(
  database: OpenClawStateDatabase,
  input: { issuer: string; subject: string; profileId: string; now: number },
): boolean {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => bindProtectedProfileInTransaction(db, input),
    { path: database.path },
    { operationLabel: "protected.admission.bind-profile" },
  );
}

export function bindProtectedProfileInTransaction(
  db: DatabaseSync,
  input: { issuer: string; subject: string; profileId: string; now: number },
): boolean {
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely(db)
      .updateTable("protected_admissions")
      .set((eb) => ({
        profile_id: input.profileId,
        updated_at: input.now,
        last_active_at: eb.fn<number>("max", [
          eb.fn.coalesce("last_active_at", eb.val(0)),
          eb.val(input.now),
        ]),
      }))
      .where("status", "=", "approved")
      .where("issuer", "=", input.issuer)
      .where("subject", "=", input.subject),
  );
  return Number(result.numAffectedRows) > 0;
}
