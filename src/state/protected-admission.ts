import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
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
import type {
  ProtectedAutomationDatabase,
  ProtectedAutomationStorageUsage,
} from "./protected-automations.js";

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
};

const getNodeSqliteKysely = (db: DatabaseSync) =>
  getTypedSqliteKysely<ProtectedAdmissionDatabase>(db);

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_access_requests",
  additionalTables: [
    "protected_admissions",
    "protected_admission_migrations",
    "protected_policy_sync",
    "protected_policy_barrier",
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

export function removeProtectedAdmission(
  database: OpenClawStateDatabase,
  input: { id: string; issuer: string; ownerSubject: string; now: number },
): ProtectedAdmission | "owner_protected" | undefined {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "removed" });
      const admission = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["id", "email", "issuer", "subject", "profile_id", "status", "revision"])
          .where("id", "=", input.id)
          .where("issuer", "=", input.issuer),
      ).rows[0];
      if (!admission || admission.status !== "approved") {
        return undefined;
      }
      if (admission.subject === input.ownerSubject) {
        return "owner_protected";
      }
      const revision = admission.revision + 1;
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_admissions")
          .set({ status: "removed", revision, updated_at: input.now })
          .where("id", "=", admission.id),
      );
      // Save-only drafts need no scheduler drain. Leave all wider retirement to its owner.
      const profileId = admission.profile_id;
      let retiredAutomations: ProtectedAutomationStorageUsage["entries"] = [];
      if (profileId && getAdmittedSqliteSchemaFacts(db)?.tables.has("protected_automations")) {
        retiredAutomations = executeSqliteQuerySync(
          db,
          getTypedSqliteKysely<ProtectedAutomationDatabase>(db)
            .deleteFrom("protected_automations")
            .where("creator_profile_id", "=", profileId)
            .where("central_owner_profile_id", "=", profileId)
            .where("visibility", "=", "private")
            .where("enabled", "=", 0)
            .where((expression) =>
              expression.exists(
                expression
                  .selectFrom("protected_automation_members")
                  .select("automation_id")
                  .whereRef("automation_id", "=", "protected_automations.id")
                  .where("profile_id", "=", profileId)
                  .where("role", "=", "owner"),
              ),
            )
            .where((expression) =>
              expression.not(
                expression.exists(
                  expression
                    .selectFrom("protected_automation_members")
                    .select("automation_id")
                    .whereRef("automation_id", "=", "protected_automations.id")
                    .where("profile_id", "!=", profileId)
                    .where("role", "=", "owner"),
                ),
              ),
            )
            .where((expression) =>
              expression.not(
                expression.exists(
                  expression
                    .selectFrom("protected_automation_job_bindings")
                    .select("automation_id")
                    .whereRef("automation_id", "=", "protected_automations.id"),
                ),
              ),
            )
            .returning([
              "id",
              "central_owner_profile_id as profileId",
              /* kysely-allow-raw: SQLite BLOB length counts UTF-8 bytes for deleted definitions. */
              sql<number>`length(CAST(definition_json AS BLOB))`.as("definitionBytes"),
            ]),
        ).rows;
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
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "removed" });
      deferSqliteWorkerCommitReceipt(db, { ...result, retiredAutomations });
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
  let changed = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["status", "last_active_at"])
          .where("issuer", "=", input.issuer)
          .where("subject", "=", input.subject),
      ).rows[0];
      if (!row || String(row.status) !== "approved") {
        return;
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_admissions")
          .set({
            profile_id: input.profileId,
            updated_at: input.now,
            last_active_at: Math.max(row.last_active_at ?? 0, input.now),
          })
          .where("issuer", "=", input.issuer)
          .where("subject", "=", input.subject),
      );
      changed = true;
    },
    { path: database.path },
    { operationLabel: "protected.admission.bind-profile" },
  );
  return changed;
}
