import { AsyncLocalStorage } from "node:async_hooks";

const budget = new AsyncLocalStorage<(bytes: number) => void>();

export function withTranscriptWriteBudget<T>(charge: (bytes: number) => void, run: () => T): T {
  return budget.run(charge, run);
}

export function hasTranscriptWriteBudget(): boolean {
  return budget.getStore() !== undefined;
}

export function captureTranscriptWriteBudget(): ((entry: unknown) => void) | undefined {
  const charge = budget.getStore();
  return charge ? (entry) => charge(Buffer.byteLength(JSON.stringify(entry)) + 4096) : undefined;
}

export function chargeTranscriptWrite(entry: unknown) {
  captureTranscriptWriteBudget()?.(entry);
}
