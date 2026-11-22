import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { Value } from "typebox/value";
import {
  ProtectedAutomationDraftSchema,
  type ProtectedAutomationDraft,
} from "../../packages/gateway-protocol/src/protected.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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
  ensureProtectedAdmissionSchema,
  type ProtectedAdmissionDatabase,
} from "./protected-admission.js";

type AutomationVisibility = "private" | "shared";
type AutomationRelation = "owner" | "follower" | "published";

export type ProtectedAutomationDatabase = ProtectedAdmissionDatabase & {
  protected_automations: {
    id: string;
    creator_profile_id: string;
    central_owner_profile_id: string;
    provider: "sparky";
    definition_json: string;
    definition_revision: number;
    visibility: AutomationVisibility;
    publication_revision: number;
    enabled: number;
    created_at: number;
    updated_at: number;
  };
  protected_automation_members: {
    automation_id: string;
    profile_id: string;
    role: "owner" | "follower";
    added_at: number;
  };
  protected_automation_job_bindings: {
    job_id: string;
    automation_id: string;
    central_owner_profile_id: string;
    definition_revision: number;
    created_at: number;
    updated_at: number;
  };
};

const ensureAutomationSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_automations",
  additionalTables: ["protected_automation_members", "protected_automation_job_bindings"],
  indexes: [
    "idx_protected_automations_owner",
    "idx_protected_automation_members_profile_role",
    "idx_protected_automation_job_bindings_owner",
  ],
  endMarker: "  ON protected_automation_job_bindings(central_owner_profile_id, automation_id);\n",
  operationLabel: "protected.automations.schema",
});

export type ProtectedAutomationStorageRecord = {
  id: string;
  creatorProfileId: string;
  centralOwnerProfileId: string;
  provider: "sparky";
  definition: ProtectedAutomationDraft;
  definitionRevision: number;
  visibility: AutomationVisibility;
  publicationRevision: number;
  enabled: boolean;
  relation: AutomationRelation;
  createdAt: number;
  updatedAt: number;
};

export type ProtectedAutomationStorageUsage = {
  totalDefinitionBytes: number;
  totalRecords: number;
  profileDefinitionBytes: number;
  profileRecords: number;
  profiles: Array<{ profileId: string; definitionBytes: number; records: number }>;
};

export type ProtectedAutomationJobBinding = {
  jobId: string;
  automationId: string;
  centralOwnerProfileId: string;
  definitionRevision: number;
  createdAt: number;
  updatedAt: number;
};

export type BindProtectedAutomationJobResult =
  | { status: "bound"; binding: ProtectedAutomationJobBinding }
  | {
      status:
        | "member_inactive"
        | "automation_not_found"
        | "owner_mismatch"
        | "definition_revision_mismatch"
        | "binding_conflict";
    };

type AutomationRow = {
  id: string;
  creator_profile_id: string;
  central_owner_profile_id: string;
  provider: "sparky";
  definition_json: string;
  definition_revision: number;
  visibility: AutomationVisibility;
  publication_revision: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  member_role: "owner" | "follower" | null;
};

function typedDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<ProtectedAutomationDatabase>(db);
}

function ensureSchema(database: OpenClawStateDatabase): void {
  ensureProtectedAdmissionSchema(database);
  ensureAutomationSchema({ database, path: database.path });
}

function parseDefinition(definitionJson: string): ProtectedAutomationDraft {
  let definition: unknown;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    throw new Error("Stored protected automation definition is invalid JSON.");
  }
  if (!Value.Check(ProtectedAutomationDraftSchema, definition)) {
    throw new Error("Stored protected automation definition does not match its schema.");
  }
  return definition;
}

function toStorageRecord(row: AutomationRow): ProtectedAutomationStorageRecord {
  const relation =
    row.member_role === "owner"
      ? "owner"
      : row.member_role === "follower"
        ? "follower"
        : "published";
  return {
    id: row.id,
    creatorProfileId: row.creator_profile_id,
    centralOwnerProfileId: row.central_owner_profile_id,
    provider: row.provider,
    definition: parseDefinition(row.definition_json),
    definitionRevision: row.definition_revision,
    visibility: row.visibility,
    publicationRevision: row.publication_revision,
    enabled: row.enabled === 1,
    relation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readProtectedAutomationStorageUsage(
  database: OpenClawStateDatabase,
  profileId: string,
): ProtectedAutomationStorageUsage {
  ensureSchema(database);
  const profiles = executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_automations")
      .select([
        "central_owner_profile_id as profileId",
        /* kysely-allow-raw: SQLite BLOB length counts UTF-8 bytes for stored definitions. */
        sql<number>`COALESCE(SUM(length(CAST(definition_json AS BLOB))), 0)`.as("definitionBytes"),
        sql<number>`COUNT(*)`.as("records"),
      ])
      .groupBy("central_owner_profile_id"),
  ).rows;
  const profileUsage = profiles.map((entry) => ({
    profileId: entry.profileId,
    definitionBytes: entry.definitionBytes,
    records: entry.records,
  }));
  const personal = profileUsage.find((entry) => entry.profileId === profileId);
  return {
    totalDefinitionBytes: profileUsage.reduce((sum, entry) => sum + entry.definitionBytes, 0),
    totalRecords: profileUsage.reduce((sum, entry) => sum + entry.records, 0),
    profileDefinitionBytes: personal?.definitionBytes ?? 0,
    profileRecords: personal?.records ?? 0,
    profiles: profileUsage,
  };
}

function selectVisibleAutomations(
  db: DatabaseSync,
  profileId: string,
  automationId?: string,
): ProtectedAutomationStorageRecord[] {
  const query = typedDatabase(db)
    .selectFrom("protected_automations as automation")
    .leftJoin("protected_automation_members as member", (join) =>
      join
        .onRef("member.automation_id", "=", "automation.id")
        .on("member.profile_id", "=", profileId),
    )
    .select([
      "automation.id",
      "automation.creator_profile_id",
      "automation.central_owner_profile_id",
      "automation.provider",
      "automation.definition_json",
      "automation.definition_revision",
      "automation.visibility",
      "automation.publication_revision",
      "automation.enabled",
      "automation.created_at",
      "automation.updated_at",
      "member.role as member_role",
    ])
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("protected_admissions as admission")
          .select("admission.id")
          .where("admission.profile_id", "=", profileId)
          .where("admission.status", "=", "approved"),
      ),
    )
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("protected_admissions as owner_admission")
          .select("owner_admission.id")
          .whereRef("owner_admission.profile_id", "=", "automation.central_owner_profile_id")
          .where("owner_admission.status", "=", "approved"),
      ),
    )
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("protected_automation_members as owner_membership")
          .select("owner_membership.automation_id")
          .whereRef("owner_membership.automation_id", "=", "automation.id")
          .whereRef("owner_membership.profile_id", "=", "automation.central_owner_profile_id")
          .where("owner_membership.role", "=", "owner"),
      ),
    )
    .where((expression) =>
      expression.or([
        expression("automation.visibility", "=", "shared"),
        expression("member.role", "=", "owner"),
      ]),
    )
    .orderBy("automation.updated_at", "desc")
    .orderBy("automation.id", "asc");
  const rows = executeSqliteQuerySync(
    db,
    automationId ? query.where("automation.id", "=", automationId) : query,
  ).rows;
  return rows.map((row) => toStorageRecord(row));
}

export function createProtectedAutomation(
  database: OpenClawStateDatabase,
  input: { profileId: string; definition: ProtectedAutomationDraft; now: number },
):
  | { status: "created"; automation: ProtectedAutomationStorageRecord }
  | { status: "member_inactive" } {
  ensureSchema(database);
  if (!Value.Check(ProtectedAutomationDraftSchema, input.definition)) {
    throw new TypeError("Protected automation definition does not match its schema.");
  }
  const automationId = randomUUID();
  const definitionJson = JSON.stringify(input.definition);
  const admissionFacts = {
    kind: "protected-automation",
    action: "create",
    profileId: input.profileId,
  };
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: admissionFacts });
      const kysely = typedDatabase(db);
      const activeAdmission = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_admissions")
          .select("id")
          .where("profile_id", "=", input.profileId)
          .where("status", "=", "approved")
          .limit(1),
      ).rows[0];
      if (!activeAdmission) {
        return { status: "member_inactive" as const };
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("protected_automations").values({
          id: automationId,
          creator_profile_id: input.profileId,
          central_owner_profile_id: input.profileId,
          provider: "sparky",
          definition_json: definitionJson,
          definition_revision: 1,
          visibility: "private",
          publication_revision: 0,
          enabled: 0,
          created_at: input.now,
          updated_at: input.now,
        }),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("protected_automation_members").values({
          automation_id: automationId,
          profile_id: input.profileId,
          role: "owner",
          added_at: input.now,
        }),
      );
      const automation = selectVisibleAutomations(db, input.profileId, automationId)[0];
      if (!automation) {
        throw new Error("Created protected automation was not visible to its owner.");
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
      deferSqliteWorkerCommitReceipt(db, admissionFacts);
      return { status: "created" as const, automation };
    },
    { path: database.path },
    { operationLabel: "protected.automations.create" },
  );
  return result;
}

export function listProtectedAutomations(
  database: OpenClawStateDatabase,
  profileId: string,
): ProtectedAutomationStorageRecord[] {
  ensureSchema(database);
  return selectVisibleAutomations(database.db, profileId);
}

export function readProtectedAutomation(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
): ProtectedAutomationStorageRecord | undefined {
  ensureSchema(database);
  return selectVisibleAutomations(database.db, input.profileId, input.automationId)[0];
}

export type PatchProtectedAutomationResult =
  | { status: "updated"; automation: ProtectedAutomationStorageRecord }
  | {
      status:
        | "member_inactive"
        | "automation_not_found"
        | "owner_mismatch"
        | "not_private"
        | "version_mismatch"
        | "scheduler_required";
    };

export function patchProtectedAutomation(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    automationId: string;
    expectedRevision: number;
    definition: ProtectedAutomationDraft;
    now: number;
  },
): PatchProtectedAutomationResult {
  ensureSchema(database);
  if (!Value.Check(ProtectedAutomationDraftSchema, input.definition)) {
    throw new TypeError("Protected automation definition does not match its schema.");
  }
  const admissionFacts = {
    kind: "protected-automation",
    action: "patch",
    profileId: input.profileId,
    automationId: input.automationId,
    expectedRevision: input.expectedRevision,
  };
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: admissionFacts });
      const kysely = typedDatabase(db);
      const activeAdmission = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_admissions")
          .select("id")
          .where("profile_id", "=", input.profileId)
          .where("status", "=", "approved")
          .limit(1),
      ).rows[0];
      if (!activeAdmission) {
        return { status: "member_inactive" as const };
      }
      const current = selectVisibleAutomations(db, input.profileId, input.automationId)[0];
      if (!current) {
        return { status: "automation_not_found" as const };
      }
      if (current.centralOwnerProfileId !== input.profileId || current.relation !== "owner") {
        return { status: "owner_mismatch" as const };
      }
      if (current.visibility !== "private") {
        return { status: "not_private" as const };
      }
      if (current.definitionRevision !== input.expectedRevision) {
        return { status: "version_mismatch" as const };
      }
      if (current.enabled) {
        return { status: "scheduler_required" as const };
      }
      const currentBinding = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_automation_job_bindings")
          .select("job_id")
          .where("automation_id", "=", input.automationId),
      ).rows[0];
      if (currentBinding) {
        return { status: "scheduler_required" as const };
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("protected_automations")
          .set({
            definition_json: JSON.stringify(input.definition),
            definition_revision: input.expectedRevision + 1,
            enabled: 0,
            updated_at: input.now,
          })
          .where("id", "=", input.automationId)
          .where("central_owner_profile_id", "=", input.profileId)
          .where("definition_revision", "=", input.expectedRevision)
          .where("enabled", "=", 0),
      );
      const automation = selectVisibleAutomations(db, input.profileId, input.automationId)[0];
      if (!automation || automation.definitionRevision !== input.expectedRevision + 1) {
        throw new Error("Updated protected automation was not visible at its new revision.");
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
      deferSqliteWorkerCommitReceipt(db, admissionFacts);
      return { status: "updated" as const, automation };
    },
    { path: database.path },
    { operationLabel: "protected.automations.patch" },
  );
}

export function bindProtectedAutomationJob(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    automationId: string;
    jobId: string;
    definitionRevision: number;
    now: number;
  },
): BindProtectedAutomationJobResult {
  ensureSchema(database);
  const admissionFacts = {
    kind: "protected-automation",
    action: "bind-job",
    profileId: input.profileId,
    automationId: input.automationId,
    jobId: input.jobId,
    definitionRevision: input.definitionRevision,
  };
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: admissionFacts });
      const kysely = typedDatabase(db);
      const activeAdmission = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_admissions")
          .select("id")
          .where("profile_id", "=", input.profileId)
          .where("status", "=", "approved")
          .limit(1),
      ).rows[0];
      if (!activeAdmission) {
        return { status: "member_inactive" as const };
      }
      const automation = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_automations")
          .select(["central_owner_profile_id", "definition_revision"])
          .where("id", "=", input.automationId),
      ).rows[0];
      if (!automation) {
        return { status: "automation_not_found" as const };
      }
      if (
        automation.central_owner_profile_id !== input.profileId ||
        !executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("protected_automation_members")
            .select("automation_id")
            .where("automation_id", "=", input.automationId)
            .where("profile_id", "=", input.profileId)
            .where("role", "=", "owner"),
        ).rows[0]
      ) {
        return { status: "owner_mismatch" as const };
      }
      if (automation.definition_revision !== input.definitionRevision) {
        return { status: "definition_revision_mismatch" as const };
      }
      const bindingByAutomation = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_automation_job_bindings")
          .selectAll()
          .where("automation_id", "=", input.automationId),
      ).rows[0];
      const bindingByJob = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("protected_automation_job_bindings")
          .select("automation_id")
          .where("job_id", "=", input.jobId),
      ).rows[0];
      if (
        (bindingByAutomation && bindingByAutomation.job_id !== input.jobId) ||
        (bindingByJob && bindingByJob.automation_id !== input.automationId)
      ) {
        return { status: "binding_conflict" as const };
      }
      if (bindingByAutomation) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("protected_automation_job_bindings")
            .set({
              central_owner_profile_id: input.profileId,
              definition_revision: input.definitionRevision,
              updated_at: input.now,
            })
            .where("automation_id", "=", input.automationId),
        );
        const result = {
          status: "bound" as const,
          binding: {
            jobId: bindingByAutomation.job_id,
            automationId: bindingByAutomation.automation_id,
            centralOwnerProfileId: input.profileId,
            definitionRevision: input.definitionRevision,
            createdAt: bindingByAutomation.created_at,
            updatedAt: input.now,
          },
        };
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
        deferSqliteWorkerCommitReceipt(db, admissionFacts);
        return result;
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("protected_automation_job_bindings").values({
          job_id: input.jobId,
          automation_id: input.automationId,
          central_owner_profile_id: input.profileId,
          definition_revision: input.definitionRevision,
          created_at: input.now,
          updated_at: input.now,
        }),
      );
      const result = {
        status: "bound" as const,
        binding: {
          jobId: input.jobId,
          automationId: input.automationId,
          centralOwnerProfileId: input.profileId,
          definitionRevision: input.definitionRevision,
          createdAt: input.now,
          updatedAt: input.now,
        },
      };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
      deferSqliteWorkerCommitReceipt(db, admissionFacts);
      return result;
    },
    { path: database.path },
    { operationLabel: "protected.automations.bind-job" },
  );
}

export function readProtectedAutomationJobBinding(
  database: OpenClawStateDatabase,
  jobId: string,
): ProtectedAutomationJobBinding | undefined {
  ensureSchema(database);
  const row = executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_automation_job_bindings")
      .selectAll()
      .where("job_id", "=", jobId),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  return {
    jobId: row.job_id,
    automationId: row.automation_id,
    centralOwnerProfileId: row.central_owner_profile_id,
    definitionRevision: row.definition_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
