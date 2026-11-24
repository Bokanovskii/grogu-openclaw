import type { ProtectedChatShare } from "@openclaw/gateway-protocol/protected-sharing";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";
import type { ProtectedAutomationReadAccess } from "../../src/state/protected-automation-sharing.js";
import type { ProtectedChatShareRecord } from "../../src/state/protected-sharing.js";
import type { ProtectedSharingWorkerOperations } from "../../src/state/protected-sharing.worker.js";
import { validFilename, validGeneratedFilename } from "./artifacts.js";
import type { ProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import { captureProtectedStateWorkerContext } from "./state-worker-context.js";
import { widgetIdPattern } from "./tool-events.js";

type Operations = ProtectedSharingWorkerOperations;
export type ProtectedSharingMember = { profileId: string; assertCurrent: () => void };
export type ProtectedSharingAccessOptions = {
  stateDir: string;
  chats: Pick<ProtectedChats, "readEntry">;
};
type SharedChat = { ownerProfileId: string; chatId: string };

export async function runProtectedSharing<Key extends keyof Operations>(
  stateDir: string,
  type: Key,
  input: Operations[Key]["input"],
  assertCurrent: () => void,
): Promise<Operations[Key]["output"]> {
  const context = captureProtectedStateWorkerContext(stateDir);
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type, input }),
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        assertCurrent();
      },
    },
  );
  assertCurrent();
  return result;
}

export function projectProtectedChatShare(share: ProtectedChatShareRecord): ProtectedChatShare {
  return {
    id: share.shareId,
    path: `/s/${share.shareId}`,
    createdAt: share.createdAt,
    recipients: share.recipients.map(({ profileId, displayName, grantedAt }) => ({
      personId: profileId,
      displayName,
      grantedAt,
    })),
  };
}

/**
 * The chat read authority: the owner, or a recipient with a current grant, while both members are
 * approved and the owner's chat still exists. Returns the owner's display name; never cached.
 */
export async function authorizeProtectedChatRead(
  options: ProtectedSharingAccessOptions,
  member: ProtectedSharingMember,
  chat: SharedChat,
): Promise<{ ownerDisplayName: string } | undefined> {
  const access = () =>
    runProtectedSharing(
      options.stateDir,
      "protectedSharing.chatAccess",
      { profileId: member.profileId, ...chat },
      member.assertCurrent,
    );
  if (!(await access())) {
    return undefined;
  }
  try {
    await options.chats.readEntry(
      { profileId: chat.ownerProfileId, assertCurrent: member.assertCurrent },
      chat.chatId,
    );
  } catch (error) {
    if (error instanceof ProtectedError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  // Grants and chats live in separate databases; the grant may have changed during the chat read.
  return access();
}

export async function canMemberReadChat(
  options: ProtectedSharingAccessOptions,
  member: ProtectedSharingMember,
  chat: SharedChat,
): Promise<boolean> {
  return Boolean(await authorizeProtectedChatRead(options, member, chat));
}

/**
 * Artifacts inherit their chat's read access. File ids must embed that chat; widget ids do not, so
 * callers resolve widgets only inside that chat's transcript.
 */
export async function canMemberReadChatArtifact(
  options: ProtectedSharingAccessOptions,
  member: ProtectedSharingMember,
  artifact: SharedChat & { kind: "file" | "widget"; id: string },
): Promise<boolean> {
  const parts = artifact.id.split("~");
  const belongs =
    artifact.kind === "widget"
      ? widgetIdPattern.test(artifact.id)
      : parts.length === 2
        ? parts[0] === artifact.chatId && validFilename(parts[1]!)
        : parts.length === 3 &&
          parts[0] === "generated" &&
          parts[1] === artifact.chatId &&
          validGeneratedFilename(parts[2]!);
  return belongs && canMemberReadChat(options, member, artifact);
}

/**
 * The automation read authority: its owner, or a current follower while it is published, with
 * both approved and not denied. Read runs, results and run chats under `ownerProfileId`.
 */
export function canMemberReadAutomation(
  stateDir: string,
  member: ProtectedSharingMember,
  automationId: string,
): Promise<ProtectedAutomationReadAccess | undefined> {
  return runProtectedSharing(
    stateDir,
    "protectedSharing.automationAccess",
    { profileId: member.profileId, automationId },
    member.assertCurrent,
  );
}

/** Automation access for one retained run of it, under the automation's current owner. */
export function canMemberReadAutomationRun(
  stateDir: string,
  member: ProtectedSharingMember,
  run: { automationId: string; runId: string },
): Promise<ProtectedAutomationReadAccess | undefined> {
  return runProtectedSharing(
    stateDir,
    "protectedSharing.automationRunAccess",
    { profileId: member.profileId, ...run },
    member.assertCurrent,
  );
}

/**
 * The current delivery audience: the active owner, then active followers who opted in. Call it
 * immediately before each delivery.
 */
export function listAutomationRecipients(
  stateDir: string,
  automationId: string,
  assertCurrent: () => void,
): Promise<{ ownerProfileId: string; recipients: string[] } | undefined> {
  return runProtectedSharing(
    stateDir,
    "protectedSharing.automationRecipients",
    { automationId },
    assertCurrent,
  );
}
