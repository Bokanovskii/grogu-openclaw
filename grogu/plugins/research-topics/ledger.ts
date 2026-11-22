import path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { createDelivery } from "./delivery.js";
import type { CompletionReceipt, LedgerOperations } from "./schema.js";

type StoreScope = Pick<SqliteWorkerStore<LedgerOperations>, "execute">;

export type ResearchMemberBinding = {
  ledger: ResearchLedger;
  delivery: Pick<
    NonNullable<ReturnType<typeof createDelivery>>,
    "authorize" | "isMain" | "mainSession" | "post" | "notify" | "route"
  > & {
    recoverReceipt: (
      ...args: Parameters<NonNullable<ReturnType<typeof createDelivery>>["recoverReceipt"]>
    ) => Promise<CompletionReceipt>;
  };
  assertCurrent: () => void;
  withMutationAdmission: <T>(operation: (assertAdmission: () => void) => Promise<T>) => Promise<T>;
};

export function isResearchMemberBinding(value: unknown): value is ResearchMemberBinding {
  if (
    !value ||
    typeof value !== "object" ||
    !("ledger" in value) ||
    !value.ledger ||
    typeof value.ledger !== "object" ||
    !("run" in value.ledger) ||
    typeof value.ledger.run !== "function" ||
    !("close" in value.ledger) ||
    typeof value.ledger.close !== "function" ||
    !("delivery" in value) ||
    !value.delivery ||
    typeof value.delivery !== "object"
  ) {
    return false;
  }
  const delivery = value.delivery;
  return (
    "assertCurrent" in value &&
    typeof value.assertCurrent === "function" &&
    "withMutationAdmission" in value &&
    typeof value.withMutationAdmission === "function" &&
    "authorize" in delivery &&
    typeof delivery.authorize === "function" &&
    "isMain" in delivery &&
    typeof delivery.isMain === "function" &&
    "mainSession" in delivery &&
    typeof delivery.mainSession === "function" &&
    "recoverReceipt" in delivery &&
    typeof delivery.recoverReceipt === "function" &&
    "post" in delivery &&
    typeof delivery.post === "function" &&
    "notify" in delivery &&
    typeof delivery.notify === "function" &&
    "route" in delivery &&
    typeof delivery.route === "object" &&
    delivery.route !== null
  );
}

export class ResearchLedger {
  private opening: Promise<SqliteWorkerStore<LedgerOperations>> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private retired = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly databasePath: string,
    private readonly runtimeSource: string,
  ) {}

  private assertActive = () => {
    if (this.retired) {
      throw new Error("Research Topics ledger stopped. Retry after the ledger starts.");
    }
  };

  private open() {
    this.assertActive();
    this.opening ??= openSqliteWorkerStore<LedgerOperations>({
      databasePath: this.databasePath,
      moduleUrl: new URL(
        `./store.worker${path.extname(this.runtimeSource)}`,
        pathToFileURL(this.runtimeSource),
      ),
      input: {},
    }).catch((error: unknown) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  run<T>(
    operation: (scope: StoreScope) => Promise<T>,
    assertCurrent: () => void,
    mutation: boolean,
  ): Promise<T> {
    const assertActive = () => {
      this.assertActive();
      assertCurrent();
    };
    assertActive();
    const pending = (async () => {
      const store = await this.open();
      assertActive();
      const run = () =>
        runSqliteWorkerStoreWrite(store, operation, assertActive, [this.databasePath]);
      return mutation
        ? withFileLock(
            this.databasePath,
            {
              retries: { retries: 120, factor: 1.5, minTimeout: 50, maxTimeout: 1_000 },
              stale: 60_000,
              staleRecovery: "remove-if-definitely-stale",
            },
            run,
          )
        : run();
    })();
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }

  close() {
    this.retired = true;
    this.closing ??= (async () => {
      await Promise.allSettled(this.pending);
      if (this.opening) {
        await (await this.opening).close();
      }
    })();
    return this.closing;
  }
}
