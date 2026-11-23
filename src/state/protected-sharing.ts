import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import type { ProtectedStoredDataEntry } from "./protected-feedback.js";

type SharingDatabase = {
  user_profiles: { id: string; display_name: string | null };
  user_profile_access_denials: { profile_id: string };
  protected_admissions: { profile_id: string | null; status: "approved" | "removed" };
  protected_chat_shares: {
    owner_profile_id: string;
    chat_id: string;
    share_id: string;
    created_at: number;
  };
  protected_chat_share_grants: {
    owner_profile_id: string;
    chat_id: string;
    recipient_profile_id: string;
    granted_at: number;
  };
};

export type ProtectedChatShareRecord = {
  shareId: string;
  createdAt: number;
  recipients: { profileId: string; displayName: string; grantedAt: number }[];
};

type ChatRef = { ownerProfileId: string; chatId: string };

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "protected_chat_shares",
  additionalTables: ["protected_chat_share_grants"],
  indexes: ["idx_protected_chat_share_grants_recipient"],
  endMarker:
    "CREATE INDEX IF NOT EXISTS idx_protected_chat_share_grants_recipient\n  ON protected_chat_share_grants(recipient_profile_id, granted_at DESC);\n",
  operationLabel: "protected.sharing.schema",
});

function ensureProtectedSharingSchema(database: OpenClawStateDatabase) {
  ensureSchema({ database, path: database.path });
}

const queries = (db: DatabaseSync) => getNodeSqliteKysely<SharingDatabase>(db);
const newShareId = () => randomBytes(32).toString("base64url");
const displayName = (value: string | null | undefined) =>
  (value?.trim() || "Family member").slice(0, 40);
// Links are charged to their owner and grants to their recipient. HTTP recovery matches these ids.
const shareEntry = (ref: ChatRef, createdAt: number, bytes: number): ProtectedStoredDataEntry => ({
  id: `chat-share:${ref.chatId}:${createdAt}`,
  profileId: ref.ownerProfileId,
  bytes,
});
const grantEntry = (
  ref: ChatRef,
  recipientProfileId: string,
  grantedAt: number,
  bytes: number,
): ProtectedStoredDataEntry => ({
  id: `chat-share-grant:${ref.ownerProfileId}:${ref.chatId}:${recipientProfileId}:${grantedAt}`,
  profileId: recipientProfileId,
  bytes,
});

// Authority is the durable admission, not a link or grant: removed or denied members never read.
export function isActiveMember(db: DatabaseSync, profileId: string): boolean {
  if (!tableExists(db, "protected_admissions")) {
    return false;
  }
  const admitted = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_admissions")
      .select("profile_id")
      .where("profile_id", "=", profileId)
      .where("status", "=", "approved")
      .limit(1),
  ).rows[0];
  if (!admitted) {
    return false;
  }
  return (
    !tableExists(db, "user_profile_access_denials") ||
    !executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("user_profile_access_denials")
        .select("profile_id")
        .where("profile_id", "=", profileId),
    ).rows[0]
  );
}

export function readDisplayName(db: DatabaseSync, profileId: string) {
  return displayName(
    executeSqliteQuerySync(
      db,
      queries(db).selectFrom("user_profiles").select("display_name").where("id", "=", profileId),
    ).rows[0]?.display_name,
  );
}

function readShare(db: DatabaseSync, ref: ChatRef): ProtectedChatShareRecord | undefined {
  const share = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_chat_shares")
      .select(["share_id", "created_at"])
      .where("owner_profile_id", "=", ref.ownerProfileId)
      .where("chat_id", "=", ref.chatId),
  ).rows[0];
  if (!share) {
    return undefined;
  }
  const recipients = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_chat_share_grants as g")
      .leftJoin("user_profiles as p", "p.id", "g.recipient_profile_id")
      .select(["g.recipient_profile_id", "g.granted_at", "p.display_name"])
      .where("g.owner_profile_id", "=", ref.ownerProfileId)
      .where("g.chat_id", "=", ref.chatId)
      .orderBy("g.granted_at", "desc")
      .orderBy("g.recipient_profile_id", "asc"),
  ).rows;
  return {
    shareId: share.share_id,
    createdAt: share.created_at,
    recipients: recipients.map((row) => ({
      profileId: row.recipient_profile_id,
      displayName: displayName(row.display_name),
      grantedAt: row.granted_at,
    })),
  };
}

function rotateShare(db: DatabaseSync, ref: ChatRef) {
  executeSqliteQuerySync(
    db,
    queries(db)
      .updateTable("protected_chat_shares")
      .set({ share_id: newShareId() })
      .where("owner_profile_id", "=", ref.ownerProfileId)
      .where("chat_id", "=", ref.chatId),
  );
}

function deleteShareRows(db: DatabaseSync, ref: ChatRef, bytes: number) {
  const grants = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_chat_share_grants")
      .where("owner_profile_id", "=", ref.ownerProfileId)
      .where("chat_id", "=", ref.chatId)
      .returning(["recipient_profile_id", "granted_at"]),
  ).rows;
  const share = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_chat_shares")
      .where("owner_profile_id", "=", ref.ownerProfileId)
      .where("chat_id", "=", ref.chatId)
      .returning("created_at"),
  ).rows[0];
  return [
    ...grants.map((row) => grantEntry(ref, row.recipient_profile_id, row.granted_at, bytes)),
    ...(share ? [shareEntry(ref, share.created_at, bytes)] : []),
  ];
}

export function readProtectedChatShare(
  database: OpenClawStateDatabase,
  input: ChatRef,
): ProtectedChatShareRecord | undefined {
  return tableExists(database.db, "protected_chat_shares")
    ? readShare(database.db, input)
    : undefined;
}

/** Returns the existing or new link; undefined when the owner is no longer an approved member. */
export function createProtectedChatShare(
  database: OpenClawStateDatabase,
  input: ChatRef & { now: number; storageOverheadBytes: number },
):
  | { created: boolean; share: ProtectedChatShareRecord; entries: ProtectedStoredDataEntry[] }
  | undefined {
  ensureProtectedSharingSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!isActiveMember(db, input.ownerProfileId)) {
        return undefined;
      }
      const existing = readShare(db, input);
      if (existing) {
        return { created: false, share: existing, entries: [] };
      }
      executeSqliteQuerySync(
        db,
        queries(db).insertInto("protected_chat_shares").values({
          owner_profile_id: input.ownerProfileId,
          chat_id: input.chatId,
          share_id: newShareId(),
          created_at: input.now,
        }),
      );
      return {
        created: true,
        share: readShare(db, input)!,
        entries: [shareEntry(input, input.now, input.storageOverheadBytes)],
      };
    },
    { path: database.path },
    { operationLabel: "protected.sharing.share.create" },
  );
}

/** Disables a chat link and every grant; chat deletion and orphan cleanup use the same path. */
export function deleteProtectedChatShare(
  database: OpenClawStateDatabase,
  input: ChatRef & { storageOverheadBytes: number },
): ProtectedStoredDataEntry[] {
  if (!tableExists(database.db, "protected_chat_shares")) {
    return [];
  }
  ensureProtectedSharingSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteShareRows(db, input, input.storageOverheadBytes),
    { path: database.path },
    { operationLabel: "protected.sharing.share.delete" },
  );
}

/** Removes one recipient and rotates the link so the removed member cannot claim it again. */
export function removeProtectedChatShareRecipient(
  database: OpenClawStateDatabase,
  input: ChatRef & { recipientProfileId: string; storageOverheadBytes: number },
): { share: ProtectedChatShareRecord; removed: ProtectedStoredDataEntry[] } | undefined {
  if (!tableExists(database.db, "protected_chat_shares")) {
    return undefined;
  }
  ensureProtectedSharingSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!readShare(db, input)) {
        return undefined;
      }
      const removed = executeSqliteQuerySync(
        db,
        queries(db)
          .deleteFrom("protected_chat_share_grants")
          .where("owner_profile_id", "=", input.ownerProfileId)
          .where("chat_id", "=", input.chatId)
          .where("recipient_profile_id", "=", input.recipientProfileId)
          .returning("granted_at"),
      ).rows;
      rotateShare(db, input);
      return {
        share: readShare(db, input)!,
        removed: removed.map((row) =>
          grantEntry(input, input.recipientProfileId, row.granted_at, input.storageOverheadBytes),
        ),
      };
    },
    { path: database.path },
    { operationLabel: "protected.sharing.recipient.remove" },
  );
}

export type ProtectedChatShareTarget = ChatRef & {
  ownerDisplayName: string;
  access: "owner" | "recipient";
  granted: boolean;
};

function resolveShare(
  db: DatabaseSync,
  input: { profileId: string; shareId: string },
): ProtectedChatShareTarget | undefined {
  const share = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_chat_shares")
      .select(["owner_profile_id", "chat_id"])
      .where("share_id", "=", input.shareId),
  ).rows[0];
  if (
    !share ||
    !isActiveMember(db, share.owner_profile_id) ||
    !isActiveMember(db, input.profileId)
  ) {
    return undefined;
  }
  const ref = { ownerProfileId: share.owner_profile_id, chatId: share.chat_id };
  const owner = share.owner_profile_id === input.profileId;
  return {
    ...ref,
    ownerDisplayName: readDisplayName(db, ref.ownerProfileId),
    access: owner ? "owner" : "recipient",
    granted: owner || hasGrant(db, ref, input.profileId),
  };
}

function hasGrant(db: DatabaseSync, ref: ChatRef, recipientProfileId: string) {
  return Boolean(
    executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_chat_share_grants")
        .select("granted_at")
        .where("owner_profile_id", "=", ref.ownerProfileId)
        .where("chat_id", "=", ref.chatId)
        .where("recipient_profile_id", "=", recipientProfileId),
    ).rows[0],
  );
}

/** Read-only link lookup so callers can verify the chat before a claim writes a grant. */
export function resolveProtectedChatShare(
  database: OpenClawStateDatabase,
  input: { profileId: string; shareId: string },
): ProtectedChatShareTarget | undefined {
  return tableExists(database.db, "protected_chat_shares")
    ? resolveShare(database.db, input)
    : undefined;
}

export function claimProtectedChatShare(
  database: OpenClawStateDatabase,
  input: { profileId: string; shareId: string; now: number; storageOverheadBytes: number },
):
  | (ProtectedChatShareTarget & { created: boolean; entries: ProtectedStoredDataEntry[] })
  | undefined {
  if (!tableExists(database.db, "protected_chat_shares")) {
    return undefined;
  }
  ensureProtectedSharingSchema(database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const target = resolveShare(db, input);
      if (!target || target.granted) {
        return target && { ...target, created: false, entries: [] };
      }
      executeSqliteQuerySync(
        db,
        queries(db).insertInto("protected_chat_share_grants").values({
          owner_profile_id: target.ownerProfileId,
          chat_id: target.chatId,
          recipient_profile_id: input.profileId,
          granted_at: input.now,
        }),
      );
      return {
        ...target,
        granted: true,
        created: true,
        entries: [grantEntry(target, input.profileId, input.now, input.storageOverheadBytes)],
      };
    },
    { path: database.path },
    { operationLabel: "protected.sharing.claim" },
  );
}

export function listProtectedSharedChats(
  database: OpenClawStateDatabase,
  input: { profileId: string },
): (ChatRef & { ownerDisplayName: string; grantedAt: number })[] {
  const db = database.db;
  if (!tableExists(db, "protected_chat_shares") || !isActiveMember(db, input.profileId)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("protected_chat_share_grants as g")
      .leftJoin("user_profiles as p", "p.id", "g.owner_profile_id")
      .select(["g.owner_profile_id", "g.chat_id", "g.granted_at", "p.display_name"])
      .where("g.recipient_profile_id", "=", input.profileId)
      .orderBy("g.granted_at", "desc"),
  )
    .rows.filter((row) => isActiveMember(db, row.owner_profile_id))
    .map((row) => ({
      ownerProfileId: row.owner_profile_id,
      chatId: row.chat_id,
      ownerDisplayName: displayName(row.display_name),
      grantedAt: row.granted_at,
    }));
}

/** The durable half of chat read access; callers must also prove the chat still exists. */
export function readProtectedChatAccess(
  database: OpenClawStateDatabase,
  input: ChatRef & { profileId: string },
): { ownerDisplayName: string } | undefined {
  const db = database.db;
  if (!isActiveMember(db, input.profileId)) {
    return undefined;
  }
  if (input.profileId !== input.ownerProfileId) {
    if (
      !tableExists(db, "protected_chat_shares") ||
      !isActiveMember(db, input.ownerProfileId) ||
      !hasGrant(db, input, input.profileId)
    ) {
      return undefined;
    }
  }
  return { ownerDisplayName: readDisplayName(db, input.ownerProfileId) };
}

export function readProtectedSharingStorageUsage(
  database: OpenClawStateDatabase,
  overheadBytes: number,
): ProtectedStoredDataEntry[] {
  const db = database.db;
  if (!tableExists(db, "protected_chat_shares")) {
    return [];
  }
  return [
    ...executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_chat_shares")
        .select(["owner_profile_id", "chat_id", "created_at"]),
    ).rows.map((row) =>
      shareEntry(
        { ownerProfileId: row.owner_profile_id, chatId: row.chat_id },
        row.created_at,
        overheadBytes,
      ),
    ),
    ...executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("protected_chat_share_grants")
        .select(["owner_profile_id", "chat_id", "recipient_profile_id", "granted_at"]),
    ).rows.map((row) =>
      grantEntry(
        { ownerProfileId: row.owner_profile_id, chatId: row.chat_id },
        row.recipient_profile_id,
        row.granted_at,
        overheadBytes,
      ),
    ),
  ];
}

/**
 * Runs inside member removal. Links the member claimed rotate so a re-admitted account cannot
 * reuse an old URL; links the member owns are disabled with all their grants.
 */
export function removeProtectedMemberSharingRows(
  db: DatabaseSync,
  profileId: string,
  overheadBytes: number,
): ProtectedStoredDataEntry[] {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Protected member sharing removal requires an admitted database.");
  }
  if (!schema.tables.has("protected_chat_shares")) {
    return [];
  }
  const claimed = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_chat_share_grants")
      .where("recipient_profile_id", "=", profileId)
      .returning(["owner_profile_id", "chat_id", "recipient_profile_id", "granted_at"]),
  ).rows;
  for (const row of claimed) {
    rotateShare(db, { ownerProfileId: row.owner_profile_id, chatId: row.chat_id });
  }
  const ownedGrants = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_chat_share_grants")
      .where("owner_profile_id", "=", profileId)
      .returning(["owner_profile_id", "chat_id", "recipient_profile_id", "granted_at"]),
  ).rows;
  const ownedShares = executeSqliteQuerySync(
    db,
    queries(db)
      .deleteFrom("protected_chat_shares")
      .where("owner_profile_id", "=", profileId)
      .returning(["owner_profile_id", "chat_id", "created_at"]),
  ).rows;
  return [
    ...[...claimed, ...ownedGrants].map((row) =>
      grantEntry(
        { ownerProfileId: row.owner_profile_id, chatId: row.chat_id },
        row.recipient_profile_id,
        row.granted_at,
        overheadBytes,
      ),
    ),
    ...ownedShares.map((row) =>
      shareEntry(
        { ownerProfileId: row.owner_profile_id, chatId: row.chat_id },
        row.created_at,
        overheadBytes,
      ),
    ),
  ];
}
