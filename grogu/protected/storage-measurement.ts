import { readProtectedProfileStorageLimit } from "./admission-store.js";
import { readProtectedAutomationLifecycleStorageUsage } from "./automation-lifecycle-store.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { readProtectedAutomationStorageUsage } from "./automations-store.js";
import {
  storageEntryOverheadBytes,
  type measureProtectedStorage,
  type StorageLimits,
} from "./capacity.js";
import { readProtectedFeedbackStorageUsage } from "./feedback-store.js";
import { runProtectedSharing } from "./sharing-store.js";

/** The listener and offline maintenance must measure the same stored owners. */
export function protectedStorageMeasurement(
  options: Pick<
    Parameters<typeof measureProtectedStorage>[0],
    "usersRoot" | "encryption" | "chats" | "maxFileBytes"
  > & { stateDir: string },
) {
  return {
    ...options,
    automationUsage: (profileId: string, assertCurrent: () => void) =>
      readProtectedAutomationStorageUsage(options.stateDir, profileId, assertCurrent),
    storedDataUsage: async (_profileId: string, assertCurrent: () => void) => [
      ...(await readProtectedFeedbackStorageUsage(
        options.stateDir,
        storageEntryOverheadBytes,
        assertCurrent,
      )),
      ...(await readProtectedAutomationResultStorageUsage(options.stateDir, assertCurrent)),
      ...(await readProtectedAutomationLifecycleStorageUsage(options.stateDir, assertCurrent)),
      ...(await runProtectedSharing(
        options.stateDir,
        "protectedSharing.storageUsage",
        storageEntryOverheadBytes,
        assertCurrent,
      )),
    ],
  };
}

export async function protectedStorageLimitFor(
  options: { stateDir: string; accessIssuer: string; storageLimits?: StorageLimits },
  profile: { id: string; owner: boolean },
  assertCurrent: () => void,
) {
  if (profile.owner || !options.storageLimits) {
    return null;
  }
  const custom = await readProtectedProfileStorageLimit(options.stateDir, {
    profileId: profile.id,
    issuer: options.accessIssuer,
  });
  assertCurrent();
  return custom ?? options.storageLimits.userBytes;
}
