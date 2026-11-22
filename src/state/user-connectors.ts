import { isDeepStrictEqual } from "node:util";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { parseUserConnector, type UserConnectorCommand } from "./user-connectors.types.js";

/** The protected owner supplies live authority, not a role or a browser-supplied profile ID. */
export async function operateUserConnector(
  input: UserConnectorCommand,
  options: { env: NodeJS.ProcessEnv; assertCurrent: () => void },
) {
  const captured = structuredClone(input);
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent();
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userConnectors.operate", input: captured }),
    {
      assertCurrent,
      ...(captured.action === "read"
        ? {}
        : {
            createAdmission: () => ({
              nativeLocations: [context.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertCurrent();
                if (
                  !isDeepStrictEqual(request.facts, {
                    profileId: captured.profileId,
                    kind: captured.kind,
                    action: captured.action,
                  })
                ) {
                  throw new Error("Connector lost its owner admission.");
                }
                grant();
              }),
            }),
          }),
    },
  );
  assertCurrent();
  return result === undefined ? undefined : parseUserConnector(result);
}
