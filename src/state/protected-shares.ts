import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { Value } from "typebox/value";
import {
  ProtectedShareSnapshotSchema,
  type ProtectedShareKind as ProtocolProtectedShareKind,
  type ProtectedShareSnapshot as ProtocolProtectedShareSnapshot,
} from "../../packages/gateway-protocol/src/protected-shares.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  hasSqliteStorageValueEncryption,
  isSqliteStorageValueEncryptionStrict,
  openSqliteStorageText,
  protectedStorageValueContext,
  sealSqliteStoragePlaintext,
} from "../storage/sqlite-encryption.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import {
  ensureProtectedAdmissionSchema,
  type ProtectedAdmissionDatabase,
} from "./protected-admission.js";
import type { UserProfilesDatabase } from "./user-profiles.types.js";

export type ProtectedShareKind = ProtocolProtectedShareKind;
export type ProtectedShareSnapshot = ProtocolProtectedShareSnapshot;

export type ProtectedShareEntry = { id: string; profileId: string; bytes: number };
export type ProtectedShareStateGeneration = { databaseIdentity: string; epoch: string };
export type ProtectedShareRetirement = {
  removed: ProtectedShareEntry;
  retained?: ProtectedShareEntry;
};

type ProtectedShareDatabase = ProtectedAdmissionDatabase &
  UserProfilesDatabase & {
    protected_shared_resources: {
      id: string;
      owner_profile_id: string;
      kind: ProtectedShareKind;
      route_id: string;
      created_at: number;
    };
    protected_shared_grants: {
      id: string;
      resource_id: string;
      owner_profile_id: string;
      recipient_profile_id: string;
      permission: "read";
      snapshot_json: string;
      created_at: number;
    };
  };

export const storageEntryId = {
  resource: (id: string) => `sharing:resource:${id}`,
  grant: (id: string) => `sharing:grant:${id}`,
};

const ensureShareSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_shared_resources",
  additionalTables: ["protected_shared_grants"],
  indexes: [
    "idx_protected_shared_resources_route",
    "idx_protected_shared_resources_owner",
    "idx_protected_shared_grants_owner",
    "idx_protected_shared_grants_recipient",
  ],
  endMarker: "  ON protected_shared_grants(recipient_profile_id, created_at, id);\n",
  operationLabel: "protected.shares.schema",
});

export function typedDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<ProtectedShareDatabase>(db);
}

export function assertProtectedSharingConnection(db: DatabaseSync): void {
  if (!isSqliteStorageValueEncryptionStrict(db) || !hasSqliteStorageValueEncryption(db)) {
    throw new Error("Protected sharing requires an admitted encrypted shared-state connection.");
  }
}

export function ensureSchema(database: OpenClawStateDatabase): void {
  assertProtectedSharingConnection(database.db);
  ensureProtectedAdmissionSchema(database);
  ensureShareSchema({ database, path: database.path });
}

export function isProtectedShareRouteId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    ![...value].some(
      (character) =>
        "/\\?#%".includes(character) ||
        character.charCodeAt(0) < 0x20 ||
        character.charCodeAt(0) === 0x7f,
    )
  );
}

export function validateRouteId(value: string): void {
  if (!isProtectedShareRouteId(value)) {
    throw new TypeError("Protected share route id is invalid.");
  }
}

function parseSnapshot(
  snapshotJson: string,
  kind: ProtectedShareKind,
  routeId?: string,
): ProtectedShareSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(snapshotJson);
  } catch (cause) {
    throw new TypeError("Protected share snapshot is invalid JSON.", { cause });
  }
  let snapshot: ProtectedShareSnapshot;
  try {
    snapshot = Value.Parse(ProtectedShareSnapshotSchema, value);
  } catch (cause) {
    throw new TypeError("Protected share snapshot does not match its contract.", { cause });
  }
  if (snapshot.kind !== kind) {
    throw new TypeError("Protected share snapshot does not match its resource kind.");
  }
  if (
    snapshot.kind === "chat" &&
    (snapshot.title !== snapshot.chat.title ||
      (routeId !== undefined && snapshot.chat.id !== routeId))
  ) {
    throw new TypeError("Protected chat snapshot does not match its shared resource.");
  }
  if (snapshot.kind === "file") {
    const bytes = Buffer.from(snapshot.contentBase64, "base64");
    if (
      bytes.toString("base64") !== snapshot.contentBase64 ||
      bytes.byteLength !== snapshot.sizeBytes
    ) {
      throw new TypeError("Protected file snapshot does not match its encoded content.");
    }
  }
  return snapshot;
}

function snapshotContext(input: {
  resourceId: string;
  grantId: string;
  ownerProfileId: string;
  recipientProfileId: string;
}): string {
  return protectedStorageValueContext("protected_shared_grants", "snapshot_json", [
    input.resourceId,
    input.grantId,
    input.ownerProfileId,
    input.recipientProfileId,
  ]);
}

export function openSnapshot(
  db: DatabaseSync,
  row: {
    resource_id: string;
    id: string;
    owner_profile_id: string;
    recipient_profile_id: string;
    snapshot_json: string;
  },
  kind: ProtectedShareKind,
): ProtectedShareSnapshot {
  let envelope: unknown;
  try {
    envelope = JSON.parse(row.snapshot_json);
  } catch (cause) {
    throw new Error("Stored protected share envelope is invalid JSON.", { cause });
  }
  if (typeof envelope !== "string") {
    throw new Error("Stored protected share envelope is invalid.");
  }
  return parseSnapshot(
    openSqliteStorageText(
      db,
      envelope,
      snapshotContext({
        resourceId: row.resource_id,
        grantId: row.id,
        ownerProfileId: row.owner_profile_id,
        recipientProfileId: row.recipient_profile_id,
      }),
    ),
    kind,
  );
}

export function isActiveProfile(db: DatabaseSync, profileId: string): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      typedDatabase(db)
        .selectFrom("protected_admissions as admission")
        .innerJoin("user_profiles as profile", "profile.id", "admission.profile_id")
        .select("admission.id")
        .where("admission.profile_id", "=", profileId)
        .where("admission.status", "=", "approved")
        .where("profile.merged_into", "is", null)
        .limit(1),
    ).rows[0],
  );
}

export function isShareableProfile(db: DatabaseSync, profileId: string): boolean {
  return profileId !== GATEWAY_OWNER_PROFILE_ID && isActiveProfile(db, profileId);
}

type PreparedProtectedShareBase = {
  ownerProfileId: string;
  kind: ProtectedShareKind;
  routeId: string;
  entryOverheadBytes: number;
};

export type PreparedProtectedShare =
  | (PreparedProtectedShareBase & {
      status: "prepared";
      resourceId: string;
      grants: Array<{
        id: string;
        recipientProfileId: string;
        snapshotJson: string;
        bytes: number;
      }>;
      entries: ProtectedShareEntry[];
    })
  | (PreparedProtectedShareBase & {
      status: "unchanged" | "member_inactive" | "recipient_inactive" | "route_conflict";
    });

export function prepareProtectedShare(
  database: OpenClawStateDatabase,
  input: {
    ownerProfileId: string;
    kind: ProtectedShareKind;
    routeId: string;
    recipientProfileIds: readonly string[];
    snapshotJson: string;
    entryOverheadBytes: number;
    now: number;
  },
): PreparedProtectedShare {
  assertProtectedSharingConnection(database.db);
  validateRouteId(input.routeId);
  if (
    !Number.isSafeInteger(input.entryOverheadBytes) ||
    input.entryOverheadBytes < 0 ||
    !Number.isSafeInteger(input.now) ||
    input.recipientProfileIds.length === 0 ||
    new Set(input.recipientProfileIds).size !== input.recipientProfileIds.length ||
    input.recipientProfileIds.some((profileId) => !profileId || profileId === input.ownerProfileId)
  ) {
    throw new TypeError("Protected share creation input is invalid.");
  }
  const requestedSnapshot = parseSnapshot(input.snapshotJson, input.kind, input.routeId);
  ensureSchema(database);
  const db = database.db;
  if (!isShareableProfile(db, input.ownerProfileId)) {
    return {
      status: "member_inactive",
      ownerProfileId: input.ownerProfileId,
      kind: input.kind,
      routeId: input.routeId,
      entryOverheadBytes: input.entryOverheadBytes,
    };
  }
  if (input.recipientProfileIds.some((profileId) => !isShareableProfile(db, profileId))) {
    return {
      status: "recipient_inactive",
      ownerProfileId: input.ownerProfileId,
      kind: input.kind,
      routeId: input.routeId,
      entryOverheadBytes: input.entryOverheadBytes,
    };
  }

  const query = typedDatabase(db);
  const routeResources = executeSqliteQuerySync(
    db,
    query
      .selectFrom("protected_shared_resources")
      .select(["owner_profile_id"])
      .where("kind", "=", input.kind)
      .where("route_id", "=", input.routeId),
  ).rows;
  if (routeResources.some((resource) => resource.owner_profile_id !== input.ownerProfileId)) {
    return {
      status: "route_conflict",
      ownerProfileId: input.ownerProfileId,
      kind: input.kind,
      routeId: input.routeId,
      entryOverheadBytes: input.entryOverheadBytes,
    };
  }
  const resourceId = randomUUID();
  const snapshotJson = JSON.stringify(requestedSnapshot);
  const grants = input.recipientProfileIds.map((recipientProfileId) => {
    const id = randomUUID();
    const sealed = sealSqliteStoragePlaintext(
      db,
      snapshotJson,
      snapshotContext({
        resourceId,
        grantId: id,
        ownerProfileId: input.ownerProfileId,
        recipientProfileId,
      }),
    );
    const stored = JSON.stringify(sealed);
    return {
      id,
      recipientProfileId,
      snapshotJson: stored,
      bytes: Buffer.byteLength(stored, "utf8") + input.entryOverheadBytes,
    };
  });
  const entries = [
    {
      id: storageEntryId.resource(resourceId),
      profileId: input.ownerProfileId,
      bytes: input.entryOverheadBytes,
    },
    ...grants.map((grant) => ({
      id: storageEntryId.grant(grant.id),
      profileId: input.ownerProfileId,
      bytes: grant.bytes,
    })),
  ];
  return {
    status: "prepared",
    ownerProfileId: input.ownerProfileId,
    kind: input.kind,
    routeId: input.routeId,
    entryOverheadBytes: input.entryOverheadBytes,
    resourceId,
    grants,
    entries,
  };
}

export type ProtectedShareCreateReceipt = {
  generation: ProtectedShareStateGeneration;
  resourceId: string;
  grants: Array<{ id: string; recipientProfileId: string }>;
  entries: ProtectedShareEntry[];
};

export function createProtectedShareGrants(
  database: OpenClawStateDatabase,
  input: {
    prepared: PreparedProtectedShare;
    generation: ProtectedShareStateGeneration;
    now: number;
  },
): ProtectedShareCreateReceipt | "member_inactive" | "recipient_inactive" | "stale" {
  const prepared = input.prepared;
  if (
    prepared.status !== "prepared" ||
    !prepared.resourceId ||
    !prepared.grants?.length ||
    !prepared.entries?.length ||
    !Number.isSafeInteger(input.now)
  ) {
    throw new TypeError("Protected share preparation is invalid.");
  }
  ensureSchema(database);
  const baseFacts = {
    kind: "protected-share",
    action: "create",
    ownerProfileId: prepared.ownerProfileId,
    resourceId: prepared.resourceId,
    resourceKind: prepared.kind,
    routeId: prepared.routeId,
    generation: input.generation,
  };
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertProtectedSharingConnection(db);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: baseFacts });
      if (!isShareableProfile(db, prepared.ownerProfileId)) {
        return "member_inactive" as const;
      }
      if (prepared.grants.some((grant) => !isShareableProfile(db, grant.recipientProfileId))) {
        return "recipient_inactive" as const;
      }
      const query = typedDatabase(db);
      const currentResources = executeSqliteQuerySync(
        db,
        query
          .selectFrom("protected_shared_resources")
          .select("owner_profile_id")
          .where("kind", "=", prepared.kind)
          .where("route_id", "=", prepared.routeId),
      ).rows;
      if (
        currentResources.some((resource) => resource.owner_profile_id !== prepared.ownerProfileId)
      ) {
        return "stale" as const;
      }
      if (
        executeSqliteQuerySync(
          db,
          query
            .selectFrom("protected_shared_resources")
            .select("id")
            .where("id", "=", prepared.resourceId),
        ).rows.length
      ) {
        return "stale" as const;
      }
      const storageFacts = {
        ...baseFacts,
        entries: prepared.entries,
      };
      const expectedEntries = [
        {
          id: storageEntryId.resource(prepared.resourceId),
          bytes: prepared.entryOverheadBytes,
        },
        ...prepared.grants.map((grant) => ({
          id: storageEntryId.grant(grant.id),
          bytes: grant.bytes,
        })),
      ];
      if (
        prepared.entries.length !== expectedEntries.length ||
        expectedEntries.some((expected) => {
          const entry = prepared.entries?.find((candidate) => candidate.id === expected.id);
          return (
            !entry || entry.profileId !== prepared.ownerProfileId || entry.bytes !== expected.bytes
          );
        })
      ) {
        throw new Error("Protected share preparation has invalid storage entries.");
      }
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { ...baseFacts, storage: storageFacts },
      });
      const latestResource = executeSqliteQuerySync(
        db,
        query
          .selectFrom("protected_shared_resources")
          .select("created_at")
          .where("kind", "=", prepared.kind)
          .where("route_id", "=", prepared.routeId)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(1),
      ).rows[0];
      const createdAt = latestResource
        ? Math.max(input.now, latestResource.created_at + 1)
        : input.now;
      if (!Number.isSafeInteger(createdAt)) {
        throw new Error("Protected share version timestamp is invalid.");
      }
      executeSqliteQuerySync(
        db,
        query.insertInto("protected_shared_resources").values({
          id: prepared.resourceId,
          owner_profile_id: prepared.ownerProfileId,
          kind: prepared.kind,
          route_id: prepared.routeId,
          created_at: createdAt,
        }),
      );
      for (const grant of prepared.grants) {
        const row = {
          resource_id: prepared.resourceId,
          id: grant.id,
          owner_profile_id: prepared.ownerProfileId,
          recipient_profile_id: grant.recipientProfileId,
          permission: "read" as const,
          snapshot_json: grant.snapshotJson,
        };
        openSnapshot(db, row, prepared.kind);
        if (
          Buffer.byteLength(grant.snapshotJson, "utf8") + prepared.entryOverheadBytes !==
          grant.bytes
        ) {
          throw new Error("Protected share preparation does not match its storage receipt.");
        }
        executeSqliteQuerySync(
          db,
          query.insertInto("protected_shared_grants").values({ ...row, created_at: createdAt }),
        );
      }
      const committedEntries: ProtectedShareEntry[] = [];
      committedEntries.push({
        id: storageEntryId.resource(prepared.resourceId),
        profileId: prepared.ownerProfileId,
        bytes: prepared.entryOverheadBytes,
      });
      for (const grant of prepared.grants) {
        const stored = executeSqliteQuerySync(
          db,
          query
            .selectFrom("protected_shared_grants")
            .select([
              "snapshot_json",
              sql<number>`length(CAST(snapshot_json AS BLOB))`.as("storedBytes"),
            ])
            .where("id", "=", grant.id),
        ).rows[0];
        if (
          !stored ||
          stored.snapshot_json !== grant.snapshotJson ||
          stored.storedBytes + prepared.entryOverheadBytes !== grant.bytes
        ) {
          throw new Error("Protected share ciphertext size changed during persistence.");
        }
        committedEntries.push({
          id: storageEntryId.grant(grant.id),
          profileId: prepared.ownerProfileId,
          bytes: grant.bytes,
        });
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: baseFacts });
      deferSqliteWorkerCommitReceipt(db, {
        ...baseFacts,
        storage: { entries: committedEntries },
      });
      return {
        generation: input.generation,
        resourceId: prepared.resourceId,
        grants: prepared.grants.map(({ id, recipientProfileId }) => ({
          id,
          recipientProfileId,
        })),
        entries: committedEntries,
      };
    },
    { path: database.path },
    { operationLabel: "protected.shares.create" },
  );
}

export function revokeProtectedShareGrant(
  database: OpenClawStateDatabase,
  input: {
    ownerProfileId: string;
    grantId: string;
    entryOverheadBytes: number;
    generation: ProtectedShareStateGeneration;
  },
): ProtectedShareRetirement[] | "member_inactive" | undefined {
  if (!Number.isSafeInteger(input.entryOverheadBytes) || input.entryOverheadBytes < 0) {
    throw new TypeError("Protected share storage overhead is invalid.");
  }
  ensureSchema(database);
  const baseFacts = {
    kind: "protected-share",
    action: "revoke",
    ownerProfileId: input.ownerProfileId,
    grantId: input.grantId,
    generation: input.generation,
  };
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertProtectedSharingConnection(db);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: baseFacts });
      if (!isShareableProfile(db, input.ownerProfileId)) {
        return "member_inactive" as const;
      }
      const query = typedDatabase(db);
      const target = executeSqliteQuerySync(
        db,
        query
          .selectFrom("protected_shared_grants as grant")
          .innerJoin("protected_shared_resources as resource", (join) =>
            join
              .onRef("resource.id", "=", "grant.resource_id")
              .onRef("resource.owner_profile_id", "=", "grant.owner_profile_id"),
          )
          .select([
            "grant.recipient_profile_id",
            "grant.owner_profile_id",
            "resource.kind",
            "resource.route_id",
          ])
          .where("grant.id", "=", input.grantId)
          .where("grant.owner_profile_id", "=", input.ownerProfileId),
      ).rows[0];
      if (!target) {
        return undefined;
      }
      const grants = executeSqliteQuerySync(
        db,
        query
          .selectFrom("protected_shared_grants as grant")
          .innerJoin("protected_shared_resources as resource", (join) =>
            join
              .onRef("resource.id", "=", "grant.resource_id")
              .onRef("resource.owner_profile_id", "=", "grant.owner_profile_id"),
          )
          .select([
            "grant.id",
            "grant.resource_id",
            "grant.owner_profile_id as profileId",
            "resource.owner_profile_id as resourceOwnerProfileId",
            sql<number>`length(CAST(grant.snapshot_json AS BLOB))`.as("ciphertextBytes"),
          ])
          .where("grant.owner_profile_id", "=", target.owner_profile_id)
          .where("grant.recipient_profile_id", "=", target.recipient_profile_id)
          .where("resource.kind", "=", target.kind)
          .where("resource.route_id", "=", target.route_id),
      ).rows;
      if (
        !grants.length ||
        grants.some(
          (grant) =>
            grant.profileId !== grant.resourceOwnerProfileId ||
            !Number.isSafeInteger(grant.ciphertextBytes) ||
            grant.ciphertextBytes < 0,
        )
      ) {
        throw new Error("Protected share grants have invalid revocation accounting facts.");
      }
      executeSqliteQuerySync(
        db,
        query.deleteFrom("protected_shared_grants").where(
          "id",
          "in",
          grants.map(({ id }) => id),
        ),
      );
      const resourceIds = [...new Set(grants.map(({ resource_id }) => resource_id))];
      const resources = executeSqliteQuerySync(
        db,
        query
          .selectFrom("protected_shared_resources as resource")
          .select(["resource.id", "resource.owner_profile_id as profileId"])
          .where("resource.id", "in", resourceIds)
          .where((expression) =>
            expression.not(
              expression.exists(
                expression
                  .selectFrom("protected_shared_grants as remaining")
                  .select("remaining.id")
                  .whereRef("remaining.resource_id", "=", "resource.id"),
              ),
            ),
          ),
      ).rows;
      if (resources.length) {
        executeSqliteQuerySync(
          db,
          query.deleteFrom("protected_shared_resources").where(
            "id",
            "in",
            resources.map(({ id }) => id),
          ),
        );
      }
      const retired: ProtectedShareRetirement[] = [
        ...grants.map((grant) => ({
          removed: {
            id: storageEntryId.grant(grant.id),
            profileId: grant.profileId,
            bytes: grant.ciphertextBytes + input.entryOverheadBytes,
          },
        })),
        ...resources.map((resource) => ({
          removed: {
            id: storageEntryId.resource(resource.id),
            profileId: resource.profileId,
            bytes: input.entryOverheadBytes,
          },
        })),
      ];
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: baseFacts });
      deferSqliteWorkerCommitReceipt(db, { ...baseFacts, retired });
      return retired;
    },
    { path: database.path },
    { operationLabel: "protected.shares.revoke" },
  );
}
