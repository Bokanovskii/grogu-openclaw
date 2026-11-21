import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { captureUserPreferenceRead } from "./user-preferences-publication.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";
import type { CachedGitHubIdentity, CachedGitHubIdentityBinding } from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

/** Fresh disclosure aliases retain their physical store and merge authority across caller waits. */
export async function prepareCurrentUserProfileAliases(
  profileId: string,
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission, undefined, "identity");
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "userProfiles.aliases.resolve", profileId },
    { current: true },
  );
  context.admission.assertCurrent();
  if (reply && (!reply.ok || reply.type !== "userProfiles.aliases.resolve")) {
    throw new Error("Profile alias reader returned an unexpected result");
  }
  const isCurrent = authority.bind([profileId, reply?.profileId ?? profileId]);
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new Error("Profile aliases changed while preparing disclosure. Retry the request.");
    }
  };
  assertCurrent();
  return {
    profileId: reply?.profileId ?? profileId,
    aliases: new Set(reply?.aliases ?? [profileId]),
    assertCurrent,
  };
}

export async function resolveCanonicalCachedGitHubIdentity(
  binding: CachedGitHubIdentityBinding,
  options: ProfileReadOptions = {},
): Promise<CachedGitHubIdentity | undefined> {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.githubIdentity.cached",
    ...binding,
  });
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "userProfiles.githubIdentity.cached") {
    throw new Error("Cached GitHub identity reader returned an unexpected result");
  }
  return reply.identity;
}

export async function listProfiles(options: ProfileReadOptions = {}) {
  return (await readUserProfileSnapshot(undefined, options)).profiles;
}

export async function readUserProfileSnapshot(
  githubAccountIds?: readonly number[],
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "userProfiles.list",
    input: githubAccountIds ? { githubAccountIds } : undefined,
  });
}

/** Candidate IDs and search labels; current recipient policy remains caller-owned. */
export async function readUserProfileDirectory(limit: number, options: ProfileReadOptions = {}) {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "userProfiles.directory",
    input: { limit },
  });
}

export async function readVerifiedUserProfileDirectory(
  input: {
    issuer: string;
    subjects: readonly string[];
    preferenceKey: string;
    after: string | null;
    limit: number;
  },
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const preferencesCurrent = await captureUserPreferenceRead(context.admission);
  const identities = await captureUserProfileAuthorityRead(
    context.admission,
    undefined,
    "identity",
  );
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  const result = await executeOpenClawStateWorker(context, {
    type: "userProfiles.verifiedDirectory",
    input,
  });
  const identitiesCurrent = identities.bind(result.people.map(({ id }) => id));
  return {
    ...result,
    isCurrent: () => preferencesCurrent() && identitiesCurrent?.() === true,
  };
}
