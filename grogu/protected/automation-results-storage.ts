import type { ProtectedAutomationResultSealedWrite } from "../../src/state/protected-automation-results.types.js";
import { storageEntryOverheadBytes } from "./capacity.js";

/** One shared retained run, charged once to its central owner: sealed bytes plus entry overhead. */
export function protectedAutomationResultStorageEntries(
  input: Pick<ProtectedAutomationResultSealedWrite, "id" | "centralOwnerProfileId" | "payload">,
) {
  return [
    {
      id: `protected-automation-run:${input.id}`,
      profileId: input.centralOwnerProfileId,
      bytes: input.payload.storedBytes + storageEntryOverheadBytes,
    },
  ];
}
