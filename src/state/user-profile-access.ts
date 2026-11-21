import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";

type Input = UserProfileWorkerOperations["userProfiles.access"]["input"];

/** Access session state belongs to the profile worker. Never send the bearer token. */
export function updateCanonicalUserProfileAccess(
  input: Input,
  options: { env: NodeJS.ProcessEnv; assertCurrent?: () => void },
) {
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userProfiles.access", input }),
    {
      assertCurrent,
      ...(input.action === "validate"
        ? {}
        : {
            createAdmission: () => ({
              nativeLocations: [context.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertCurrent();
                if (request.facts !== input.action) {
                  throw new Error("Access session operation lost its worker admission.");
                }
                grant();
              }),
            }),
          }),
    },
  );
}
