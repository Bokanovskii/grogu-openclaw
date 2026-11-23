import { readDatabasePathIdentitySync } from "../../src/infra/sqlite-worker-identity.js";
import { assertNoForeignOpenClawAgentDatabaseLeases } from "../../src/state/openclaw-agent-db-lease-exclusion.js";
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
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const identity = readDatabasePathIdentitySync(pathname);
  if (!identity.key.startsWith("file:")) {
    throw new Error(
      "Protected agent storage is missing; run provision-storage-key before startup.",
    );
  }
  assertNoForeignOpenClawAgentDatabaseLeases(pathname, { env: process.env });
  assertCurrent();
  runOpenClawAgentWriteTransaction(() => undefined, options, {
    repairAdmission: { expectedIdentity: identity, assertCurrent, requireProtectedStorage: true },
  });
  assertCurrent();
}
