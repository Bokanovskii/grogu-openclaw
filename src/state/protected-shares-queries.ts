import type { ProtectedShareListEntry } from "../../packages/gateway-protocol/src/protected-shares.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  assertProtectedSharingConnection,
  ensureSchema,
  isShareableProfile,
  openSnapshot,
  typedDatabase,
  validateRouteId,
} from "./protected-shares.js";
import type { ProtectedShareKind, ProtectedShareSnapshot } from "./protected-shares.js";

export function readProtectedShare(
  database: Parameters<typeof ensureSchema>[0],
  input: { profileId: string; kind: ProtectedShareKind; routeId: string },
): { resourceId: string; snapshot: ProtectedShareSnapshot } | undefined {
  assertProtectedSharingConnection(database.db);
  validateRouteId(input.routeId);
  ensureSchema(database);
  if (!isShareableProfile(database.db, input.profileId)) {
    return undefined;
  }
  const query = typedDatabase(database.db);
  const ownerRead =
    executeSqliteQuerySync(
      database.db,
      query
        .selectFrom("protected_shared_resources")
        .select("id")
        .where("kind", "=", input.kind)
        .where("route_id", "=", input.routeId)
        .where("owner_profile_id", "=", input.profileId)
        .limit(1),
    ).rows.length > 0;
  let grantQuery = query
    .selectFrom("protected_shared_grants as grant")
    .innerJoin("protected_shared_resources as resource", (join) =>
      join
        .onRef("resource.id", "=", "grant.resource_id")
        .onRef("resource.owner_profile_id", "=", "grant.owner_profile_id"),
    )
    .select([
      "grant.resource_id",
      "grant.id",
      "grant.owner_profile_id",
      "grant.recipient_profile_id",
      "grant.snapshot_json",
    ])
    .where("resource.kind", "=", input.kind)
    .where("resource.route_id", "=", input.routeId);
  if (ownerRead) {
    grantQuery = grantQuery.where("resource.owner_profile_id", "=", input.profileId);
  } else {
    grantQuery = grantQuery
      .innerJoin("protected_admissions as recipient", (join) =>
        join
          .onRef("recipient.profile_id", "=", "grant.recipient_profile_id")
          .on("recipient.status", "=", "approved"),
      )
      .where("grant.recipient_profile_id", "=", input.profileId);
  }
  const grant = executeSqliteQuerySync(
    database.db,
    grantQuery
      .orderBy("resource.created_at", "desc")
      .orderBy("grant.created_at", "desc")
      .orderBy("grant.id", "desc")
      .limit(1),
  ).rows[0];
  if (!grant || !isShareableProfile(database.db, grant.owner_profile_id)) {
    return undefined;
  }
  return {
    resourceId: grant.resource_id,
    snapshot: openSnapshot(database.db, grant, input.kind),
  };
}

export function listProtectedShares(
  database: Parameters<typeof ensureSchema>[0],
  input: { profileId: string; relation: "owner" | "recipient" },
): ProtectedShareListEntry[] {
  assertProtectedSharingConnection(database.db);
  ensureSchema(database);
  const db = database.db;
  if (!isShareableProfile(db, input.profileId)) {
    return [];
  }
  let listQuery = typedDatabase(db)
    .selectFrom("protected_shared_grants as grant")
    .innerJoin("protected_shared_resources as resource", (join) =>
      join
        .onRef("resource.id", "=", "grant.resource_id")
        .onRef("resource.owner_profile_id", "=", "grant.owner_profile_id"),
    )
    .innerJoin("user_profiles as owner_profile", (join) =>
      join
        .onRef("owner_profile.id", "=", "grant.owner_profile_id")
        .on("owner_profile.merged_into", "is", null),
    )
    .innerJoin("protected_admissions as owner", (join) =>
      join
        .onRef("owner.profile_id", "=", "grant.owner_profile_id")
        .on("owner.status", "=", "approved"),
    )
    .select([
      "grant.id",
      "grant.resource_id",
      "grant.owner_profile_id",
      "grant.recipient_profile_id",
      "grant.snapshot_json",
      "grant.created_at",
      "resource.kind",
      "resource.route_id",
    ])
    .where(
      input.relation === "owner" ? "grant.owner_profile_id" : "grant.recipient_profile_id",
      "=",
      input.profileId,
    );
  if (input.relation === "recipient") {
    listQuery = listQuery.innerJoin("protected_admissions as recipient", (join) =>
      join
        .onRef("recipient.profile_id", "=", "grant.recipient_profile_id")
        .on("recipient.status", "=", "approved"),
    );
  }
  const rows = executeSqliteQuerySync(
    db,
    listQuery
      .orderBy("resource.created_at", "desc")
      .orderBy("grant.created_at", "desc")
      .orderBy("grant.id", "desc"),
  ).rows;
  const latest = new Set<string>();
  return rows
    .filter((row) => {
      const key = JSON.stringify([row.kind, row.route_id, row.recipient_profile_id]);
      if (latest.has(key)) {
        return false;
      }
      latest.add(key);
      return true;
    })
    .map((row) => {
      const snapshot = openSnapshot(db, row, row.kind);
      return {
        grantId: row.id,
        resourceId: row.resource_id,
        kind: row.kind,
        routeId: row.route_id,
        ownerProfileId: row.owner_profile_id,
        recipientProfileId: row.recipient_profile_id,
        title: snapshot.title,
        sharedAt: row.created_at,
      };
    });
}
