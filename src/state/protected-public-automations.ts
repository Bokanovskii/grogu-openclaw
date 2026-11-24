import type { ProtectedPublicAutomation } from "../../packages/gateway-protocol/src/protected-sharing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqlitePinnedReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import { readProtectedAutomationPublication } from "./protected-automation-sharing.js";
import {
  parseProtectedAutomationDefinition,
  type ProtectedAutomationDatabase,
} from "./protected-automations.js";
import { isActiveMember } from "./protected-sharing.js";

type CatalogDatabase = ProtectedAutomationDatabase & {
  protected_automation_publications: { automation_id: string; published_at: number };
};

/** Project only deliberately published, isolated definitions inside the state worker. */
export function listProtectedPublicAutomations(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId?: string },
): ProtectedPublicAutomation[] {
  const db = database.db;
  return runSqliteReadOperationSync(db, () =>
    runSqlitePinnedReadSnapshotSync(db, () => {
      if (
        !getAdmittedSqliteSchemaFacts(db)?.tables.has("protected_automation_publications") ||
        !isActiveMember(db, input.profileId)
      ) {
        return [];
      }
      const query = getNodeSqliteKysely<CatalogDatabase>(db)
        .selectFrom("protected_automation_publications as publication")
        .innerJoin(
          "protected_automations as automation",
          "automation.id",
          "publication.automation_id",
        )
        .leftJoin("protected_automation_members as member", (join) =>
          join
            .onRef("member.automation_id", "=", "automation.id")
            .on("member.profile_id", "=", input.profileId),
        )
        .select([
          "automation.id",
          "automation.central_owner_profile_id",
          "automation.definition_json",
          "automation.pacing_min_ms",
          "automation.pacing_max_ms",
          "automation.enabled",
          "member.role as member_role",
        ])
        .where("automation.visibility", "=", "shared")
        .orderBy("publication.published_at", "desc")
        .orderBy("automation.id", "asc");
      const rows = executeSqliteQuerySync(
        db,
        input.automationId ? query.where("automation.id", "=", input.automationId) : query,
      ).rows;
      return rows.flatMap((row) => {
        const publication = readProtectedAutomationPublication(db, {
          profileId: input.profileId,
          automationId: row.id,
        });
        if (!publication) {
          return [];
        }
        const definition = parseProtectedAutomationDefinition(db, row);
        if (definition.contextAccess !== "isolated") {
          return [];
        }
        const following = row.member_role === "follower";
        return [
          {
            id: row.id,
            name: definition.name,
            instructions: definition.instructions,
            whenToNotify: definition.whenToNotify,
            ...(definition.doneWhen === undefined ? {} : { doneWhen: definition.doneWhen }),
            schedule: definition.schedule,
            state: row.enabled === 1 ? ("active" as const) : ("paused" as const),
            nextCheckAt: null,
            owner: {
              personId: row.central_owner_profile_id,
              displayName: publication.ownerDisplayName,
            },
            publishedAt: publication.publishedAt,
            followers: publication.followers,
            following,
            subscribed: following && publication.subscribed,
          },
        ];
      });
    }),
  );
}
