import { AsyncLocalStorage } from "node:async_hooks";

const budget = new AsyncLocalStorage<(bytes: number) => void>();

export function withTranscriptWriteBudget<T>(charge: (bytes: number) => void, run: () => T): T {
  return budget.run(charge, run);
}

export function chargeTranscriptWrite(entry: unknown) {
  budget.getStore()?.(Buffer.byteLength(JSON.stringify(entry)) + 4096);
}
