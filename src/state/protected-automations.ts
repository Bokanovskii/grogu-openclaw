import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import {
  isValidProtectedAutomationPacing,
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
import { isolatedAutomationHasActiveRun } from "./protected-automation-lifecycle-retention.js";
import {
  assertStoredDefinitionBytes,
  readStoredDefinition,
  storedDefinition,
  storedDefinitionBytes,
  storedDefinitionCharge,
} from "./protected-automation-storage-codec.js";

type AutomationVisibility = "private" | "shared";
type AutomationRelation = "owner" | "follower" | "published";

export type ProtectedAutomationDatabase = ProtectedAdmissionDatabase & {
  protected_automations: {
    id: string;
    creator_profile_id: string;
    central_owner_profile_id: string;
    provider: "sparky";
    definition_json: string;
    pacing_min_ms: number | null;
    pacing_max_ms: number | null;
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
  migrateExistingTables: ["protected_automations"],
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
  entries: Array<{ id: string; profileId: string; definitionBytes: number }>;
};

export type ProtectedAutomationStoredBytes = {
  automationId: string;
  currentStoredBytes: number;
  nextStoredBytes: number;
};

export type ProtectedAutomationCommittedBytes = ProtectedAutomationStoredBytes & {
  committedStoredBytes: number;
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

type AutomationRow = ProtectedAutomationDatabase["protected_automations"] & {
  member_role: "owner" | "follower" | null;
};

function typedDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<ProtectedAutomationDatabase>(db);
}

function ensureSchema(database: OpenClawStateDatabase): void {
  ensureProtectedAdmissionSchema(database);
  ensureAutomationSchema({ database, path: database.path });
}

function assertValidDraft(draft: ProtectedAutomationDraft): void {
  if (!Value.Check(ProtectedAutomationDraftSchema, draft)) {
    throw new TypeError("Protected automation definition does not match its schema.");
  }
  if (draft.pacing && !isValidProtectedAutomationPacing(draft.schedule, draft.pacing)) {
    throw new TypeError("Protected automation pacing range must contain its fallback interval.");
  }
}

function parseDefinition(db: DatabaseSync, row: AutomationRow): ProtectedAutomationDraft {
  const definitionJson = readStoredDefinition(db, row);
  let definition: unknown;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    throw new Error("Stored protected automation definition is invalid JSON.");
  }
  if (!Value.Check(ProtectedAutomationDraftSchema, definition) || definition.pacing !== undefined) {
    throw new Error("Stored protected automation definition does not match its schema.");
  }
  if (row.pacing_min_ms === null && row.pacing_max_ms === null) {
    return definition;
  }
  if (row.pacing_min_ms === null || row.pacing_max_ms === null) {
    throw new Error("Stored protected automation pacing bounds are incomplete.");
  }
  const paced = { ...definition, pacing: { minMs: row.pacing_min_ms, maxMs: row.pacing_max_ms } };
  assertValidDraft(paced);
  return paced;
}

function toStorageRecord(db: DatabaseSync, row: AutomationRow): ProtectedAutomationStorageRecord {
  return {
    id: row.id,
    creatorProfileId: row.creator_profile_id,
    centralOwnerProfileId: row.central_owner_profile_id,
    provider: row.provider,
    definition: parseDefinition(db, row),
    definitionRevision: row.definition_revision,
    visibility: row.visibility,
    publicationRevision: row.publication_revision,
    enabled: row.enabled === 1,
    relation: row.member_role ?? "published",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readProtectedAutomationStorageUsage(
  database: OpenClawStateDatabase,
  profileId: string,
): ProtectedAutomationStorageUsage {
  ensureSchema(database);
  const entries = executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_automations")
      .select([
        "id",
        "central_owner_profile_id as profileId",
        storedDefinitionCharge.as("definitionBytes"),
      ])
      .orderBy("central_owner_profile_id")
      .orderBy("id"),
  ).rows;
  const profiles = new Map<string, { definitionBytes: number; records: number }>();
  for (const entry of entries) {
    const profile = profiles.get(entry.profileId) ?? { definitionBytes: 0, records: 0 };
    profile.definitionBytes += entry.definitionBytes;
    profile.records++;
    profiles.set(entry.profileId, profile);
  }
  const profileUsage = Array.from(profiles, ([ownerProfileId, usage]) => ({
    profileId: ownerProfileId,
    ...usage,
  }));
  const personal = profileUsage.find((entry) => entry.profileId === profileId);
  return {
    totalDefinitionBytes: entries.reduce((sum, entry) => sum + entry.definitionBytes, 0),
    totalRecords: entries.length,
    profileDefinitionBytes: personal?.definitionBytes ?? 0,
    profileRecords: personal?.records ?? 0,
    profiles: profileUsage,
    entries,
  };
}

function selectOwnedAutomations(
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
      "automation.pacing_min_ms",
      "automation.pacing_max_ms",
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
    // Definitions are private even when legacy publication and follow rows still exist.
    .where("automation.central_owner_profile_id", "=", profileId)
    .where("member.role", "=", "owner")
    .orderBy("automation.updated_at", "desc")
    .orderBy("automation.id", "asc");
  const rows = executeSqliteQuerySync(
    db,
    automationId ? query.where("automation.id", "=", automationId) : query,
  ).rows;
  return rows.map((row) => toStorageRecord(db, row));
}

export function createProtectedAutomation(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    definition: ProtectedAutomationDraft;
    now: number;
    /** Caller-reserved id makes a retried create return the owned record instead of a duplicate. */
    automationId?: string;
  },
):
  | { status: "created" | "exists"; automation: ProtectedAutomationStorageRecord }
  | { status: "member_inactive" } {
  ensureSchema(database);
  assertValidDraft(input.definition);
  const automationId = input.automationId ?? randomUUID();
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
      if (input.automationId) {
        const reserved = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("protected_automations")
            .select("id")
            .where("id", "=", automationId)
            .limit(1),
        ).rows[0];
        if (reserved) {
          const owned = selectOwnedAutomations(db, input.profileId, automationId)[0];
          if (!owned || owned.relation !== "owner") {
            throw new Error("Reserved protected automation id belongs to another record.");
          }
          return { status: "exists" as const, automation: owned };
        }
      }
      const definition = storedDefinition(db, automationId, input.definition);
      const storage = {
        automationId,
        currentStoredBytes: 0,
        nextStoredBytes: definition.bytes,
      };
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { ...admissionFacts, storage },
      });
      executeSqliteQuerySync(
        db,
        kysely.insertInto("protected_automations").values({
          id: automationId,
          creator_profile_id: input.profileId,
          central_owner_profile_id: input.profileId,
          provider: "sparky",
          ...definition.columns,
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
      const automation = selectOwnedAutomations(db, input.profileId, automationId)[0];
      if (!automation) {
        throw new Error("Created protected automation was not visible to its owner.");
      }
      const committedStoredBytes = assertStoredDefinitionBytes(
        db,
        automationId,
        storage.nextStoredBytes,
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
      deferSqliteWorkerCommitReceipt(db, {
        ...admissionFacts,
        storage: { ...storage, committedStoredBytes },
      });
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
  return selectOwnedAutomations(database.db, profileId);
}

export function readProtectedAutomation(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
): ProtectedAutomationStorageRecord | undefined {
  ensureSchema(database);
  return selectOwnedAutomations(database.db, input.profileId, input.automationId)[0];
}

export type PatchProtectedAutomationResult =
  | { status: "updated"; automation: ProtectedAutomationStorageRecord }
  | {
      status:
        | "member_inactive"
        | "automation_not_found"
        | "owner_mismatch"
        | "version_mismatch"
        | "automation_busy"
        | "scheduler_required";
    };

export function patchProtectedAutomation(
  database: OpenClawStateDatabase,
  input: {
    profileId: string;
    automationId: string;
    expectedRevision: number;
    definition: ProtectedAutomationDraft;
    enabled?: boolean;
    now: number;
  },
): PatchProtectedAutomationResult {
  ensureSchema(database);
  assertValidDraft(input.definition);
  const admissionFacts = {
    kind: "protected-automation",
    action: "patch",
    profileId: input.profileId,
    automationId: input.automationId,
    expectedRevision: input.expectedRevision,
    enabled: input.enabled,
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
      const current = selectOwnedAutomations(db, input.profileId, input.automationId)[0];
      if (!current) {
        return { status: "automation_not_found" as const };
      }
      if (current.centralOwnerProfileId !== input.profileId || current.relation !== "owner") {
        return { status: "owner_mismatch" as const };
      }
      if (current.definitionRevision !== input.expectedRevision) {
        return { status: "version_mismatch" as const };
      }
      if (isolatedAutomationHasActiveRun(db, input.automationId, current.definition)) {
        return { status: "automation_busy" as const };
      }
      if (
        input.definition.contextAccess !== undefined &&
        input.definition.contextAccess !== (current.definition.contextAccess ?? "member")
      ) {
        throw new TypeError("An automation's context access cannot be changed.");
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
      const definition = storedDefinition(db, input.automationId, {
        ...input.definition,
        contextAccess: current.definition.contextAccess,
      });
      const storage = {
        automationId: input.automationId,
        currentStoredBytes: storedDefinitionBytes(db, input.automationId),
        nextStoredBytes: definition.bytes,
      };
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { ...admissionFacts, storage },
      });
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("protected_automations")
          .set({
            ...definition.columns,
            definition_revision: input.expectedRevision + 1,
            enabled: (input.enabled ?? current.enabled) ? 1 : 0,
            updated_at: input.now,
          })
          .where("id", "=", input.automationId)
          .where("central_owner_profile_id", "=", input.profileId)
          .where("definition_revision", "=", input.expectedRevision),
      );
      const automation = selectOwnedAutomations(db, input.profileId, input.automationId)[0];
      if (!automation || automation.definitionRevision !== input.expectedRevision + 1) {
        throw new Error("Updated protected automation was not visible at its new revision.");
      }
      const committedStoredBytes = assertStoredDefinitionBytes(
        db,
        input.automationId,
        storage.nextStoredBytes,
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admissionFacts });
      deferSqliteWorkerCommitReceipt(db, {
        ...admissionFacts,
        storage: { ...storage, committedStoredBytes },
      });
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
