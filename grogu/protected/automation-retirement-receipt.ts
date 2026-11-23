import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProtectedAutomationStorageUsage } from "../../src/state/protected-automations.js";
import type { StoredDataEntry, StoredDataRetirement } from "./storage-entry-quota.js";

function readStoredEntry(value: unknown): StoredDataEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.profileId !== "string" ||
    !value.profileId ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    return undefined;
  }
  return { id: value.id, profileId: value.profileId, bytes: value.bytes };
}

export function readProtectedStoredDataRetirements(
  value: unknown,
): StoredDataRetirement[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const changes: StoredDataRetirement[] = [];
  const seen = new Set<string>();
  for (const change of value) {
    if (!isRecord(change)) {
      return undefined;
    }
    const removed = readStoredEntry(change.removed);
    const retained = change.retained === undefined ? undefined : readStoredEntry(change.retained);
    if (
      !removed ||
      (change.retained !== undefined && !retained) ||
      (retained &&
        (retained.id !== removed.id ||
          retained.profileId !== removed.profileId ||
          retained.bytes > removed.bytes))
    ) {
      return undefined;
    }
    const key = JSON.stringify([removed.profileId, removed.id]);
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    changes.push({ removed, ...(retained ? { retained } : {}) });
  }
  return changes;
}

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
  const retiredStoredDataChanges = readProtectedStoredDataRetirements(
    facts.retiredStoredDataChanges,
  );
  if (!retiredStoredDataChanges) {
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
    retiredStoredDataChanges,
  };
}
