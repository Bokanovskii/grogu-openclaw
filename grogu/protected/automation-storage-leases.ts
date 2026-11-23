import { createKeyedFifoLeaseRegistry } from "../../src/shared/keyed-fifo-lease.js";

export const protectedAutomationStorageLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.protectedAutomationResultLeases"),
);

export function protectedAutomationStorageLeaseKeys(
  databasePath: string,
  automationId: string,
  profileId: string,
) {
  return [
    JSON.stringify([databasePath, "automation", automationId]),
    JSON.stringify([databasePath, "recipient", profileId]),
  ];
}
