import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import type {
  ProtectedAutomationLifecycleAccess,
  ProtectedAutomationLifecycleCommand,
} from "./protected-automation-lifecycle.types.js";
import {
  readProtectedAutomation,
  type ProtectedAutomationDatabase,
} from "./protected-automations.js";

/** Owner scope is granted by the configured-owner host admission, not by these identifiers. */
export function readProtectedAutomationLifecycleAuthority(
  database: OpenClawStateDatabase,
  command: ProtectedAutomationLifecycleCommand,
  access: ProtectedAutomationLifecycleAccess,
) {
  if (access.kind === "member") {
    const automation = readProtectedAutomation(database, command);
    return automation?.relation === "owner" &&
      automation.centralOwnerProfileId === command.profileId
      ? automation
      : undefined;
  }
  if (
    command.kind !== "refuse" &&
    command.kind !== "delete" &&
    !(
      command.kind === "finish" &&
      command.outcome.status !== "succeeded" &&
      (command.outcome.errorCode === "interrupted" ||
        command.outcome.errorCode === "member_inactive")
    )
  ) {
    throw new Error("Service-owner recovery cannot execute or publish a member automation.");
  }
  const recovered = readProtectedAutomationLifecycleForOwner(database, command, access);
  return (
    recovered && {
      ...recovered,
      // Only the active member's current definition can arm a check after interruption.
      definition:
        command.kind === "finish" &&
        command.outcome.status !== "succeeded" &&
        command.outcome.errorCode === "interrupted"
          ? readProtectedAutomation(database, command)?.definition
          : undefined,
    }
  );
}

export function readProtectedAutomationLifecycleForOwner(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId: string },
  access: Extract<ProtectedAutomationLifecycleAccess, { kind: "owner" }>,
) {
  const k = getNodeSqliteKysely<ProtectedAutomationDatabase>(database.db);
  const operator = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_admissions")
      .select("id")
      .where("issuer", "=", access.issuer)
      .where("subject", "=", access.subject)
      .where("profile_id", "=", access.profileId)
      .where("status", "=", "approved")
      .limit(1),
  ).rows[0];
  if (!operator) {
    return undefined;
  }
  const automation = executeSqliteQuerySync(
    database.db,
    k
      .selectFrom("protected_automations as automation")
      .innerJoin("protected_automation_members as member", "member.automation_id", "automation.id")
      .select([
        "automation.central_owner_profile_id as centralOwnerProfileId",
        "automation.definition_revision as definitionRevision",
        "automation.enabled",
      ])
      .where("automation.id", "=", input.automationId)
      .where("automation.central_owner_profile_id", "=", input.profileId)
      .where("member.profile_id", "=", input.profileId)
      .where("member.role", "=", "owner"),
  ).rows[0];
  return automation ? { ...automation, enabled: automation.enabled === 1 } : undefined;
}

export function isProtectedAutomationLifecycleMemberActive(
  database: OpenClawStateDatabase,
  profileId: string,
  issuer?: string,
) {
  const query = getNodeSqliteKysely<ProtectedAutomationDatabase>(database.db)
    .selectFrom("protected_admissions")
    .select("id")
    .where("profile_id", "=", profileId)
    .where("status", "=", "approved");
  return Boolean(
    executeSqliteQuerySync(
      database.db,
      (issuer ? query.where("issuer", "=", issuer) : query).limit(1),
    ).rows[0],
  );
}
