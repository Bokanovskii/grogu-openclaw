import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  editSchema,
  encodeDescriptorSnapshot,
  querySchema,
  type Caller,
  type DescriptorSnapshot,
  type EditResult,
  type SpacesOperations,
} from "./contracts.js";

export function resolveSpacesWorkerUrl(runtimeSource: string | undefined): URL {
  if (!runtimeSource) {
    throw new Error("Spaces requires runtime entrypoint metadata.");
  }
  return new URL(`./src/store.worker${path.extname(runtimeSource)}`, pathToFileURL(runtimeSource));
}

export class SpacesStore {
  readonly databasePath: string;
  private readonly worker: Promise<SqliteWorkerStore<SpacesOperations>>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<(change: { spaceId: string; metadata: boolean }) => void>();
  private sealed = false;
  private closing?: Promise<void>;
  private catalog?: Promise<DescriptorSnapshot>;
  private catalogGeneration = 0;

  constructor(options: { workerModuleUrl: URL; databasePath?: string; now?: () => number }) {
    this.databasePath = path.resolve(
      options.databasePath ?? path.join(resolveStateDir(), "plugins", "spaces", "spaces.sqlite"),
    );
    this.now = options.now ?? Date.now;
    this.worker = openSqliteWorkerStore<SpacesOperations>({
      moduleUrl: options.workerModuleUrl,
      databasePath: this.databasePath,
      input: undefined,
    });
    // Startup owns the visible opening error; avoid an abandoned rejection before service start.
    void this.worker.catch(() => {});
  }
  private readonly now: () => number;

  private assertOpen() {
    if (this.sealed) {
      throw new Error("Spaces is shutting down. Reconnect before making another request.");
    }
  }
  private retain<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const pending = work();
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  ready(): Promise<void> {
    return this.worker.then(() => undefined);
  }
  query(input: unknown, caller: Caller) {
    const query = querySchema.parse(input);
    caller.assertCurrent();
    return this.retain(async () => {
      const worker = await this.worker;
      caller.assertCurrent();
      const result = await runSqliteWorkerStoreOperation(
        worker,
        (scope) =>
          scope.execute(
            { type: "query", input: { query, now: this.now() } },
            { signal: caller.signal },
          ),
        undefined,
        () => caller.assertCurrent(),
      );
      caller.assertCurrent();
      return result;
    });
  }
  edit(input: unknown, caller: Caller): Promise<EditResult> {
    const edit = editSchema.parse(input);
    caller.assertCurrent();
    return this.retain(async () => {
      const worker = await this.worker;
      caller.assertCurrent();
      const result = await runSqliteWorkerStoreWrite(
        worker,
        (scope) =>
          scope.execute(
            { type: "edit", input: { edit, actor: caller.actor, now: this.now() } },
            { signal: caller.signal },
          ),
        () => caller.assertCurrent(),
        [this.databasePath],
      );
      if (result.status === "applied") {
        const metadata =
          edit.action.startsWith("space.") ||
          (edit.action === "undo" && result.space !== undefined);
        if (metadata) {
          this.catalogGeneration++;
          this.catalog = undefined;
        }
        // Committed outcomes remain authoritative even if notification fails.
        for (const listener of this.listeners) {
          listener({ spaceId: edit.spaceId, metadata });
        }
      }
      return result;
    });
  }
  descriptors(caller: Caller): Promise<DescriptorSnapshot> {
    caller.assertCurrent();
    const generation = this.catalogGeneration;
    if (!this.catalog) {
      const pending = this.query({ action: "spaces.list", limit: 8 }, caller).then((result) => {
        let spaces: DescriptorSnapshot["spaces"] = [];
        const total = result.total ?? 0;
        for (const space of result.spaces ?? []) {
          const candidate = [
            ...spaces,
            {
              id: space.id,
              name: space.name,
              description: space.description,
              kind: space.kind,
              revision: space.revision,
            },
          ];
          const snapshot: DescriptorSnapshot = {
            spaces: candidate,
            omitted: total - candidate.length,
            discovery: "spaces_query: spaces.list",
          };
          if (Buffer.byteLength(encodeDescriptorSnapshot(snapshot), "utf8") > 4096) {
            break;
          }
          spaces = candidate;
        }
        return {
          spaces,
          omitted: total - spaces.length,
          discovery: "spaces_query: spaces.list" as const,
        };
      });
      this.catalog = pending;
      void pending.catch(() => {
        if (this.catalogGeneration === generation && this.catalog === pending) {
          this.catalog = undefined;
        }
      });
    }
    return this.catalog.then((snapshot) => {
      caller.assertCurrent();
      if (generation !== this.catalogGeneration) {
        return this.descriptors(caller);
      }
      return snapshot;
    });
  }
  subscribe(listener: (change: { spaceId: string; metadata: boolean }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.sealed = true;
      this.closing = Promise.resolve()
        .then(async () => {
          await Promise.allSettled(this.pending);
          this.listeners.clear();
          this.catalog = undefined;
          const worker = await this.worker;
          await worker.close();
        })
        .catch((error: unknown) => {
          this.closing = undefined;
          throw error;
        });
    }
    return this.closing;
  }
}
