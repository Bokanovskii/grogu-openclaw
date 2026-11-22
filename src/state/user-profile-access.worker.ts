import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

type Session = { sessionHash: string; profileId: string; expiresAt: number };
const ensureSessions = createOpenClawStateSchemaEnsurer({
  table: "user_profile_access_sessions",
  operationLabel: "userProfiles.access.sessions.schema",
});
export const ensureUserProfileAccessDenialsSchema = createOpenClawStateSchemaEnsurer({
  table: "user_profile_access_denials",
  operationLabel: "userProfiles.access.denials.schema",
});

export function updateUserProfileAccess(
  input:
    | ({ action: "admit" | "validate" | "logout" } & Session)
    | { action: "revoke"; profileId: string },
  { open, stateOptions }: WorkerOperationContext,
): boolean {
  const database = open();
  const options = { ...stateOptions(), database };
  ensureSessions(options);
  ensureUserProfileAccessDenialsSchema(options);
  const queries = getNodeSqliteKysely<DB>(database.db);
  const currentProfile = () =>
    selectResolvedUserProfileMetadataById(database.db, input.profileId)?.id === input.profileId;
  const isDenied = () =>
    executeSqliteQuerySync(
      database.db,
      queries
        .selectFrom("user_profile_access_denials")
        .select("profile_id")
        .where("profile_id", "=", input.profileId),
    ).rows.length !== 0;
  const isCurrentSession = (session: Session) => {
    const row = executeSqliteQuerySync(
      database.db,
      queries
        .selectFrom("user_profile_access_sessions")
        .selectAll()
        .where("session_hash", "=", session.sessionHash),
    ).rows[0];
    return (
      row?.profile_id === session.profileId &&
      row.expires_at === session.expiresAt &&
      row.revoked === 0
    );
  };
  if (input.action === "validate") {
    return runSqliteDeferredTransactionSync(
      database.db,
      () =>
        currentProfile() && !isDenied() && input.expiresAt > Date.now() && isCurrentSession(input),
    );
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: input.action });
      let accepted = false;
      if (currentProfile()) {
        if (input.action === "revoke") {
          executeSqliteQuerySync(
            db,
            queries
              .insertInto("user_profile_access_denials")
              .values({ profile_id: input.profileId })
              .onConflict((conflict) => conflict.doNothing()),
          );
          if (tableExists(db, "secret_store_entries")) {
            executeSqliteQuerySync(
              db,
              queries
                .deleteFrom("secret_store_entries")
                .where("scope_kind", "=", "identity")
                .where("scope_id", "=", input.profileId)
                .where("name", "in", [
                  "alcove-connector-gmail",
                  "alcove-connector-icloud-calendar",
                ]),
            );
          }
          accepted = true;
        } else if (input.action === "logout") {
          executeSqliteQuerySync(
            db,
            queries
              .updateTable("user_profile_access_sessions")
              .set({ revoked: 1 })
              .where("session_hash", "=", input.sessionHash)
              .where("profile_id", "=", input.profileId),
          );
          accepted = true;
        } else if (!isDenied() && input.expiresAt > Date.now()) {
          executeSqliteQuerySync(
            db,
            queries
              .deleteFrom("user_profile_access_sessions")
              .where("expires_at", "<=", Date.now()),
          );
          executeSqliteQuerySync(
            db,
            queries
              .insertInto("user_profile_access_sessions")
              .values({
                session_hash: input.sessionHash,
                profile_id: input.profileId,
                expires_at: input.expiresAt,
                revoked: 0,
              })
              .onConflict((conflict) => conflict.doNothing()),
          );
          accepted = isCurrentSession(input);
        }
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: input.action });
      return accepted;
    },
    options,
    { operationLabel: "userProfiles.access.update" },
  );
}
