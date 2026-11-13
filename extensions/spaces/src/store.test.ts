import { copyFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { useSqliteWorkerFault } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeDescriptorSnapshot,
  retentionMs,
  type Caller,
  type Edit,
  type SpaceFields,
} from "./contracts.js";
import { SpacesStore } from "./store.js";

const fault = useSqliteWorkerFault([
  {
    name: "spaces_operation_result",
    match: /insert into operations/i,
    sql: "CREATE TEMP TRIGGER spaces_operation_result BEFORE INSERT ON operations BEGIN SELECT json_extract('synthetic malformed JSON', '$'); END",
  },
]);
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const caller: Caller = { actor: "operator", assertCurrent() {} };
const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);
let now = Date.UTC(2026, 10, 8);
let store: SpacesStore;
let root: string;
let sequence = 0;
const fields: SpaceFields = {
  name: "Weekend tasks",
  description: "Tasks for the weekend.",
  rules: "Complete tasks only when the work is done.",
  kind: "todo",
};
const edit = (input: Omit<Edit, "operationId"> & Record<string, unknown>) =>
  store.edit({ operationId: `operation-${++sequence}`, ...input }, caller);

beforeAll(async () => {
  root = tempDirs.make("spaces-");
  store = new SpacesStore({
    databasePath: path.join(root, "spaces.sqlite"),
    workerModuleUrl,
    now: () => now,
  });
  await store.ready();
});
afterAll(async () => {
  await store.close();
});

describe("Spaces through the SQLite worker broker", () => {
  it("saves content, independent item revisions, conflicts and explicit completion across callers", async () => {
    expect(
      await edit({ action: "space.create", spaceId: "tasks", expectedRevision: 0, fields }),
    ).toMatchObject({ status: "applied", space: { revision: 1 } });
    for (const itemId of ["task-a", "task-b"]) {
      expect(
        await edit({
          action: "item.create",
          spaceId: "tasks",
          itemId,
          expectedRevision: 0,
          fields: { title: itemId, notes: "Keep this note.", quantity: 2 },
        }),
      ).toMatchObject({ status: "applied", item: { revision: 1 } });
    }
    const agent: Caller = { actor: "agent:grogu", assertCurrent() {} };
    const operation = {
      action: "item.update",
      operationId: "finish-task-a",
      spaceId: "tasks",
      itemId: "task-a",
      expectedRevision: 1,
      fields: { status: "done" },
    };
    const done = await store.edit(operation, agent);
    expect(done).toMatchObject({
      status: "applied",
      item: { status: "done", revision: 2, notes: "Keep this note.", quantity: 2 },
    });
    expect(await store.edit(operation, agent)).toEqual(done);
    expect(await store.edit(operation, caller)).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("actor"),
    });
    expect(await store.edit({ ...operation, fields: { status: "open" } }, agent)).toMatchObject({
      status: "rejected",
    });
    expect(
      await edit({
        action: "item.update",
        spaceId: "tasks",
        itemId: "task-a",
        expectedRevision: 1,
        fields: { title: "Unsaved draft" },
      }),
    ).toMatchObject({ status: "conflict", item: { title: "task-a", status: "done", revision: 2 } });
    expect(
      await edit({
        action: "item.update",
        spaceId: "tasks",
        itemId: "task-b",
        expectedRevision: 1,
        fields: { title: "Independent edit" },
      }),
    ).toMatchObject({
      status: "applied",
      item: { revision: 2, notes: "Keep this note.", quantity: 2 },
    });
    const read = await store.query({ action: "space.read", spaceId: "tasks" }, agent);
    expect(read.items).toHaveLength(2);
    expect(read.space).toMatchObject({ rules: fields.rules, revision: 1 });
    expect(
      (await store.query({ action: "history", spaceId: "tasks" }, caller)).history?.some(
        (entry) => entry.actor === "agent:grogu",
      ),
    ).toBe(true);
  });

  it("rolls back content and history when the operation result cannot be stored", async () => {
    fault.enable();
    await expect(
      edit({
        action: "item.create",
        spaceId: "tasks",
        itemId: "rollback-item",
        expectedRevision: 0,
        fields: { title: "Must not survive" },
      }),
    ).rejects.toThrow("malformed JSON");
    fault.disable();
    expect(
      (await store.query({ action: "space.read", spaceId: "tasks" }, caller)).items?.some(
        (item) => item.id === "rollback-item",
      ),
    ).toBe(false);
    expect(
      (await store.query({ action: "history", spaceId: "tasks" }, caller)).history?.some(
        (entry) => entry.itemId === "rollback-item",
      ),
    ).toBe(false);
  });

  it("refuses revoked requests and settles accepted writes before shutdown", async () => {
    const controller = new AbortController();
    const revoked: Caller = {
      actor: "operator",
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
      },
    };
    const pending = store.edit(
      {
        action: "item.create",
        operationId: "revoked",
        spaceId: "tasks",
        itemId: "revoked-item",
        expectedRevision: 0,
        fields: { title: "Not authorized" },
      },
      revoked,
    );
    controller.abort(new Error("Synthetic caller revocation"));
    await expect(pending).rejects.toThrow("Synthetic caller revocation");
    const accepted = edit({
      action: "item.create",
      spaceId: "tasks",
      itemId: "drained-item",
      expectedRevision: 0,
      fields: { title: "Persist before close" },
    });
    const closing = store.close();
    expect(await accepted).toMatchObject({ status: "applied" });
    await closing;
    store = new SpacesStore({
      databasePath: path.join(root, "spaces.sqlite"),
      workerModuleUrl,
      now: () => now,
    });
    await store.ready();
    const items = (await store.query({ action: "space.read", spaceId: "tasks" }, caller)).items;
    expect(items?.some((item) => item.id === "revoked-item")).toBe(false);
    expect(items?.find((item) => item.id === "drained-item")?.title).toBe("Persist before close");
    expect(
      (
        await store.query(
          { action: "operation", operationId: "finish-task-a" },
          { actor: "agent:grogu", assertCurrent() {} },
        )
      ).operation,
    ).toMatchObject({ status: "applied", item: { status: "done", revision: 2 } });
  });

  it("combines matching Shopping items and undoes both changes together", async () => {
    await edit({
      action: "space.create",
      spaceId: "shopping",
      expectedRevision: 0,
      fields: { ...fields, name: "Groceries", kind: "shopping" },
    });
    for (const [itemId, quantity] of [
      ["milk-a", 2],
      ["milk-b", 3],
    ] as const) {
      await edit({
        action: "item.create",
        spaceId: "shopping",
        itemId,
        expectedRevision: 0,
        fields: { title: "Milk", quantity, unit: "liters" },
      });
    }
    const combined = await edit({
      action: "shopping.combine",
      spaceId: "shopping",
      itemId: "milk-a",
      expectedRevision: 1,
      sourceId: "milk-b",
      sourceRevision: 1,
    });
    expect(combined).toMatchObject({ status: "applied", item: { quantity: 5, revision: 2 } });
    expect(
      (await store.query({ action: "space.read", spaceId: "shopping" }, caller)).items,
    ).toHaveLength(1);
    const undone = await edit({
      action: "undo",
      spaceId: "shopping",
      expectedRevision: 2,
      historyId: combined.historyId,
    });
    expect(undone).toMatchObject({ status: "applied" });
    expect(
      (await store.query({ action: "space.read", spaceId: "shopping" }, caller)).items
        ?.map((item) => item.quantity)
        .toSorted(),
    ).toEqual([2, 3]);
    expect(
      await edit({
        action: "undo",
        spaceId: "shopping",
        expectedRevision: 3,
        historyId: undone.historyId,
      }),
    ).toMatchObject({ status: "applied", item: { quantity: 5 } });
    expect(
      (await store.query({ action: "space.read", spaceId: "shopping" }, caller)).items,
    ).toHaveLength(1);
  });

  it("previews duplicate sources, imports atomically and preserves dated research", async () => {
    await edit({
      action: "space.create",
      spaceId: "reading",
      expectedRevision: 0,
      fields: { ...fields, kind: "read-later" },
    });
    const items = [
      {
        id: "read-a",
        title: "A source",
        url: "https://example.com/article#one",
        notes: "Independent source reference.",
      },
      { id: "read-b", title: "A duplicate", url: "https://example.com/article#two" },
    ];
    expect(
      (await store.query({ action: "read-later.preview", spaceId: "reading", items }, caller))
        .preview,
    ).toEqual([
      { id: "read-a", url: "https://example.com/article", duplicate: false },
      { id: "read-b", url: "https://example.com/article", duplicate: true },
    ]);
    expect(
      await edit({
        action: "read-later.import",
        spaceId: "reading",
        expectedRevision: 1,
        items,
        duplicates: "reject",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await store.query({ action: "space.read", spaceId: "reading" }, caller)).items,
    ).toHaveLength(0);
    expect(
      await edit({
        action: "read-later.import",
        spaceId: "reading",
        expectedRevision: 1,
        items,
        duplicates: "skip",
      }),
    ).toMatchObject({ status: "applied", imported: 1, skipped: 1 });
    await edit({
      action: "space.create",
      spaceId: "vacation",
      expectedRevision: 0,
      fields: { ...fields, kind: "vacation" },
    });
    expect(
      await edit({
        action: "item.create",
        spaceId: "vacation",
        itemId: "hotel",
        expectedRevision: 0,
        fields: { title: "Hotel candidate", url: "https://example.com/hotel", estimate: 100 },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await edit({
        action: "item.create",
        spaceId: "vacation",
        itemId: "hotel",
        expectedRevision: 0,
        fields: {
          title: "Hotel candidate",
          url: "https://example.com/hotel",
          estimate: 100,
          currency: "USD",
          sourceDate: "2026-11-08",
          status: "selected",
        },
      }),
    ).toMatchObject({
      status: "applied",
      item: { estimate: 100, currency: "USD", sourceDate: "2026-11-08" },
    });
  });

  it("rejects cyclic and cross-Space checklist links without changing the saved item", async () => {
    expect(
      await edit({
        action: "item.update",
        spaceId: "tasks",
        itemId: "task-a",
        expectedRevision: 2,
        fields: { parentId: "task-a" },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await edit({
        action: "item.update",
        spaceId: "tasks",
        itemId: "task-a",
        expectedRevision: 2,
        fields: { parentId: "hotel" },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await store.query({ action: "space.read", spaceId: "tasks" }, caller)).items?.find(
        (item) => item.id === "task-a",
      ),
    ).toMatchObject({ revision: 2, parentId: null });
    const parent = await edit({
      action: "item.create",
      spaceId: "tasks",
      itemId: "checklist-parent",
      expectedRevision: 0,
      fields: { title: "Parent" },
    });
    await edit({
      action: "item.create",
      spaceId: "tasks",
      itemId: "checklist-child",
      expectedRevision: 0,
      fields: { title: "Child", parentId: "checklist-parent" },
    });
    expect(
      await edit({
        action: "undo",
        spaceId: "tasks",
        historyId: parent.historyId,
        expectedRevision: 1,
      }),
    ).toMatchObject({ status: "rejected", message: expect.stringContaining("children") });
  });

  it("does not undo a view type change after items were saved under the new type", async () => {
    await edit({ action: "space.create", spaceId: "kind-guard", expectedRevision: 0, fields });
    const changed = await edit({
      action: "space.update",
      spaceId: "kind-guard",
      expectedRevision: 1,
      fields: { kind: "shopping" },
    });
    await edit({
      action: "item.create",
      spaceId: "kind-guard",
      itemId: "kind-guard-item",
      expectedRevision: 0,
      fields: { title: "A saved item", quantity: 1 },
    });
    expect(
      await edit({
        action: "undo",
        spaceId: "kind-guard",
        expectedRevision: 2,
        historyId: changed.historyId,
      }),
    ).toMatchObject({ status: "rejected", space: { kind: "shopping" } });
  });

  it("bounds complete discovery and does not truncate UTF-8 descriptions or full rules", async () => {
    const description = "é".repeat(120);
    for (let index = 0; index < 10; index++) {
      await edit({
        action: "space.create",
        spaceId: `catalog-${index}`,
        expectedRevision: 0,
        fields: { ...fields, description, name: `Catalog ${index} ${"x".repeat(170)}` },
      });
    }
    expect(() =>
      edit({
        action: "space.create",
        spaceId: "too-long",
        expectedRevision: 0,
        fields: { ...fields, description: `${description}é` },
      }),
    ).toThrow("240 UTF-8");
    const snapshot = await store.descriptors(caller);
    expect(snapshot.spaces.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(encodeDescriptorSnapshot(snapshot), "utf8")).toBeLessThanOrEqual(4096);
    expect(snapshot.omitted).toBeGreaterThan(0);
    expect(
      snapshot.spaces
        .filter((space) => space.id.startsWith("catalog-"))
        .every((space) => space.description === description),
    ).toBe(true);
    const page = await store.query({ action: "spaces.list", offset: 8, limit: 8 }, caller);
    expect(page.spaces?.length).toBeGreaterThan(0);
    const saved = await store.query({ action: "space.read", spaceId: "catalog-0" }, caller);
    expect(saved.space?.rules).toBe(fields.rules);
  });

  it("distinguishes item undo from metadata undo in saved-change notifications", async () => {
    const changes: { spaceId: string; metadata: boolean }[] = [];
    const unsubscribe = store.subscribe((change) => changes.push(change));
    try {
      const created = await edit({
        action: "space.create",
        spaceId: "notifications",
        expectedRevision: 0,
        fields,
      });
      const item = await edit({
        action: "item.create",
        spaceId: "notifications",
        itemId: "notification-item",
        expectedRevision: 0,
        fields: { title: "A saved task" },
      });
      expect(
        await edit({
          action: "undo",
          spaceId: "notifications",
          historyId: item.historyId,
          expectedRevision: 1,
        }),
      ).toMatchObject({ status: "applied" });
      expect(changes.at(-1)).toEqual({ spaceId: "notifications", metadata: false });
      expect(
        await edit({
          action: "undo",
          spaceId: "notifications",
          historyId: created.historyId,
          expectedRevision: 1,
        }),
      ).toMatchObject({ status: "applied" });
      expect(changes.at(-1)).toEqual({ spaceId: "notifications", metadata: true });
    } finally {
      unsubscribe();
    }
  });

  it("restores a consistent online SQLite backup after later writes and restart", async () => {
    const source = new DatabaseSync(path.join(root, "spaces.sqlite"), { readOnly: true });
    const snapshotPath = path.join(root, "verified-backup.sqlite");
    try {
      await backup(source, snapshotPath);
    } finally {
      source.close();
    }
    await edit({
      action: "item.update",
      spaceId: "tasks",
      itemId: "task-a",
      expectedRevision: 2,
      fields: { title: "After backup" },
    });
    await store.close();
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(snapshot.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    } finally {
      snapshot.close();
    }
    copyFileSync(snapshotPath, path.join(root, "spaces.sqlite"));
    store = new SpacesStore({
      databasePath: path.join(root, "spaces.sqlite"),
      workerModuleUrl,
      now: () => now,
    });
    await store.ready();
    expect(
      (await store.query({ action: "space.read", spaceId: "tasks" }, caller)).items?.find(
        (item) => item.id === "task-a",
      ),
    ).toMatchObject({ title: "task-a", status: "done", revision: 2 });
  });

  it("expires Trash, content history and outcomes at 30 days without reusing operation or record IDs", async () => {
    await edit({ action: "space.create", spaceId: "expiring", expectedRevision: 0, fields });
    const deleted = await edit({
      action: "space.delete",
      spaceId: "expiring",
      expectedRevision: 1,
    });

    now += retentionMs;
    expect(
      (await store.query({ action: "spaces.list", trash: true }, caller)).spaces?.some(
        (space) => space.id === "expiring",
      ),
    ).toBe(false);
    expect((await store.query({ action: "history", spaceId: "expiring" }, caller)).history).toEqual(
      [],
    );
    expect(
      (await store.query({ action: "operation", operationId: deleted.operationId }, caller))
        .operation,
    ).toMatchObject({ status: "expired" });
    expect(
      await edit({ action: "space.restore", spaceId: "expiring", expectedRevision: 2 }),
    ).toMatchObject({ status: "not-found" });
    expect(
      await edit({ action: "space.create", spaceId: "expiring", expectedRevision: 0, fields }),
    ).toMatchObject({ status: "conflict" });
    expect(
      await store.edit(
        {
          action: "space.delete",
          operationId: deleted.operationId,
          spaceId: "expiring",
          expectedRevision: 1,
        },
        caller,
      ),
    ).toMatchObject({ status: "expired" });
  });
  it("refuses future and unversioned schemas without adopting their tables", async () => {
    for (const version of [0, 2]) {
      const databasePath = path.join(root, `unsupported-${version}.sqlite`);
      const fixture = new DatabaseSync(databasePath);
      fixture.exec(
        `CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('synthetic'); PRAGMA user_version = ${version}`,
      );
      fixture.close();
      const unsupported = new SpacesStore({ databasePath, workerModuleUrl });
      const message = version === 0 ? "unversioned" : "unsupported";
      await expect(unsupported.ready()).rejects.toThrow(message);
      await expect(unsupported.close()).rejects.toThrow(message);
      const saved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(saved.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        expect(saved.prepare("SELECT value FROM preserved").get()?.value).toBe("synthetic");
        expect(saved.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([
          { name: "preserved" },
        ]);
      } finally {
        saved.close();
      }
    }
  });
});
