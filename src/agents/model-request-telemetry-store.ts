import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import {
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerThreadExecArgv,
} from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  modelRequestMetadataSnapshot,
  type ModelRequestRecord,
} from "./model-request-telemetry-metadata.js";

type StoreRequest = { directory: string } & (
  | { action: "write"; records: ModelRequestRecord[] }
  | { action: "read"; since: number; limit: number }
  | { action: "close" }
);

export function createRequestTelemetryClient(directory: string) {
  const workerUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "model-request-telemetry-store.worker",
    distWorkerPath: "model-request-telemetry-store.worker.js",
  });
  const pool = new WorkerTaskPool<StoreRequest, ModelRequestRecord[]>({
    workerUrl,
    workerOptions: { execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl) },
    workerClass: "singleton",
    maxPendingTasks: 4,
    maxPendingBytes: 2 * 1_048_576,
    idleTimeoutMs: 30_000,
    restartOnError: true,
  });
  const pending = new Map<string, ModelRequestRecord>();
  let flushing: Promise<void> | undefined;
  let closed = false;
  let droppedWrites = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let lastWarning = -Infinity;
  const reportDroppedWrites = () => {
    if (Date.now() - lastWarning >= 60_000) {
      lastWarning = Date.now();
      console.error(
        `[model-request-telemetry] asynchronous persistence failed; droppedWrites=${droppedWrites}`,
      );
    }
  };
  const flush = (): Promise<void> => {
    if (flushing) {
      return flushing;
    }
    flushing = (async () => {
      while (pending.size) {
        const records = [...pending.values()].slice(0, 64);
        for (const record of records) {
          pending.delete(record.id);
        }
        try {
          await pool.run(
            { action: "write", directory, records },
            { timeoutMs: 30_000, inputBytes: records.length * 16_384 },
          );
        } catch (error) {
          droppedWrites += records.length;
          reportDroppedWrites();
          throw error;
        }
      }
    })().finally(() => {
      flushing = undefined;
      if (pending.size && !closed && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          // Failed batches are reported by the flush owner, never on token delivery.
          void flush().catch(() => {});
        }, 1_500);
        retryTimer.unref();
      }
    });
    return flushing;
  };
  return {
    write(record: ModelRequestRecord) {
      if (closed) {
        throw new Error("Telemetry writer is closed");
      }
      if (!pending.has(record.id) && pending.size >= 128) {
        droppedWrites++;
        reportDroppedWrites();
        return;
      }
      pending.set(record.id, modelRequestMetadataSnapshot(record));
      if (!retryTimer) {
        // The flush owner records and reports each failed batch exactly once.
        void flush().catch(() => {});
      }
    },
    async read(options: { since?: number; limit?: number } = {}) {
      await flush();
      return pool.run(
        { action: "read", directory, since: options.since ?? 0, limit: options.limit ?? 100 },
        { timeoutMs: 30_000 },
      );
    },
    async close() {
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      try {
        await flush();
        await pool.run({ action: "close", directory }, { timeoutMs: 30_000 });
      } finally {
        await pool.close();
      }
    },
    get droppedWrites() {
      return droppedWrites;
    },
  };
}

export function resolveModelTelemetryDirectory() {
  return path.resolve(
    process.env.OPENCLAW_MODEL_TELEMETRY_DIRECTORY ||
      path.join(resolveStateDir(), "logs", "model-requests"),
  );
}
