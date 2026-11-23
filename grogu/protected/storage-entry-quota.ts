export type StoredDataEntry = { id: string; profileId: string; bytes: number };
export type StoredDataRetirement = { removed: StoredDataEntry; retained?: StoredDataEntry };
export type StoredDataTransfer = { previous: StoredDataEntry; current: StoredDataEntry };
export type StoredDataReplacement = { previous: StoredDataEntry; current: StoredDataEntry };
export type StoredDataReplacementReservation = {
  settle(committed: StoredDataEntry): void;
  // Supply the exact restored entry only after the producer proves rollback.
  release(rolledBack: StoredDataEntry): void;
};
export type StoredDataBatchReplacement = {
  previous: readonly StoredDataEntry[];
  current: readonly StoredDataEntry[];
};
export type StoredDataBatchReplacementReservation = {
  settle(committed: readonly StoredDataEntry[]): void;
  release(rolledBack: readonly StoredDataEntry[]): void;
};
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

type StoredDataReservationOptions = {
  account: StoredDataLedger;
  profileId: string;
  bytes: number;
  charge(bytes: number): void;
  refund(bytes: number): void;
  begin(): void;
  finish(): void;
};

// Producers authorize the slot and serialize its writes, retirement and transfer
// through commit/rollback. Entry IDs are opaque; this ledger is not a writer fence.
export function createStoredDataReplacementReservation(
  options: Omit<StoredDataReservationOptions, "bytes"> & { change: StoredDataReplacement },
): StoredDataReplacementReservation {
  const previous = { ...options.change.previous };
  const current = { ...options.change.current };
  const previousKey = storedDataEntryKey(previous);
  const currentKey = storedDataEntryKey(current);
  if (previous.profileId !== options.profileId || current.profileId !== options.profileId) {
    throw new Error("Stored data replacement cannot change the accounting owner.");
  }
  const baseline = options.account.storedEntries.get(previousKey);
  const assertBaseline = () => {
    if (
      !baseline ||
      options.account.storedEntries.get(previousKey) !== baseline ||
      storedDataEntryKey(baseline) !== previousKey ||
      baseline.bytes !== previous.bytes ||
      options.account.retiredStoredEntries.has(previousKey)
    ) {
      throw new Error("Stored data replacement disagrees with the measured entry.");
    }
    if (
      options.account.retiredStoredEntries.has(currentKey) ||
      (currentKey !== previousKey && options.account.storedEntries.has(currentKey))
    ) {
      throw new Error("Stored data replacement target is occupied or retired.");
    }
  };
  const assertReceipt = (entry: StoredDataEntry, expected: StoredDataEntry) => {
    if (
      storedDataEntryKey(entry) !== storedDataEntryKey(expected) ||
      entry.bytes !== expected.bytes
    ) {
      throw new Error("Stored data replacement receipt disagrees with its reservation.");
    }
  };
  assertBaseline();
  const growth = Math.max(0, current.bytes - previous.bytes);
  if (growth > 0) {
    options.charge(growth);
  }
  options.begin();
  let closed = false;
  return {
    settle(committed) {
      if (closed) {
        throw new Error("Stored data replacement already settled.");
      }
      assertReceipt(committed, current);
      assertBaseline();
      if (currentKey !== previousKey) {
        options.account.storedEntries.delete(previousKey);
        options.account.retiredStoredEntries.set(previousKey, null);
      }
      options.account.storedEntries.set(currentKey, current);
      options.refund(Math.max(0, previous.bytes - current.bytes));
      closed = true;
      options.finish();
    },
    release(rolledBack) {
      if (closed) {
        return;
      }
      assertReceipt(rolledBack, previous);
      options.refund(growth);
      closed = true;
      options.finish();
    },
  };
}

/** One producer transaction may fund a bounded pool by replacing its exact measured entries. */
export function createStoredDataBatchReplacementReservation(
  options: Omit<StoredDataReservationOptions, "bytes"> & { change: StoredDataBatchReplacement },
): StoredDataBatchReplacementReservation {
  const capture = (entries: readonly StoredDataEntry[]) => {
    const result = new Map<string, StoredDataEntry>();
    for (const original of entries) {
      const entry = { ...original };
      const key = storedDataEntryKey(entry);
      if (entry.profileId !== options.profileId || result.has(key)) {
        throw new Error("Stored data batch replacement requires unique entries for its owner.");
      }
      result.set(key, entry);
    }
    if (result.size === 0) {
      throw new Error("Stored data batch replacement requires nonempty accounting facts.");
    }
    return result;
  };
  const previous = capture(options.change.previous);
  const current = capture(options.change.current);
  const baseline = new Map(
    Array.from(previous.keys(), (key) => [key, options.account.storedEntries.get(key)] as const),
  );
  const assertBaseline = () => {
    for (const [key, entry] of previous) {
      const measured = baseline.get(key);
      if (
        !measured ||
        options.account.storedEntries.get(key) !== measured ||
        measured.bytes !== entry.bytes ||
        options.account.retiredStoredEntries.has(key)
      ) {
        throw new Error("Stored data batch replacement disagrees with measured storage.");
      }
    }
    for (const key of current.keys()) {
      if (
        options.account.retiredStoredEntries.has(key) ||
        (!previous.has(key) && options.account.storedEntries.has(key))
      ) {
        throw new Error("Stored data batch replacement target is occupied or retired.");
      }
    }
  };
  const bytes = (entries: Map<string, StoredDataEntry>) => {
    const total = Array.from(entries.values()).reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(total)) {
      throw new Error("Stored data batch replacement size is invalid.");
    }
    return total;
  };
  const before = bytes(previous);
  const after = bytes(current);
  const growth = Math.max(0, after - before);
  const assertReceipt = (
    entries: readonly StoredDataEntry[],
    expected: Map<string, StoredDataEntry>,
  ) => {
    const observed = capture(entries);
    if (
      observed.size !== expected.size ||
      Array.from(expected).some(([key, entry]) => observed.get(key)?.bytes !== entry.bytes)
    ) {
      throw new Error("Stored data batch replacement receipt disagrees with its reservation.");
    }
  };
  assertBaseline();
  if (growth > 0) {
    options.charge(growth);
  }
  options.begin();
  let closed = false;
  return {
    settle(committed) {
      if (closed) {
        throw new Error("Stored data batch replacement already settled.");
      }
      assertReceipt(committed, current);
      assertBaseline();
      for (const key of previous.keys()) {
        options.account.storedEntries.delete(key);
        if (!current.has(key)) {
          options.account.retiredStoredEntries.set(key, null);
        }
      }
      for (const [key, entry] of current) {
        options.account.storedEntries.set(key, entry);
      }
      options.refund(Math.max(0, before - after));
      closed = true;
      options.finish();
    },
    release(rolledBack) {
      if (closed) {
        return;
      }
      assertReceipt(rolledBack, previous);
      options.refund(growth);
      closed = true;
      options.finish();
    },
  };
}
export function createStoredDataReservation(
  options: StoredDataReservationOptions,
): StoredDataReservation {
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
