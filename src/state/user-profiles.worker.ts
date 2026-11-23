import { createHash } from "node:crypto";
import { sql } from "kysely";
import { ModelAccountConnectAuthorityError } from "../gateway/model-account-connect-errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  editProtectedAccessRequest,
  listProtectedAccessRequests,
  readProtectedAccessRequest,
  submitProtectedAccessRequest,
  withdrawProtectedAccessRequest,
} from "./protected-access-requests.js";
import {
  migrateProtectedSubjects,
  setProtectedRequestStatus,
  bindProtectedAdmission,
  listProtectedAdmissions,
  bindProtectedProfile,
  removeProtectedAdmission,
  addProtectedSubject,
} from "./protected-admission.js";
import {
  findProtectedFeedbackSubmission,
  findProtectedFeedbackForResponse,
  listProtectedFeedbackReports,
  protectedFeedbackRows,
  readProtectedFeedbackReport,
  removeProtectedChatFeedbackEvidence,
  setProtectedFeedbackReportStatus,
  setProtectedResponseRating,
  submitProtectedFeedbackReport,
} from "./protected-feedback-reports.js";
import {
  listProtectedAdminTelemetry,
  readProtectedFeedbackStoredData,
} from "./protected-feedback-telemetry.js";
import {
  beginProtectedPolicy,
  listPendingProtectedPolicy,
  retryProtectedPolicy,
  settleProtectedPolicy,
} from "./protected-policy-store.js";
import {
  readProtectedProfileStorageLimit,
  readProtectedStorageLimit,
  setProtectedStorageLimit,
} from "./protected-storage-limits.js";
import {
  listProtectedUsage,
  pruneProtectedUsage,
  recordProtectedUsage,
} from "./protected-usage.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import {
  connectUserModelAccount,
  clearUserProfileAuthLink,
  setUserProfileAuthLink,
  listUserModelAccounts,
  readSelectedUserModelAccount,
} from "./user-model-accounts.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";
import {
  ensureUserProfileAccessDenialsSchema,
  updateUserProfileAccess,
} from "./user-profile-access.worker.js";
import {
  selectProfileAccessEntries,
  selectStoredGitHubIdentities,
} from "./user-profile-github-identity.js";
import { readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import {
  createUserProfileWriteOperation,
  linkEmail,
  mergeProfiles,
  clearAvatar,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import {
  inspectProfileAvatarInDatabase,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  ensureProfileForVerifiedIdentity,
} from "./user-profiles.js";
import type {
  ProfileDisplayRow,
  UserProfileAvatarMime,
  UserProfilesDatabase,
} from "./user-profiles.types.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerOperationContext,
} from "./worker-operation-registry.js";

function accountWrite<Input extends { profileId: string }, Output>(
  write: (
    input: Input,
    options: OpenClawStateDatabaseOptions,
    admit: (stage: "transaction" | "commit") => void,
  ) => Output,
) {
  return (
    input: Input & { authorityProfileIds?: readonly string[] },
    { open, stateOptions }: WorkerOperationContext,
  ) => {
    const database = open();
    const facts = { kind: "model-account-links", profileId: input.profileId };
    return write(input, { ...stateOptions(), database }, (stage) => {
      const roles = (input.authorityProfileIds ?? []).map((profileId) => {
        const profile = selectResolvedUserProfileById(database.db, profileId);
        if (!profile || profile.id !== profileId || profile.merged_into) {
          throw new ModelAccountConnectAuthorityError();
        }
        return { profileId, role: profile.role ?? null };
      });
      requestSqliteWorkerOperationAdmission({ stage, facts: { ...facts, roles } });
      if (stage === "commit") {
        deferSqliteWorkerCommitReceipt(database.db, facts);
      }
    });
  };
}

const userProfileWriteOperations = {
  "userProfiles.setRole": createUserProfileWriteOperation(
    "userProfiles.setRole",
    (input: { profileId: string; role: string | null }, owned) =>
      setUserProfileRole(input.profileId, input.role, owned),
  ),
  "userProfiles.linkEmail": createUserProfileWriteOperation(
    "userProfiles.linkEmail",
    (input: { email: string; targetProfileId: string }, owned, display) => ({
      profile: linkEmail(input.email, input.targetProfileId, owned),
      display: display(),
    }),
    (input) => input.targetProfileId,
  ),
  "userProfiles.merge": createUserProfileWriteOperation(
    "userProfiles.merge",
    (input: { sourceProfileId: string; targetProfileId: string }, owned, display) => ({
      ...mergeProfiles(input.sourceProfileId, input.targetProfileId, owned),
      display: display(),
    }),
    (input) => input.targetProfileId,
  ),
  "userProfiles.ensureEmail": createUserProfileWriteOperation(
    "userProfiles.ensureEmail",
    (input: { email: string; expectedGitHubAccountId?: number }, owned) =>
      ensureProfileForEmail(input.email, {
        ...owned,
        expectedGitHubAccountId: input.expectedGitHubAccountId,
      }),
  ),
  "userProfiles.ensureTailscale": createUserProfileWriteOperation(
    "userProfiles.ensureTailscale",
    (input: Parameters<typeof ensureProfileForTailscaleIdentity>[0], owned) =>
      ensureProfileForTailscaleIdentity(input, owned),
  ),
  "userProfiles.ensureVerifiedIdentity": createUserProfileWriteOperation(
    "userProfiles.ensureVerifiedIdentity",
    (input: Parameters<typeof ensureProfileForVerifiedIdentity>[0], owned) =>
      ensureProfileForVerifiedIdentity(input, owned),
  ),
  "userProfiles.syncGitHub": createUserProfileWriteOperation(
    "userProfiles.syncGitHub",
    (input: Parameters<typeof syncGitHubIdentity>[0], owned) => syncGitHubIdentity(input, owned),
  ),
  "userProfiles.ensureOwner": createUserProfileWriteOperation(
    "userProfiles.ensureOwner",
    (input: { displayName: string | null }, owned) =>
      ensureGatewayOwnerProfile(input.displayName, owned),
  ),
  "userProfiles.setDisplayName": createUserProfileWriteOperation(
    "userProfiles.setDisplayName",
    (
      input: { profileId: string; name: string | null; requireExactProfile?: boolean },
      owned,
      display,
    ) => ({
      profile: setDisplayName(input.profileId, input.name, {
        ...owned,
        requireExactProfile: input.requireExactProfile,
      }),
      display: display(),
    }),
    (input) => input.profileId,
  ),
  "userProfiles.setAvatar": createUserProfileWriteOperation(
    "userProfiles.setAvatar",
    (input: { profileId: string; bytes: Uint8Array; mime: string }, owned, display) => {
      const result = setAvatar(input.profileId, input.bytes, input.mime, owned);
      return result.ok
        ? { ok: true as const, value: { profile: result.value, display: display() } }
        : result;
    },
    (input) => input.profileId,
  ),
  "userProfiles.clearAvatar": createUserProfileWriteOperation(
    "userProfiles.clearAvatar",
    (input: { profileId: string }, owned, display) => ({
      profile: clearAvatar(input.profileId, owned),
      display: display(),
    }),
    (input) => input.profileId,
  ),
} satisfies WorkerOperationHandlers;

export type UserProfileWriteOperations = WorkerOperations<typeof userProfileWriteOperations>;

export const userProfileOperations = {
  ...userProfileWriteOperations,
  "userProfiles.access": updateUserProfileAccess,
  "userProfiles.modelAccount.connect": accountWrite(
    (
      input: Omit<
        Parameters<typeof connectUserModelAccount>[0],
        "ownerProfileId" | "assertCurrent"
      > & { profileId: string },
      options,
      assertCurrent,
    ) =>
      connectUserModelAccount(
        { ...input, ownerProfileId: input.profileId, assertCurrent },
        options,
      ),
  ),
  "userProfiles.modelAccount.link": accountWrite(
    (
      input: Omit<Parameters<typeof setUserProfileAuthLink>[0], "assertCurrent">,
      options,
      assertCurrent,
    ) => setUserProfileAuthLink({ ...input, assertCurrent }, options),
  ),
  "userProfiles.modelAccount.unlink": accountWrite(
    (
      input: Omit<Parameters<typeof clearUserProfileAuthLink>[0], "assertCurrent">,
      options,
      assertCurrent,
    ) => clearUserProfileAuthLink({ ...input, assertCurrent }, options),
  ),
  "userProfiles.modelAccount.list": (
    input: Parameters<typeof listUserModelAccounts>[0],
    { stateOptions },
  ) => listUserModelAccounts(input, stateOptions()),
  "userProfiles.modelAccount.selected": (
    input: { profileId: string; provider: string },
    { stateOptions },
  ) => readSelectedUserModelAccount(input.profileId, input.provider, stateOptions()),
  "userProfiles.list": (
    input: { githubAccountIds: readonly number[] } | undefined,
    { open, stateOptions },
  ) => {
    const options = { ...stateOptions(), database: open() };
    return readUserProfileSnapshotSync(options, input?.githubAccountIds);
  },
  "protectedAccess.submit": (
    input: { email: string; name: string; note: string; now: number; receipt?: string },
    { open },
  ) => submitProtectedAccessRequest(open(), input),
  "protectedAccess.read": (input: { receipt: string }, { open }) =>
    readProtectedAccessRequest(open(), input.receipt),
  "protectedAccess.edit": (
    input: { receipt: string; name: string; note: string; now: number },
    { open },
  ) => editProtectedAccessRequest(open(), input),
  "protectedAccess.withdraw": (input: { receipt: string; now: number }, { open }) =>
    withdrawProtectedAccessRequest(open(), input),
  "protectedAccess.bind": (
    input: { issuer: string; email: string; subject: string; now: number },
    { open },
  ) => bindProtectedAdmission(open(), input),
  "protectedAccess.listAdmissions": (_input: undefined, { open }) =>
    listProtectedAdmissions(open()),
  "protectedAccess.bindProfile": (
    input: { issuer: string; subject: string; profileId: string; now: number },
    { open },
  ) => bindProtectedProfile(open(), input),
  "protectedAccess.removeAdmission": (
    input: { id: string; issuer: string; ownerSubject: string; now: number },
    { open },
  ) => removeProtectedAdmission(open(), input),
  "protectedAccess.listPendingPolicy": (_input: undefined, { open }) =>
    listPendingProtectedPolicy(open()),
  "protectedAccess.beginPolicy": (
    input: { id: string; email: string; revision: number },
    { open },
  ) => beginProtectedPolicy(open(), input),
  "protectedAccess.settlePolicy": (
    input: { id: string; email: string; revision: number; state: "synced" | "failed" | "unknown" },
    { open },
  ) => settleProtectedPolicy(open(), input),
  "protectedAccess.storageLimit.read": (
    input: Parameters<typeof readProtectedStorageLimit>[1],
    { open },
  ) => readProtectedStorageLimit(open(), input),
  "protectedAccess.storageLimit.forProfile": (
    input: Parameters<typeof readProtectedProfileStorageLimit>[1],
    { open },
  ) => readProtectedProfileStorageLimit(open(), input),
  "protectedAccess.storageLimit.set": (
    input: Parameters<typeof setProtectedStorageLimit>[1],
    { open },
  ) => setProtectedStorageLimit(open(), input),
  "protectedAccess.retryPolicy": (input: { id: string; issuer: string }, { open }) =>
    retryProtectedPolicy(open(), input),
  "protectedUsage.record": (
    input: {
      runId: string;
      profileId: string;
      model: string;
      messages: number | null;
      tokens: number | null;
      failed: boolean;
      now: number;
      telemetry?: Parameters<typeof recordProtectedUsage>[1]["telemetry"];
    },
    { open },
  ) => recordProtectedUsage(open(), input),
  "protectedUsage.list": (input: { profileId: string; now: number }, { open }) =>
    listProtectedUsage(open(), input),
  "protectedUsage.prune": (input: { now: number }, { open }) =>
    pruneProtectedUsage(open(), input.now),
  "protectedFeedback.listRatings": (input: { profileId: string; chatId: string }, { open }) =>
    protectedFeedbackRows(open(), input),
  "protectedFeedback.setRating": (
    input: Parameters<typeof setProtectedResponseRating>[1],
    { open },
  ) => setProtectedResponseRating(open(), input),
  "protectedFeedback.findSubmission": (
    input: Parameters<typeof findProtectedFeedbackSubmission>[1],
    { open },
  ) => findProtectedFeedbackSubmission(open(), input),
  "protectedFeedback.findForResponse": (
    input: Parameters<typeof findProtectedFeedbackForResponse>[1],
    { open },
  ) => findProtectedFeedbackForResponse(open(), input),
  "protectedFeedback.submitReport": (
    input: Parameters<typeof submitProtectedFeedbackReport>[1],
    { open },
  ) => submitProtectedFeedbackReport(open(), input),
  "protectedFeedback.listReports": (
    input: Parameters<typeof listProtectedFeedbackReports>[1],
    { open },
  ) => listProtectedFeedbackReports(open(), input),
  "protectedFeedback.readReport": (input: { id: string }, { open }) =>
    readProtectedFeedbackReport(open(), input.id),
  "protectedFeedback.setReportStatus": (
    input: Parameters<typeof setProtectedFeedbackReportStatus>[1],
    { open },
  ) => setProtectedFeedbackReportStatus(open(), input),
  "protectedFeedback.removeChat": (
    input: Parameters<typeof removeProtectedChatFeedbackEvidence>[1],
    { open },
  ) => removeProtectedChatFeedbackEvidence(open(), input),
  "protectedFeedback.storageUsage": (input: { overheadBytes: number }, { open }) =>
    readProtectedFeedbackStoredData(open(), input.overheadBytes),
  "protectedFeedback.telemetry.list": (
    input: Parameters<typeof listProtectedAdminTelemetry>[1],
    { open },
  ) => listProtectedAdminTelemetry(open(), input),
  "protectedAccess.list": (_input: undefined, { open }) => listProtectedAccessRequests(open()),
  "protectedAccess.setStatus": (
    input: {
      id: string;
      status: "approved" | "denied";
      now: number;
      issuer: string;
    },
    { open },
  ) => setProtectedRequestStatus(open(), input),
  "protectedAccess.migrate": (
    input: { subjects: readonly string[]; issuer: string; now: number },
    { open },
  ) => migrateProtectedSubjects(open(), input),
  "protectedAccess.addSubject": (
    input: { issuer: string; subject: string; now: number },
    { open },
  ) => addProtectedSubject(open(), input),
  "userProfiles.directory": ({ limit }: { limit: number }, { open, stateOptions }) => {
    const database = open();
    ensureUserProfilesSchema(stateOptions(), database);
    return runSqliteDeferredTransactionSync(
      database.db,
      () => {
        const profiles = executeSqliteQuerySync(
          database.db,
          userProfilesDb(database.db)
            .selectFrom("user_profiles")
            .select("id")
            .where("merged_into", "is", null)
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .limit(limit + 1),
        ).rows;
        const selected = profiles.slice(0, limit);
        const identities = selectStoredGitHubIdentities(
          database.db,
          selected.map(({ id }) => id),
        );
        return {
          profiles: selected.map(({ id }) => ({
            id,
            logins: identities.get(id)?.accounts.map((account) => account.login) ?? [],
          })),
          truncated: profiles.length > limit,
        };
      },
      { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
    );
  },
  "userProfiles.verifiedDirectory": (
    input: {
      issuer: string;
      subjects: readonly string[];
      preferenceKey: string;
      after: string | null;
      limit: number;
      profileId?: string;
    },
    { open, stateOptions },
  ) => {
    const database = open();
    const options = { ...stateOptions(), database };
    ensureUserProfilesSchema(options, database);
    ensureUserPreferencesSchema(options);
    if (input.subjects.length === 0) {
      return { people: [], nextCursor: null };
    }
    ensureUserProfileAccessDenialsSchema(options);
    return runSqliteDeferredTransactionSync(database.db, () => {
      const db = getNodeSqliteKysely<UserProfilesDatabase & DB>(database.db);
      let query = db
        .selectFrom("user_profiles as p")
        .innerJoin("user_profile_identities as i", "i.profile_id", "p.id")
        .leftJoin("user_profile_access_denials as d", "d.profile_id", "p.id")
        .leftJoin("user_preferences as s", (join) =>
          join.onRef("s.profile_id", "=", "p.id").on("s.pref_key", "=", input.preferenceKey),
        )
        .select([
          "p.id",
          "p.display_name",
          // List eligible members, but never publish a description they saved as hidden.
          sql<string>`CASE
            WHEN json_valid(s.value_json) IS NOT 1 THEN ''
            WHEN json_type(s.value_json, '$.hidden') IS NOT 'false' THEN ''
            WHEN json_type(s.value_json, '$.description') IS NOT 'text' THEN ''
            WHEN length(json_extract(s.value_json, '$.description')) > 140 THEN ''
            ELSE json_extract(s.value_json, '$.description') END`.as("description"),
        ])
        .where("i.provider", "=", `verified:${input.issuer}`)
        .where("i.subject", "in", [...input.subjects])
        .where("p.merged_into", "is", null)
        .where("d.profile_id", "is", null)
        .groupBy(["p.id", "p.display_name", "s.value_json"])
        .orderBy("p.id", "asc")
        .limit(input.limit + 1);
      if (input.after !== null) {
        query = query.where("p.id", ">", input.after);
      }
      if (input.profileId !== undefined) {
        query = query.where("p.id", "=", input.profileId);
      }
      const rows = executeSqliteQuerySync(database.db, query).rows;
      const page = rows.slice(0, input.limit);
      return {
        people: page.map((row) => ({
          id: row.id,
          displayName: (row.display_name?.trim() || "Family member").slice(0, 40),
          description: row.description.slice(0, 140),
        })),
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    });
  },
  "userProfiles.channelIdentity.change": (
    input: Parameters<typeof executeUserChannelIdentityChange>[0],
    { open, stateOptions },
  ) => executeUserChannelIdentityChange(input, { ...stateOptions(), database: open() }),
  "userProfiles.avatar.inspect": ({ profileId }: { profileId: string }, { open }) =>
    inspectProfileAvatarInDatabase(open().db, profileId),
  "userProfiles.avatar.adopt": (
    input: { profileId: string; bytes: Uint8Array; mime: UserProfileAvatarMime; now: number },
    { open, stateOptions },
  ): { profile: ReturnType<typeof toUserProfile> | undefined; committed?: ProfileDisplayRow } => {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const profile = selectResolvedUserProfileById(db, input.profileId);
        if (!profile) {
          return { profile: undefined };
        }
        if (profile.avatar !== null) {
          return { profile: toUserProfile(profile) };
        }
        const before = selectProfileAccessEntries(db, [profile.id])[0]![1];
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "profile-avatar", before },
        });
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({
              avatar: input.bytes,
              avatar_mime: input.mime,
              avatar_sha256: sha256,
              updated_at: input.now,
            })
            .where("id", "=", profile.id),
        );
        const committed = selectProfileAccessEntries(db, [profile.id])[0]![1];
        return {
          profile: toUserProfile({ ...profile, avatar_mime: input.mime, updated_at: input.now }),
          committed,
        };
      },
      { ...stateOptions(), database: open() },
      { operationLabel: "user-profiles.adopt-avatar" },
    );
  },
} satisfies WorkerOperationHandlers;

export type UserProfileWorkerOperations = WorkerOperations<typeof userProfileOperations>;
