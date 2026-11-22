import { createSqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../src/state/openclaw-state-worker-store.js";

export function captureProtectedStateWorkerContext(stateDir: string) {
  return captureOpenClawStateWorkerContext({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_PROTECTED_STORAGE_KEY_FILE: process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE,
    },
  });
}

export async function prepareProtectedSharedState(stateDir: string, assertCurrent: () => void) {
  const context = captureProtectedStateWorkerContext(stateDir);
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "database.prepareProtected", input: undefined }),
    {
      preparation: { type: "protectedSharedState" },
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (
            (request.stage !== "transaction" && request.stage !== "commit") ||
            typeof request.facts !== "object" ||
            request.facts === null ||
            !("kind" in request.facts) ||
            request.facts.kind !== "protected-shared-state-startup"
          ) {
            throw new Error("Protected shared-state startup admission is invalid.");
          }
          context.admission.assertCurrent();
          assertCurrent();
          if (!grant()) {
            throw new Error("Protected shared-state startup admission expired.");
          }
        }),
      }),
    },
  );
}
