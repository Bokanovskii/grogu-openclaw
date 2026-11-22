export type StoredDataEntry = { id: string; profileId: string; bytes: number };
export type StoredDataRetirement = { removed: StoredDataEntry; retained?: StoredDataEntry };
export type StoredDataTransfer = { previous: StoredDataEntry; current: StoredDataEntry };
export type StoredDataReservation = {
  settle(result: { created: boolean; entries: readonly StoredDataEntry[] }): void;
  // Only release after a proven abort. An uncertain commit keeps its reservation.
  release(): void;
};
export type StoredDataLedger = {
  globalBytes: number;
  users: Map<string, number>;
  storedEntries: Map<string, StoredDataEntry>;
  retiredStoredEntries: Map<string, StoredDataEntry | null>;
};

export function storedDataEntryKey(entry: StoredDataEntry): string {
  if (!entry.id || !entry.profileId || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error("Invalid stored data accounting entry.");
  }
  return JSON.stringify([entry.profileId, entry.id]);
}

export function storedDataRetirementKey(change: StoredDataRetirement): string {
  const key = storedDataEntryKey(change.removed);
  const retained = change.retained ?? null;
  if (retained && (storedDataEntryKey(retained) !== key || retained.bytes > change.removed.bytes)) {
    throw new Error("Stored data retirement must preserve identity and cannot increase storage.");
  }
  return key;
}

export function retireStoredData(account: StoredDataLedger, change: StoredDataRetirement): void {
  const key = storedDataRetirementKey(change);
  const retained = change.retained ?? null;
  const previous = account.retiredStoredEntries.get(key);
  if (
    account.retiredStoredEntries.has(key) &&
    (previous === null || (previous && retained && retained.bytes >= previous.bytes))
  ) {
    return;
  }
  const known = account.storedEntries.get(key);
  const freed = known ? known.bytes - (retained?.bytes ?? 0) : 0;
  if (freed < 0) {
    throw new Error("Stored data retirement cannot increase a measured entry.");
  }
  account.retiredStoredEntries.set(key, retained);
  if (!known) {
    return;
  }
  account.globalBytes -= freed;
  account.users.set(known.profileId, (account.users.get(known.profileId) ?? 0) - freed);
  if (retained) {
    account.storedEntries.set(key, retained);
  } else {
    account.storedEntries.delete(key);
  }
}

export function storedDataTransferKey(change: StoredDataTransfer): string {
  const previousKey = storedDataEntryKey(change.previous);
  const currentKey = storedDataEntryKey(change.current);
  if (
    previousKey === currentKey ||
    change.previous.id !== change.current.id ||
    change.previous.bytes !== change.current.bytes
  ) {
    throw new Error("Stored data transfer must change only the accounting owner.");
  }
  return previousKey;
}

// The removal owner has already fenced native writers and settled their quota reservations.
export function transferStoredData(account: StoredDataLedger, change: StoredDataTransfer): void {
  const previousKey = storedDataTransferKey(change);
  const currentKey = storedDataEntryKey(change.current);
  const previous = account.storedEntries.get(previousKey);
  const current = account.storedEntries.get(currentKey);
  if (previous && current) {
    throw new Error("Stored data transfer found duplicate accounting owners.");
  }
  const retained = account.retiredStoredEntries.has(currentKey)
    ? account.retiredStoredEntries.get(currentKey)
    : change.current;
  if (
    (previous && previous.bytes !== change.previous.bytes) ||
    (retained && retained.bytes > change.current.bytes) ||
    (current && current.bytes !== retained?.bytes)
  ) {
    throw new Error("Stored data transfer disagrees with committed accounting.");
  }
  account.retiredStoredEntries.set(previousKey, null);
  if (!previous) {
    return;
  }
  account.storedEntries.delete(previousKey);
  account.users.set(
    previous.profileId,
    (account.users.get(previous.profileId) ?? 0) - previous.bytes,
  );
  account.globalBytes -= previous.bytes - (retained?.bytes ?? 0);
  if (retained) {
    account.storedEntries.set(currentKey, retained);
    account.users.set(
      retained.profileId,
      (account.users.get(retained.profileId) ?? 0) + retained.bytes,
    );
  }
}

export function createStoredDataReservation(options: {
  account: StoredDataLedger;
  profileId: string;
  bytes: number;
  charge(bytes: number): void;
  refund(bytes: number): void;
  begin(): void;
  finish(): void;
}): StoredDataReservation {
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 0) {
    throw new Error("Invalid stored data reservation size.");
  }
  options.charge(options.bytes);
  options.begin();
  let closed = false;
  return {
    settle(result) {
      if (closed) {
        throw new Error("Stored data reservation already settled.");
      }
      const entries = new Map<string, StoredDataEntry>();
      let committedBytes = 0;
      if (result.created) {
        if (result.entries.length === 0) {
          throw new Error("Stored data creation must account for its committed entries.");
        }
        for (const entry of result.entries) {
          const key = storedDataEntryKey(entry);
          if (entry.profileId !== options.profileId || entries.has(key)) {
            throw new Error("Stored data settlement must contain unique entries for its owner.");
          }
          if (options.account.storedEntries.has(key)) {
            throw new Error("Stored data creation cannot charge an existing entry.");
          }
          committedBytes += entry.bytes;
          entries.set(key, entry);
        }
        if (!Number.isSafeInteger(committedBytes) || committedBytes > options.bytes) {
          throw new Error("Stored data settlement exceeds its reservation.");
        }
      }
      let retainedBytes = 0;
      for (const [key, entry] of entries) {
        const retained = options.account.retiredStoredEntries.has(key)
          ? options.account.retiredStoredEntries.get(key)
          : entry;
        if (retained && retained.bytes > entry.bytes) {
          throw new Error("Stored data retirement exceeds the committed entry.");
        }
        retainedBytes += retained?.bytes ?? 0;
      }
      for (const [key, entry] of entries) {
        const retained = options.account.retiredStoredEntries.has(key)
          ? options.account.retiredStoredEntries.get(key)
          : entry;
        if (retained) {
          options.account.storedEntries.set(key, retained);
        }
      }
      options.refund(options.bytes - retainedBytes);
      closed = true;
      options.finish();
    },
    release() {
      if (closed) {
        return;
      }
      options.refund(options.bytes);
      closed = true;
      options.finish();
    },
  };
}
