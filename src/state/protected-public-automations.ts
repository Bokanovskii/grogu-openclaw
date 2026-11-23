import type { OpenClawStateDatabase } from "./openclaw-state-db.js";
import { readProtectedAutomationPublication } from "./protected-automation-sharing.js";
import {
  listProtectedAutomations,
  readProtectedAutomation,
  type ProtectedAutomationStorageRecord,
} from "./protected-automations.js";
import { isActiveMember } from "./protected-sharing.js";

export type ProtectedPublicAutomationStorageRecord = NonNullable<
  ReturnType<typeof readProtectedAutomationPublication>
> & { automation: ProtectedAutomationStorageRecord; following: boolean };

// Separate from protected-automation-sharing, which member removal imports without the automations owner.
/** Published automations the caller can browse, newest publication first. */
export function listProtectedPublicAutomations(
  database: OpenClawStateDatabase,
  input: { profileId: string; automationId?: string },
): ProtectedPublicAutomationStorageRecord[] {
  if (!isActiveMember(database.db, input.profileId)) {
    return [];
  }
  const automations: (ProtectedAutomationStorageRecord | undefined)[] = input.automationId
    ? [readProtectedAutomation(database, { ...input, automationId: input.automationId })]
    : listProtectedAutomations(database, input.profileId);
  return automations
    .flatMap((automation) => {
      const publication =
        automation &&
        readProtectedAutomationPublication(database.db, {
          profileId: input.profileId,
          automationId: automation.id,
        });
      if (!automation || !publication) {
        return [];
      }
      const following = automation.relation === "follower";
      return [
        { ...publication, automation, following, subscribed: following && publication.subscribed },
      ];
    })
    .toSorted((left, right) => right.publishedAt - left.publishedAt);
}
