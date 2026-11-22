import { readDatabasePathIdentitySync } from "../../src/infra/sqlite-worker-identity.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../src/state/openclaw-agent-db.paths.js";
import { PROTECTED_STORAGE_KEY_FILE_ENV } from "../../src/storage/sqlite-encryption.js";

/** Admit the physical agent store during protected runtime startup. */
export function admitProtectedPhysicalAgentStorage(assertCurrent: () => void): void {
  assertCurrent();
  if (!process.env[PROTECTED_STORAGE_KEY_FILE_ENV]) {
    throw new Error("Protected agent storage requires its storage key before startup.");
  }
  const options = { agentId: "protected", env: process.env };
  const identity = readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(options));
  if (!identity.key.startsWith("file:")) {
    throw new Error(
      "Protected agent storage is missing; run provision-storage-key before startup.",
    );
  }
  runOpenClawAgentWriteTransaction(() => undefined, options, {
    repairAdmission: { expectedIdentity: identity, assertCurrent, requireProtectedStorage: true },
  });
  assertCurrent();
}
