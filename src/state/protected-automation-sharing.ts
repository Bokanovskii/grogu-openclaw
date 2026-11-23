import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import type { ProtectedAutomationDatabase } from "./protected-automations.js";
import type { ProtectedStoredDataEntry } from "./protected-feedback.js";
import { isActiveMember, readDisplayName } from "./protected-sharing.js";

type Database = ProtectedAutomationDatabase & {
  protected_automation_publications: { automation_id: string; published_at: number };
  protected_automation_subscriptions: {
    automation_id: string;
    profile_id: string;
    subscribed_at: number;
  };
  protected_automation_runs: {
    id: string;
    automation_id: string;
    central_owner_profile_id: string;
  };
};

export type ProtectedAutomationReadAccess = {
  ownerProfileId: string;
  relation: "owner";
};

type FollowRef = { profileId: string; automationId: string };
type Follow = FollowRef & { storageOverheadBytes: number };

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_automation_publications",
  additionalTables: ["protected_automation_subscriptions"],
  endMarker:
    "    REFERENCES protected_automation_members(automation_id, profile_id) ON DELETE CASCADE\n) STRICT;\n",
  operationLabel: "protected.automationSharing.schema",
});

const queries = (db: DatabaseSync) => getNodeSqliteKysely<Database>(db);
// Publications are charged to their owner and follows to their follower. HTTP recovery matches ids.
const publicationEntry = (
  automationId: string,
  ownerProfileId: string,
  at: number,
  bytes: number,
): ProtectedStoredDataEntry => ({
  id: `automation-publication:${automationId}:${at}`,
  profileId: ownerProfileId,
  bytes,
});
const followEntry = (
  automationId: string,
  profileId: string,
  addedAt: number,
  bytes: number,
): ProtectedStoredDataEntry => ({
  id: `automation-follow:${automationId}:${profileId}:${addedAt}`,
  profileId,
  bytes,
});

/** The automation's single owner, while that owner is an approved member. */
function activeOwner(db: DatabaseSync, automationId: string): string | undefined {
  if (!tableExists(db, "protected_automations")) {
    return undefined;
  }
  const owner = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automations as automation")
      .innerJoin("protected_automation_members as member", (join) =>
        join
          .onRef("member.automation_id", "=", "automation.id")
          .onRef("member.profile_id", "=", "automation.central_owner_profile_id")
          .on("member.role", "=", "owner"),
      )
      .select("automation.central_owner_profile_id")
      .where("automation.id", "=", automationId),
  ).rows[0]?.central_owner_profile_id;
  return owner && isActiveMember(db, owner) ? owner : undefined;
}

function publishedAt(db: DatabaseSync, automationId: string): number | undefined {
  if (!tableExists(db, "protected_automation_publications")) {
    return undefined;
  }
  return executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automation_publications as publication")
      .innerJoin(
        "protected_automations as automation",
        "automation.id",
        "publication.automation_id",
      )
      .select("publication.published_at")
      .where("publication.automation_id", "=", automationId)
      .where("automation.visibility", "=", "shared"),
  ).rows[0]?.published_at;
}

function followRole(db: DatabaseSync, automationId: string, profileId: string) {
  return executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automation_members")
      .select(["role", "added_at"])
      .where("automation_id", "=", automationId)
      .where("profile_id", "=", profileId),
  ).rows[0];
}

function isSubscribed(db: DatabaseSync, automationId: string, profileId: string) {
  return Boolean(
    executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_automation_subscriptions")
        .select("subscribed_at")
        .where("automation_id", "=", automationId)
        .where("profile_id", "=", profileId),
    ).rows[0],
  );
}

/** Followers who are active members, in subscription order when `subscribedOnly`. */
function activeFollowers(db: DatabaseSync, automationId: string, subscribedOnly = false): string[] {
  const rows = subscribedOnly
    ? executeSqliteQuerySync(
        db,
        queries(db)
          .selectFrom("protected_automation_subscriptions as subscription")
          .innerJoin("protected_automation_members as member", (join) =>
            join
              .onRef("member.automation_id", "=", "subscription.automation_id")
              .onRef("member.profile_id", "=", "subscription.profile_id")
              .on("member.role", "=", "follower"),
          )
          .select("subscription.profile_id")
          .where("subscription.automation_id", "=", automationId)
          .orderBy("subscription.subscribed_at", "asc")
          .orderBy("subscription.profile_id", "asc"),
      ).rows
    : executeSqliteQuerySync(
        db,
        queries(db)
          .selectFrom("protected_automation_members")
          .select("profile_id")
          .where("automation_id", "=", automationId)
          .where("role", "=", "follower"),
      ).rows;
  return rows.map((row) => row.profile_id).filter((profileId) => isActiveMember(db, profileId));
}

/** Opts in at `subscribedAt` (keeping an earlier opt-in), or opts out when it is undefined. */
function setSubscription(db: DatabaseSync, follow: FollowRef, subscribedAt?: number) {
  executeSqliteQuerySync(
    db,
    subscribedAt === undefined
      ? queries(db)
          .deleteFrom("protected_automation_subscriptions")
          .where("automation_id", "=", follow.automationId)
          .where("profile_id", "=", follow.profileId)
      : queries(db)
          .insertInto("protected_automation_subscriptions")
          .values({
            automation_id: follow.automationId,
            profile_id: follow.profileId,
            subscribed_at: subscribedAt,
          })
          .onConflict((conflict) => conflict.doNothing()),
  );
}

/** Unpublishing removes every follower and preference; publishing again starts empty. */
function deletePublication(
  db: DatabaseSync,
  automationId: string,
  ownerProfileId: string,
  bytes: number,
): ProtectedStoredDataEntry[] {
  executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_automation_subscriptions")
      .where("automation_id", "=", automationId),
  );
  const follows = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_automation_members")
      .where("automation_id", "=", automationId)
      .where("role", "=", "follower")
      .returning(["profile_id", "added_at"]),
  ).rows;
  const publication = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_automation_publications")
      .where("automation_id", "=", automationId)
      .returning("published_at"),
  ).rows[0];
  executeSqliteQuerySync(
    db,
    queries(db)
      .updateTable("protected_automations")
      .set((eb) => ({
        visibility: "private",
        publication_revision: eb("publication_revision", "+", 1),
      }))
      .where("id", "=", automationId)
      .where("visibility", "=", "shared"),
  );
  return [
    ...follows.map((row) => followEntry(automationId, row.profile_id, row.added_at, bytes)),
    ...(publication
      ? [publicationEntry(automationId, ownerProfileId, publication.published_at, bytes)]
      : []),
  ];
}

function write<T>(
  database: OpenClawStateDatabase,
  operationLabel: string,
  run: (db: DatabaseSync) => T,
): T {
  ensureSchema({ database, path: database.path });
  return runOpenClawStateWriteTransaction(
    ({ db }) => run(db),
    { path: database.path },
    {
      operationLabel,
    },
  );
}

/** Idempotent; undefined unless the caller is the automation's active owner. */
export function publishProtectedAutomation(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string; now: number; storageOverheadBytes: number },
): { created: boolean; entries: ProtectedStoredDataEntry[] } | undefined {
  return write(database, "protected.automationSharing.publish", (db) => {
    if (activeOwner(db, input.automationId) !== input.profileId) {
      return undefined;
    }
    if (publishedAt(db, input.automationId) !== undefined) {
      return { created: false, entries: [] };
    }
    executeSqliteQuerySync(
      db,
      queries(db)
        .updateTable("protected_automations")
        .set((eb) => ({
          visibility: "shared",
          publication_revision: eb("publication_revision", "+", 1),
        }))
        .where("id", "=", input.automationId),
    );
    executeSqliteQuerySync(
      db,
      queries(db)
        .insertInto("protected_automation_publications")
        .values({ automation_id: input.automationId, published_at: input.now })
        .onConflict((conflict) =>
          conflict.column("automation_id").doUpdateSet({ published_at: input.now }),
        ),
    );
    return {
      created: true,
      entries: [
        publicationEntry(
          input.automationId,
          input.profileId,
          input.now,
          input.storageOverheadBytes,
        ),
      ],
    };
  });
}

/** Idempotent; undefined unless the caller is the automation's active owner. */
export function unpublishProtectedAutomation(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string; storageOverheadBytes: number },
): ProtectedStoredDataEntry[] | undefined {
  return write(database, "protected.automationSharing.unpublish", (db) =>
    activeOwner(db, input.automationId) === input.profileId
      ? deletePublication(db, input.automationId, input.profileId, input.storageOverheadBytes)
      : undefined,
  );
}

/** Follows a published automation the caller does not own; `subscribed` is applied when given. */
export function followProtectedAutomation(
  database: OpenClawStateDatabase,
  input: Follow & { subscribed?: boolean; now: number },
): { created: boolean; entries: ProtectedStoredDataEntry[] } | undefined {
  return write(database, "protected.automationSharing.follow", (db) => {
    const owner = activeOwner(db, input.automationId);
    if (
      !owner ||
      owner === input.profileId ||
      !isActiveMember(db, input.profileId) ||
      publishedAt(db, input.automationId) === undefined
    ) {
      return undefined;
    }
    const current = followRole(db, input.automationId, input.profileId);
    if (current?.role === "owner") {
      return undefined;
    }
    if (!current) {
      executeSqliteQuerySync(
        db,
        queries(db).insertInto("protected_automation_members").values({
          automation_id: input.automationId,
          profile_id: input.profileId,
          role: "follower",
          added_at: input.now,
        }),
      );
    }
    if (input.subscribed !== undefined) {
      setSubscription(db, input, input.subscribed ? input.now : undefined);
    }
    return current
      ? { created: false, entries: [] }
      : {
          created: true,
          entries: [
            followEntry(input.automationId, input.profileId, input.now, input.storageOverheadBytes),
          ],
        };
  });
}

/** Idempotent; returns the retired follow entry, if any. */
export function unfollowProtectedAutomation(
  database: OpenClawStateDatabase,
  input: Follow,
): ProtectedStoredDataEntry[] {
  if (!tableExists(database.db, "protected_automation_publications")) {
    return [];
  }
  return write(database, "protected.automationSharing.unfollow", (db) => {
    setSubscription(db, input);
    return executeSqliteQuerySync(
      db,
      queries(db)
        .deleteFrom("protected_automation_members")
        .where("automation_id", "=", input.automationId)
        .where("profile_id", "=", input.profileId)
        .where("role", "=", "follower")
        .returning("added_at"),
    ).rows.map((row) =>
      followEntry(input.automationId, input.profileId, row.added_at, input.storageOverheadBytes),
    );
  });
}

/** Public automation subscriptions are disabled; retained rows are not changed. */
export function setProtectedAutomationSubscription(
  _database: OpenClawStateDatabase,
  _input: FollowRef & { subscribed: boolean; now: number },
): boolean {
  return false;
}

/** Facts for one published automation with an active owner; `subscribed` is the caller's opt-in. */
export function readProtectedAutomationPublication(
  db: DatabaseSync,
  input: FollowRef,
):
  | { ownerDisplayName: string; publishedAt: number; followers: number; subscribed: boolean }
  | undefined {
  const published = publishedAt(db, input.automationId);
  const ownerProfileId = activeOwner(db, input.automationId);
  if (published === undefined || !ownerProfileId) {
    return undefined;
  }
  return {
    ownerDisplayName: readDisplayName(db, ownerProfileId),
    publishedAt: published,
    followers: activeFollowers(db, input.automationId).length,
    subscribed: isSubscribed(db, input.automationId, input.profileId),
  };
}

/** The caller's published automations, for the owner-record `publication` field. */
export function listProtectedAutomationPublications(
  database: OpenClawStateDatabase,
  input: { profileId: string },
): { automationId: string; publishedAt: number; followers: number }[] {
  const db = database.db;
  if (!tableExists(db, "protected_automation_publications")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automation_publications as publication")
      .innerJoin(
        "protected_automations as automation",
        "automation.id",
        "publication.automation_id",
      )
      .select(["publication.automation_id", "publication.published_at"])
      .where("automation.central_owner_profile_id", "=", input.profileId)
      .where("automation.visibility", "=", "shared"),
  ).rows.map((row) => ({
    automationId: row.automation_id,
    publishedAt: row.published_at,
    followers: activeFollowers(db, row.automation_id).length,
  }));
}

function readAccess(
  db: DatabaseSync,
  input: { profileId: string; automationId: string },
): ProtectedAutomationReadAccess | undefined {
  const ownerProfileId = activeOwner(db, input.automationId);
  if (!ownerProfileId || !isActiveMember(db, input.profileId)) {
    return undefined;
  }
  if (ownerProfileId === input.profileId) {
    return { ownerProfileId, relation: "owner" };
  }
  return undefined;
}

/** Only the active owner can read an automation or its retained runs. */
export function readProtectedAutomationAccess(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
): ProtectedAutomationReadAccess | undefined {
  return readAccess(database.db, input);
}

/** Automation access, plus a retained run of that automation under its current owner. */
export function readProtectedAutomationRunAccess(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string; runId: string },
): ProtectedAutomationReadAccess | undefined {
  const db = database.db;
  const access = readAccess(db, input);
  if (!access || !tableExists(db, "protected_automation_runs")) {
    return undefined;
  }
  const run = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automation_runs")
      .select("id")
      .where("id", "=", input.runId)
      .where("automation_id", "=", input.automationId)
      .where("central_owner_profile_id", "=", access.ownerProfileId),
  ).rows[0];
  return run ? access : undefined;
}

/** Automation results remain private; followers are not delivery recipients. */
export function listProtectedAutomationRecipients(
  database: OpenClawStateDatabase,
  input: { automationId: string },
): { ownerProfileId: string; recipients: string[] } | undefined {
  const db = database.db;
  const ownerProfileId = activeOwner(db, input.automationId);
  if (!ownerProfileId) {
    return undefined;
  }
  return { ownerProfileId, recipients: [ownerProfileId] };
}

/**
 * Every charged publication and follow, or one automation's. Deleting an automation cascades
 * these rows, so its deletion plan retires the same entries.
 */
export function readProtectedAutomationSharingStorageUsage(
  database: OpenClawStateDatabase,
  overheadBytes: number,
  automationId?: string,
): ProtectedStoredDataEntry[] {
  const db = database.db;
  if (!tableExists(db, "protected_automation_publications")) {
    return [];
  }
  return [
    ...executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_automation_publications as publication")
        .innerJoin(
          "protected_automations as automation",
          "automation.id",
          "publication.automation_id",
        )
        .select([
          "publication.automation_id",
          "publication.published_at",
          "automation.central_owner_profile_id",
        ])
        .$if(automationId !== undefined, (query) =>
          query.where("publication.automation_id", "=", automationId!),
        )
        .orderBy("publication.automation_id"),
    ).rows.map((row) =>
      publicationEntry(
        row.automation_id,
        row.central_owner_profile_id,
        row.published_at,
        overheadBytes,
      ),
    ),
    ...executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_automation_members")
        .select(["automation_id", "profile_id", "added_at"])
        .where("role", "=", "follower")
        .$if(automationId !== undefined, (query) =>
          query.where("automation_id", "=", automationId!),
        )
        .orderBy("automation_id")
        .orderBy("profile_id"),
    ).rows.map((row) =>
      followEntry(row.automation_id, row.profile_id, row.added_at, overheadBytes),
    ),
  ];
}

/**
 * Runs inside member removal, before private-automation cleanup: the member's follows and
 * preferences go, and automations they own are unpublished with all their followers. Returns the
 * deleted entries for ledger retirement, which frees each entry's measured bytes by identity.
 */
export function removeProtectedMemberAutomationSharingRows(
  db: DatabaseSync,
  profileId: string,
  overheadBytes: number,
): ProtectedStoredDataEntry[] {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Protected member automation sharing removal requires an admitted database.");
  }
  if (!schema.tables.has("protected_automation_publications")) {
    return [];
  }
  executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_automation_subscriptions")
      .where("profile_id", "=", profileId),
  );
  const follows = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_automation_members")
      .where("profile_id", "=", profileId)
      .where("role", "=", "follower")
      .returning(["automation_id", "added_at"]),
  ).rows;
  const owned = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_automations")
      .select("id")
      .where("central_owner_profile_id", "=", profileId)
      .where("visibility", "=", "shared"),
  ).rows;
  return [
    ...follows.map((row) => followEntry(row.automation_id, profileId, row.added_at, overheadBytes)),
    ...owned.flatMap((automation) =>
      deletePublication(db, automation.id, profileId, overheadBytes),
    ),
  ];
}
