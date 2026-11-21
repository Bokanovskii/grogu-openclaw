import { createHash, randomBytes, randomUUID } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction, type OpenClawStateDatabase } from "./openclaw-state-db.js";

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
};

export type ProtectedAdmission = {
  email: string;
  issuer: string;
  subject?: string;
  profileId?: string;
  status: "approved" | "removed";
  revision: number;
};

const schemaSql = `
CREATE TABLE IF NOT EXISTS protected_access_requests (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  note TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  edit_window_start INTEGER NOT NULL,
  edit_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS protected_admissions (
  email TEXT NOT NULL PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT,
  profile_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_protected_admissions_subject
  ON protected_admissions(subject);

CREATE TABLE IF NOT EXISTS protected_usage_daily (
  profile_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY(profile_id, day)
) STRICT;
`;

export function ensureProtectedAdmissionSchema(database: OpenClawStateDatabase): void {
  database.db.exec(schemaSql);
}

function normalizeEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return undefined;
  }
  return email;
}

function receiptHash(receipt: string): string {
  return createHash("sha256").update(receipt).digest("hex");
}

export function submitProtectedAccessRequest(
  database: OpenClawStateDatabase,
  input: { email: string; name: string; note: string; now: number },
): { request: ProtectedAccessRequest; receipt?: string } | undefined {
  const email = normalizeEmail(input.email);
  if (!email || input.name.trim().length > 80 || input.note.length > 1000) {
    return undefined;
  }
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const existing = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select(["id", "email", "name", "note", "status", "created_at", "updated_at"])
          .where("email", "=", email),
      ).rows[0];
      if (existing) {
        return {
          request: {
            id: String(existing.id),
            email: String(existing.email),
            name: String(existing.name),
            note: String(existing.note),
            status: String(existing.status) as ProtectedAccessRequest["status"],
            createdAt: Number(existing.created_at),
            updatedAt: Number(existing.updated_at),
          },
        };
      }
      const openCount = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select(({ fn }) => fn.count<number>("id").as("count"))
          .where("status", "=", "open"),
      ).rows[0]?.count;
      if (Number(openCount ?? 0) >= 50) {
        return undefined;
      }
      const id = randomUUID();
      const receipt = randomBytes(32).toString("base64url");
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db).insertInto("protected_access_requests").values({
          id,
          email,
          name: input.name.trim(),
          note: input.note,
          receipt_hash: receiptHash(receipt),
          status: "open",
          edit_window_start: input.now,
          edit_count: 0,
          created_at: input.now,
          updated_at: input.now,
        }),
      );
      return {
        request: {
          id,
          email,
          name: input.name.trim(),
          note: input.note,
          status: "open",
          createdAt: input.now,
          updatedAt: input.now,
        },
        receipt,
      };
    },
    { path: database.path },
    { operationLabel: "protected.access-request.submit" },
  );
}

export function readProtectedAccessRequest(
  database: OpenClawStateDatabase,
  receipt: string,
): ProtectedAccessRequest | undefined {
  ensureProtectedAdmissionSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely(database.db)
      .selectFrom("protected_access_requests")
      .select(["id", "email", "name", "note", "status", "created_at", "updated_at"])
      .where("receipt_hash", "=", receiptHash(receipt)),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    note: String(row.note),
    status: String(row.status) as ProtectedAccessRequest["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function editProtectedAccessRequest(
  database: OpenClawStateDatabase,
  input: { receipt: string; name: string; note: string; now: number },
): ProtectedAccessRequest | "rate_limit" | undefined {
  if (input.name.trim().length > 80 || input.note.length > 1000) {
    return undefined;
  }
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const hash = receiptHash(input.receipt);
      const row = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select([
            "id",
            "email",
            "name",
            "note",
            "status",
            "edit_window_start",
            "edit_count",
            "created_at",
            "updated_at",
          ])
          .where("receipt_hash", "=", hash),
      ).rows[0];
      if (!row) {
        return undefined;
      }
      if (String(row.status) !== "open" && String(row.status) !== "denied") {
        return undefined;
      }
      const windowStart = Number(row.edit_window_start);
      const count = Number(row.edit_count);
      const nextCount = input.now - windowStart < 60 * 60_000 ? count + 1 : 1;
      if (nextCount > 10) {
        return "rate_limit";
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_access_requests")
          .set({
            name: input.name.trim(),
            note: input.note,
            status: "open",
            edit_window_start: input.now - windowStart < 60 * 60_000 ? windowStart : input.now,
            edit_count: nextCount,
            updated_at: input.now,
          })
          .where("receipt_hash", "=", hash),
      );
      return {
        id: String(row.id),
        email: String(row.email),
        name: input.name.trim(),
        note: input.note,
        status: "open" as const,
        createdAt: Number(row.created_at),
        updatedAt: input.now,
      };
    },
    { path: database.path },
    { operationLabel: "protected.access-request.edit" },
  );
}

export function listProtectedAccessRequests(database: OpenClawStateDatabase): ProtectedAccessRequest[] {
  ensureProtectedAdmissionSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely(database.db)
      .selectFrom("protected_access_requests")
      .select(["id", "email", "name", "note", "status", "created_at", "updated_at"])
      .orderBy("created_at", "desc")
      .limit(50),
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    note: String(row.note),
    status: String(row.status) as ProtectedAccessRequest["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export function setProtectedRequestStatus(
  database: OpenClawStateDatabase,
  input: { id: string; status: "approved" | "denied" | "removed" | "withdrawn"; now: number; issuer: string },
): ProtectedAccessRequest | undefined {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
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
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_access_requests")
          .set({ status: input.status, updated_at: input.now })
          .where("id", "=", input.id),
      );
      if (input.status === "approved") {
        const email = String(row.email);
        const existing = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .selectFrom("protected_admissions")
            .select(["revision"])
            .where("email", "=", email),
        ).rows[0];
        const revision = existing ? Number(existing.revision) + 1 : 1;
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .insertInto("protected_admissions")
            .values({
              email,
              issuer: input.issuer,
              subject: null,
              profile_id: null,
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
      }
      let subject: string | undefined;
      let profileId: string | undefined;
      if (input.status === "removed") {
        const admission = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .selectFrom("protected_admissions")
            .select(["subject", "profile_id", "revision"])
            .where("email", "=", String(row.email)),
        ).rows[0];
        subject = admission?.subject === null ? undefined : admission?.subject?.toString();
        profileId =
          admission?.profile_id === null ? undefined : admission?.profile_id?.toString();
        const revision = admission ? Number(admission.revision) + 1 : 1;
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .updateTable("protected_admissions")
            .set({ status: "removed", revision, updated_at: input.now })
            .where("email", "=", String(row.email)),
        );
      }
      return {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        note: String(row.note),
        status: input.status,
        createdAt: Number(row.created_at),
        updatedAt: input.now,
        subject,
        profileId,
      };
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
      for (const subject of input.subjects) {
        const existing = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .selectFrom("protected_admissions")
            .select(["email"])
            .where("subject", "=", subject),
        ).rows[0];
        if (existing) {
          continue;
        }
        const email = `migrated-subject-${subject}@invalid.local`;
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .insertInto("protected_admissions")
            .values({
              email,
              issuer: input.issuer,
              subject,
              profile_id: null,
              status: "approved",
              revision: 1,
              created_at: input.now,
              updated_at: input.now,
            })
            .onConflict((conflict) =>
              conflict.column("email").doUpdateSet({
                issuer: input.issuer,
                subject,
                status: "approved",
                revision: 1,
                updated_at: input.now,
              }),
            ),
        );
        inserted++;
      }
    },
    { path: database.path },
    { operationLabel: "protected.admission.migrate" },
  );
  return inserted;
}

export function bindProtectedAdmission(
  database: OpenClawStateDatabase,
  input: { issuer: string; email: string; subject: string; now: number },
): boolean {
  const email = normalizeEmail(input.email);
  if (!email) {
    return false;
  }
  ensureProtectedAdmissionSchema(database);
  let allowed = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_admissions")
          .select(["issuer", "subject", "status"])
          .where("email", "=", email),
      ).rows[0];
      if (!row || String(row.issuer) !== input.issuer || String(row.status) !== "approved") {
        return;
      }
      const bound = row.subject === null ? null : String(row.subject);
      if (bound !== null && bound !== input.subject) {
        return;
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_admissions")
          .set({ subject: input.subject, updated_at: input.now })
          .where("email", "=", email),
      );
      allowed = true;
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
      .selectFrom("protected_admissions")
      .select(["email", "issuer", "subject", "profile_id", "status", "revision"])
      .orderBy("updated_at", "desc")
      .limit(50),
  ).rows;
  return rows.map((row) => ({
    email: String(row.email),
    issuer: String(row.issuer),
    subject: row.subject === null ? undefined : String(row.subject),
    profileId: row.profile_id === null ? undefined : String(row.profile_id),
    status: String(row.status) as ProtectedAdmission["status"],
    revision: Number(row.revision),
  }));
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
          .select(["status"])
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
          .set({ profile_id: input.profileId, updated_at: input.now })
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
