import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely as getTypedSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureProtectedAdmissionSchema,
  normalizeProtectedEmail,
  type ProtectedAccessRequest,
  type ProtectedAdmissionDatabase,
} from "./protected-admission.js";

const getNodeSqliteKysely = (db: DatabaseSync) =>
  getTypedSqliteKysely<ProtectedAdmissionDatabase>(db);
const receiptLifetimeMs = 365 * 24 * 60 * 60_000;
const maxRetainedRequests = 1000;

function receiptHash(receipt: string): string {
  return createHash("sha256").update(receipt).digest("hex");
}

export function submitProtectedAccessRequest(
  database: OpenClawStateDatabase,
  input: { email: string; name: string; note: string; now: number; receipt?: string },
): { request: ProtectedAccessRequest; receipt: string; created: boolean } | undefined {
  const email = normalizeProtectedEmail(input.email);
  if (!email || !input.name.trim() || input.name.length > 80 || input.note.length > 1000) {
    return undefined;
  }
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
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
      const totalCount = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select(({ fn }) => fn.count<number>("id").as("count")),
      ).rows[0]?.count;
      if (Number(totalCount ?? 0) >= maxRetainedRequests) {
        return undefined;
      }
      const existing = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .selectFrom("protected_access_requests")
          .select([
            "id",
            "email",
            "name",
            "note",
            "status",
            "created_at",
            "updated_at",
            "receipt_hash",
          ])
          .where("email", "=", email),
      ).rows[0];
      if (existing) {
        return {
          request: {
            id: String(existing.id),
            email: String(existing.email),
            name: String(existing.name),
            note: String(existing.note),
            status: existing.status,
            createdAt: Number(existing.created_at),
            updatedAt: Number(existing.updated_at),
          },
          receipt:
            input.receipt &&
            existing.created_at > input.now - receiptLifetimeMs &&
            receiptHash(input.receipt) === existing.receipt_hash
              ? input.receipt
              : randomBytes(32).toString("base64url"),
          created: false,
        };
      }
      const id = randomUUID();
      const receipt = randomBytes(32).toString("base64url");
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .insertInto("protected_access_requests")
          .values({
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
        created: true,
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
      .selectFrom("protected_access_requests as request")
      .leftJoin("protected_admissions as admission", "admission.email", "request.email")
      .leftJoin("protected_policy_sync as sync", "sync.admission_id", "admission.id")
      .select([
        "request.id",
        "request.email",
        "request.name",
        "request.note",
        "request.status",
        "request.created_at",
        "request.updated_at",
        "sync.state as policy_state",
      ])
      .where("request.receipt_hash", "=", receiptHash(receipt))
      .where("request.created_at", ">", Date.now() - receiptLifetimeMs),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    note: String(row.note),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    policyState: row.policy_state ?? undefined,
  };
}

export function editProtectedAccessRequest(
  database: OpenClawStateDatabase,
  input: { receipt: string; name: string; note: string; now: number },
): ProtectedAccessRequest | "rate_limit" | undefined {
  if (!input.name.trim() || input.name.length > 80 || input.note.length > 1000) {
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
          .where("receipt_hash", "=", hash)
          .where("created_at", ">", input.now - receiptLifetimeMs),
      ).rows[0];
      if (!row) {
        return undefined;
      }
      if (String(row.status) !== "open" && String(row.status) !== "denied") {
        return undefined;
      }
      if (String(row.status) === "denied") {
        const openCount = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely(db)
            .selectFrom("protected_access_requests")
            .select(({ fn }) => fn.count<number>("id").as("count"))
            .where("status", "=", "open"),
        ).rows[0]?.count;
        if (Number(openCount ?? 0) >= 50) {
          return "rate_limit";
        }
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

export function withdrawProtectedAccessRequest(
  database: OpenClawStateDatabase,
  input: { receipt: string; now: number },
): boolean {
  ensureProtectedAdmissionSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const result = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely(db)
          .updateTable("protected_access_requests")
          .set({ status: "withdrawn", updated_at: input.now })
          .where("receipt_hash", "=", receiptHash(input.receipt))
          .where("created_at", ">", input.now - receiptLifetimeMs)
          .where("status", "in", ["open", "denied"]),
      );
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    { path: database.path },
    { operationLabel: "protected.access-request.withdraw" },
  );
}

export function listProtectedAccessRequests(
  database: OpenClawStateDatabase,
): ProtectedAccessRequest[] {
  ensureProtectedAdmissionSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely(database.db)
      .selectFrom("protected_access_requests as request")
      .leftJoin("protected_admissions as admission", "admission.email", "request.email")
      .leftJoin("protected_policy_sync as sync", "sync.admission_id", "admission.id")
      .select([
        "request.id",
        "request.email",
        "request.name",
        "request.note",
        "request.status",
        "request.created_at",
        "request.updated_at",
        "sync.state as policy_state",
      ])
      .orderBy("request.created_at", "desc")
      .limit(maxRetainedRequests),
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    note: String(row.note),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    policyState: row.policy_state ?? undefined,
  }));
}
