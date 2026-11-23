import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProtectedAutomationStorageUsage } from "../../src/state/protected-automations.js";
import type { StoredDataEntry } from "./storage-entry-quota.js";

export function readProtectedAutomationRetirementReceipt(
  facts: unknown,
  expected: {
    id: string;
    issuer: string;
    ownerSubject: string;
    profileId: string | null;
    admissionRevision: number;
  },
) {
  if (
    !isRecord(facts) ||
    facts.id !== expected.id ||
    facts.issuer !== expected.issuer ||
    facts.kind !== "protected-member-automation-retired" ||
    facts.ownerSubject !== expected.ownerSubject ||
    (facts.profileId ?? null) !== expected.profileId ||
    facts.previousRevision !== expected.admissionRevision ||
    facts.revision !== expected.admissionRevision + 1 ||
    facts.status !== "removed" ||
    (facts.subject !== undefined && typeof facts.subject !== "string") ||
    (facts.profileId !== undefined && typeof facts.profileId !== "string") ||
    !Array.isArray(facts.retiredAutomations) ||
    !Array.isArray(facts.retiredStoredData)
  ) {
    return undefined;
  }
  const retiredAutomations: ProtectedAutomationStorageUsage["entries"] = [];
  const definitions = new Set<string>();
  for (const entry of facts.retiredAutomations) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      definitions.has(entry.id) ||
      typeof entry.profileId !== "string" ||
      entry.profileId !== facts.profileId ||
      typeof entry.definitionBytes !== "number" ||
      !Number.isSafeInteger(entry.definitionBytes) ||
      entry.definitionBytes < 0
    ) {
      return undefined;
    }
    definitions.add(entry.id);
    retiredAutomations.push({
      id: entry.id,
      profileId: entry.profileId,
      definitionBytes: entry.definitionBytes,
    });
  }
  const retiredStoredData: StoredDataEntry[] = [];
  const seen = new Set<string>();
  for (const entry of facts.retiredStoredData) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.profileId !== "string" ||
      entry.profileId !== facts.profileId ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      seen.has(entry.id)
    ) {
      return undefined;
    }
    seen.add(entry.id);
    retiredStoredData.push({ id: entry.id, profileId: entry.profileId, bytes: entry.bytes });
  }
  return {
    subject: facts.subject,
    profileId: facts.profileId,
    retiredAutomations,
    retiredStoredData,
  };
}
