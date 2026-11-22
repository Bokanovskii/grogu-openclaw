import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertProtectedSharingConnection,
  ensureSchema,
  isActiveProfile,
  storageEntryId,
  typedDatabase,
} from "./protected-shares.js";
import type { ProtectedShareEntry, ProtectedShareRetirement } from "./protected-shares.js";

function assertUniqueEntries(entries: readonly ProtectedShareEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.id ||
      !entry.profileId ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      ids.has(entry.id)
    ) {
      throw new Error("Protected share inventory contains an invalid or duplicate entry.");
    }
    ids.add(entry.id);
  }
}

export function readProtectedSharesStorageUsage(
  database: Parameters<typeof ensureSchema>[0],
  profileId: string,
  entryOverheadBytes: number,
): ProtectedShareEntry[] {
  assertProtectedSharingConnection(database.db);
  if (!Number.isSafeInteger(entryOverheadBytes) || entryOverheadBytes < 0) {
    throw new TypeError("Protected share storage overhead is invalid.");
  }
  ensureSchema(database);
  if (!isActiveProfile(database.db, profileId)) {
    throw new Error("Protected share inventory requires an active member.");
  }
  const resources = executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_shared_resources")
      .select(["id", "owner_profile_id"])
      .orderBy("owner_profile_id")
      .orderBy("id"),
  ).rows.map((row) => ({
    id: storageEntryId.resource(row.id),
    profileId: row.owner_profile_id,
    bytes: entryOverheadBytes,
  }));
  const grants = executeSqliteQuerySync(
    database.db,
    typedDatabase(database.db)
      .selectFrom("protected_shared_grants as grant")
      .leftJoin("protected_shared_resources as resource", "resource.id", "grant.resource_id")
      .select([
        "grant.id",
        "grant.owner_profile_id as profileId",
        "resource.owner_profile_id as resourceOwnerProfileId",
        sql<number>`length(CAST(grant.snapshot_json AS BLOB))`.as("ciphertextBytes"),
      ])
      .orderBy("grant.owner_profile_id")
      .orderBy("grant.id"),
  ).rows.map((row) => {
    if (
      !row.resourceOwnerProfileId ||
      row.profileId !== row.resourceOwnerProfileId ||
      !Number.isSafeInteger(row.ciphertextBytes) ||
      row.ciphertextBytes < 0
    ) {
      throw new Error("Protected share grant has no canonical accounting owner.");
    }
    return {
      id: storageEntryId.grant(row.id),
      profileId: row.profileId,
      bytes: row.ciphertextBytes + entryOverheadBytes,
    };
  });
  const entries = [...resources, ...grants];
  assertUniqueEntries(entries);
  return entries;
}

/** Called by the protected-admission owner inside its existing removal transaction. */
export function retireProtectedSharesForProfileInDatabase(
  db: DatabaseSync,
  profileId: string,
  entryOverheadBytes: number,
): ProtectedShareRetirement[] {
  assertProtectedSharingConnection(db);
  if (!Number.isSafeInteger(entryOverheadBytes) || entryOverheadBytes < 0) {
    throw new TypeError("Protected share storage overhead is invalid.");
  }
  if (!db.isTransaction) {
    throw new Error("Protected share retirement requires the admission removal transaction.");
  }
  const hasResources = tableExists(db, "protected_shared_resources");
  const hasGrants = tableExists(db, "protected_shared_grants");
  if (!hasResources && !hasGrants) {
    return [];
  }
  if (!hasResources || !hasGrants) {
    throw new Error("Protected sharing schema is incomplete during admission removal.");
  }
  const query = typedDatabase(db);
  const grants = executeSqliteQuerySync(
    db,
    query
      .selectFrom("protected_shared_grants as grant")
      .leftJoin("protected_shared_resources as resource", "resource.id", "grant.resource_id")
      .select([
        "grant.id",
        "grant.resource_id",
        "grant.owner_profile_id as profileId",
        "resource.owner_profile_id as resourceOwnerProfileId",
        sql<number>`length(CAST(grant.snapshot_json AS BLOB))`.as("ciphertextBytes"),
      ])
      .where((expression) =>
        expression.or([
          expression("grant.owner_profile_id", "=", profileId),
          expression("grant.recipient_profile_id", "=", profileId),
        ]),
      ),
  ).rows;
  for (const grant of grants) {
    if (
      !grant.resourceOwnerProfileId ||
      grant.profileId !== grant.resourceOwnerProfileId ||
      !Number.isSafeInteger(grant.ciphertextBytes) ||
      grant.ciphertextBytes < 0
    ) {
      throw new Error("Protected share grant has no canonical accounting owner.");
    }
  }
  executeSqliteQuerySync(
    db,
    query
      .deleteFrom("protected_shared_grants")
      .where((expression) =>
        expression.or([
          expression("owner_profile_id", "=", profileId),
          expression("recipient_profile_id", "=", profileId),
        ]),
      ),
  );
  const resources = executeSqliteQuerySync(
    db,
    query
      .selectFrom("protected_shared_resources as resource")
      .select(["resource.id", "resource.owner_profile_id as profileId"])
      .where((expression) =>
        expression.and([
          expression.or([
            expression("resource.owner_profile_id", "=", profileId),
            expression(
              "resource.id",
              "in",
              grants.map(({ resource_id }) => resource_id),
            ),
          ]),
          expression.not(
            expression.exists(
              expression
                .selectFrom("protected_shared_grants as grant")
                .select("grant.id")
                .whereRef("grant.resource_id", "=", "resource.id"),
            ),
          ),
        ]),
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
  const retired = [
    ...grants.map((grant) => ({
      removed: {
        id: storageEntryId.grant(grant.id),
        profileId: grant.profileId,
        bytes: grant.ciphertextBytes + entryOverheadBytes,
      },
    })),
    ...resources.map((resource) => ({
      removed: {
        id: storageEntryId.resource(resource.id),
        profileId: resource.profileId,
        bytes: entryOverheadBytes,
      },
    })),
  ];
  assertUniqueEntries(retired.map(({ removed }) => removed));
  return retired;
}
