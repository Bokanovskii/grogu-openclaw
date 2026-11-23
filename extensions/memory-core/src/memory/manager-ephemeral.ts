import { randomUUID } from "node:crypto";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type {
  EphemeralMemoryFile,
  EphemeralMemoryIdentity,
  EphemeralMemoryResult,
  EphemeralMemoryTask,
} from "./manager-ephemeral-task.js";
import type { MemoryIndexPreparationInput } from "./manager-index-preparation.js";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type EphemeralMemoryAccess = Omit<EphemeralMemoryIdentity, "incarnation"> & {
  assertCurrent: () => void;
};

/** A derived index for one host-owned member workspace. Canonical files stay with their owner. */
export class EphemeralMemoryIndex {
  private readonly identity: EphemeralMemoryIdentity;
  private readonly pool: WorkerTaskPool<EphemeralMemoryTask, EphemeralMemoryResult>;
  private closed = false;
  private opened = false;
  private opening = false;
  private ready = false;
  private generation = 0;

  constructor(identity: Omit<EphemeralMemoryIdentity, "incarnation">) {
    if (!identity.memberKey || !identity.workspaceGeneration) {
      throw new Error("Member memory index requires a workspace identity.");
    }
    this.identity = {
      memberKey: identity.memberKey,
      workspaceGeneration: identity.workspaceGeneration,
      incarnation: randomUUID(),
    };
    this.pool = new WorkerTaskPool({
      workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.ephemeral),
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      maxPendingTasks: 8,
      maxPendingBytes: MAX_SNAPSHOT_BYTES,
    });
  }

  private assertAvailable(access: EphemeralMemoryAccess) {
    if (this.closed) {
      throw new Error("Member memory index is closed.");
    }
    if (
      access.memberKey !== this.identity.memberKey ||
      access.workspaceGeneration !== this.identity.workspaceGeneration
    ) {
      throw new Error("Member memory index belongs to another workspace.");
    }
    access.assertCurrent();
  }

  private async execute(task: EphemeralMemoryTask, access: EphemeralMemoryAccess, inputBytes = 0) {
    this.assertAvailable(access);
    const result = await this.pool.run(task, {
      inputBytes,
      onRequest: async (request) => {
        this.assertAvailable(access);
        if (
          !request ||
          typeof request !== "object" ||
          !("kind" in request) ||
          request.kind !== "publish" ||
          !("identity" in request) ||
          JSON.stringify(request.identity) !== JSON.stringify(this.identity)
        ) {
          throw new Error("Invalid member memory publication request.");
        }
        return { input: true, timeoutMs: 60_000 };
      },
    });
    this.assertAvailable(access);
    return result;
  }

  async open(access: EphemeralMemoryAccess) {
    if (this.opened || this.opening) {
      throw new Error("Member memory index is already open.");
    }
    this.opening = true;
    try {
      const result = await this.execute({ kind: "open", identity: this.identity }, access);
      if (result.kind !== "open") {
        throw new Error("Invalid member memory index opening result.");
      }
      this.opened = true;
    } finally {
      this.opening = false;
    }
  }

  async rebuild(
    files: EphemeralMemoryFile[],
    access: EphemeralMemoryAccess,
    chunking: MemoryIndexPreparationInput["chunking"],
  ) {
    this.assertAvailable(access);
    if (!this.opened) {
      throw new Error("Member memory index is not open.");
    }
    const generation = ++this.generation;
    this.ready = false;
    if (files.length > 10_000) {
      throw new Error("Member memory index exceeds its rebuild capacity.");
    }
    const snapshot = files.map((file) => ({ ...file }));
    const bytes = snapshot.reduce(
      (total, file) =>
        total +
        256 +
        Math.max(Buffer.byteLength(file.path), file.path.length * 2) +
        Math.max(Buffer.byteLength(file.content), file.content.length * 2),
      0,
    );
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("Member memory index exceeds its rebuild capacity.");
    }
    const result = await this.execute(
      { kind: "rebuild", identity: this.identity, files: snapshot, chunking: { ...chunking } },
      access,
      bytes,
    );
    if (result.kind !== "rebuild") {
      throw new Error("Invalid member memory index rebuild result.");
    }
    if (generation !== this.generation) {
      throw new Error("Member memory index changed during rebuild.");
    }
    this.ready = true;
  }

  async search(query: string, limit: number, access: EphemeralMemoryAccess) {
    this.assertAvailable(access);
    if (!this.ready) {
      throw new Error("Member memory index requires a successful rebuild.");
    }
    if (
      Buffer.byteLength(query) > 16 * 1024 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new Error("Member memory search exceeds its request limits.");
    }
    const generation = this.generation;
    const result = await this.execute(
      { kind: "search", identity: this.identity, query, limit },
      access,
      Buffer.byteLength(query),
    );
    if (result.kind !== "search") {
      throw new Error("Invalid member memory index search result.");
    }
    if (!this.ready || generation !== this.generation) {
      throw new Error("Member memory index changed during search.");
    }
    return result.rows;
  }

  async close() {
    this.closed = true;
    this.ready = false;
    this.generation += 1;
    await this.pool.close();
  }
}

type MemberIndexEntry = {
  index: EphemeralMemoryIndex;
  workspaceGeneration: string;
  opening: Promise<void>;
  tail: Promise<void>;
  chunkingKey?: string;
  dirty: boolean;
  holders: number;
  retired: boolean;
  closing?: Promise<void>;
};

/** Owns bounded member indexes only while their authorized callers hold leases. */
export class EphemeralMemoryIndexes {
  private readonly entries = new Map<string, MemberIndexEntry>();
  private closed = false;

  constructor(private readonly maxMembers = 4) {
    if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
      throw new Error("Member memory index capacity must be positive.");
    }
  }

  private retireEntry(memberKey: string, entry: MemberIndexEntry): Promise<void> {
    entry.retired = true;
    entry.closing ??= Promise.all([entry.index.close(), entry.tail]).then(() => {
      if (this.entries.get(memberKey) === entry) {
        this.entries.delete(memberKey);
      }
    });
    return entry.closing;
  }

  async acquire(access: EphemeralMemoryAccess) {
    access.assertCurrent();
    if (this.closed) {
      throw new Error("Member memory indexes are closed.");
    }
    let entry = this.entries.get(access.memberKey);
    if (entry?.retired) {
      await entry.closing;
      access.assertCurrent();
      if (this.closed) {
        throw new Error("Member memory indexes are closed.");
      }
      entry = this.entries.get(access.memberKey);
    }
    if (entry && entry.workspaceGeneration !== access.workspaceGeneration) {
      throw new Error("Member memory workspace changed; retire its index before reuse.");
    }
    if (!entry) {
      if (this.entries.size >= this.maxMembers) {
        throw new Error("Member memory index capacity is unavailable.");
      }
      const index = new EphemeralMemoryIndex(access);
      entry = {
        index,
        workspaceGeneration: access.workspaceGeneration,
        opening: index.open(access),
        tail: Promise.resolve(),
        dirty: true,
        holders: 0,
        retired: false,
      };
      this.entries.set(access.memberKey, entry);
    }
    const leasedEntry = entry;
    leasedEntry.holders += 1;
    let released = false;
    const boundAccess: EphemeralMemoryAccess = {
      ...access,
      assertCurrent: () => {
        if (released || leasedEntry.retired || this.closed) {
          throw new Error("Member memory index lease is no longer current.");
        }
        access.assertCurrent();
      },
    };
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      leasedEntry.holders -= 1;
      if (leasedEntry.holders === 0) {
        await this.retireEntry(access.memberKey, leasedEntry);
      }
    };
    try {
      await leasedEntry.opening;
      boundAccess.assertCurrent();
    } catch (error) {
      await release();
      throw error;
    }
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = leasedEntry.tail.then(async () => {
        boundAccess.assertCurrent();
        const value = await operation();
        boundAccess.assertCurrent();
        return value;
      });
      leasedEntry.tail = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    return {
      rebuild: async (
        files: EphemeralMemoryFile[],
        chunking: MemoryIndexPreparationInput["chunking"],
      ) => {
        leasedEntry.dirty = true;
        await leasedEntry.index.rebuild(files, boundAccess, chunking);
        leasedEntry.chunkingKey = JSON.stringify(chunking);
        leasedEntry.dirty = false;
      },
      search: (query: string, limit: number) => leasedEntry.index.search(query, limit, boundAccess),
      run,
      isDirty: (chunking: MemoryIndexPreparationInput["chunking"]) =>
        leasedEntry.dirty || leasedEntry.chunkingKey !== JSON.stringify(chunking),
      markDirty: () => {
        boundAccess.assertCurrent();
        leasedEntry.dirty = true;
      },
      release,
    };
  }

  async retire(memberKey: string): Promise<void> {
    const entry = this.entries.get(memberKey);
    if (entry) {
      await this.retireEntry(memberKey, entry);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.entries].map(([memberKey, entry]) => this.retireEntry(memberKey, entry)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Member memory indexes could not be retired.");
    }
  }
}
