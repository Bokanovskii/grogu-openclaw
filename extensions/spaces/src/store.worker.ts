import { createHash, randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  requestSqliteWorkerOperationAdmission,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  canonicalSourceUrl,
  editResultSchema,
  retentionMs,
  type Edit,
  type EditResult,
  type Item,
  type Space,
  type SpacesOperations,
} from "./contracts.js";
import { readSpaces } from "./queries.worker.js";
import { createRecords, historyRecord } from "./records.worker.js";
import { openSpacesDatabase } from "./schema.js";

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<SpacesOperations> {
  if (isMainThread) {
    throw new Error("Spaces storage requires the SQLite worker broker.");
  }
  const db = openSpacesDatabase(context.databasePath);
  const records = createRecords(db);
  const sql = records.sql;
  const all = executeSqliteQuerySync;
  const first = executeSqliteQueryTakeFirstSync;

  function purge(now: number) {
    const cutoff = now - retentionMs;
    const spaces = all(
      db,
      sql.selectFrom("spaces").select("id").where("deleted_at", "<=", cutoff),
    ).rows;
    const items = all(
      db,
      sql
        .selectFrom("items")
        .select("id")
        .where((eb) =>
          eb.or([
            eb("deleted_at", "<=", cutoff),
            eb(
              "space_id",
              "in",
              sql.selectFrom("spaces").select("id").where("deleted_at", "<=", cutoff),
            ),
          ]),
        ),
    ).rows;
    const retired = [...spaces, ...items];
    if (retired.length) {
      all(
        db,
        sql
          .insertInto("retired_records")
          .values(retired)
          .onConflict((conflict) => conflict.doNothing()),
      );
      const expired = new Set(items.map((item) => item.id));
      // Retention cannot silently change active content or leave a reusable stale revision.
      for (const item of items) {
        const children = all(
          db,
          sql.selectFrom("items").select("id").where("parent_id", "=", item.id),
        ).rows;
        for (const child of children) {
          const held = records.item(child.id);
          if (!held || expired.has(held.id)) {
            continue;
          }
          if (held.deletedAt === null) {
            throw new Error(
              "An active checklist child blocks Trash cleanup. Restore its parent first.",
            );
          }
          records.writeItem({
            ...held,
            parentId: null,
            revision: held.revision + 1,
            updatedAt: now,
          });
        }
      }
      if (expired.size) {
        all(
          db,
          sql
            .updateTable("items")
            .set({ parent_id: null })
            .where("id", "in", [...expired]),
        );
      }
    }
    all(db, sql.deleteFrom("items").where("deleted_at", "<=", cutoff));
    all(db, sql.deleteFrom("spaces").where("deleted_at", "<=", cutoff));
    all(db, sql.deleteFrom("history").where("at", "<=", cutoff));
    all(
      db,
      sql
        .updateTable("operations")
        .set({ result_json: null })
        .where("at", "<=", cutoff)
        .where("result_json", "is not", null),
    );
  }
  function apply(edit: Edit, actor: string, now: number): EditResult {
    const result = (
      status: EditResult["status"],
      message: string,
      current?: { space?: Space; item?: Item },
    ): EditResult => ({ operationId: edit.operationId, status, message, ...current });
    const history = (before: Space | Item | null, after: Space | Item, itemId: string | null) => {
      const id = randomUUID();
      all(
        db,
        sql.insertInto("history").values({
          id,
          operation_id: edit.operationId,
          space_id: edit.spaceId,
          item_id: itemId,
          action: edit.action,
          actor,
          at: now,
          before_json: before === null ? null : JSON.stringify(before),
          after_json: JSON.stringify(after),
        }),
      );
      return id;
    };
    const availableId = (id: string) =>
      !records.space(id) &&
      !records.item(id) &&
      !first(db, sql.selectFrom("retired_records").select("id").where("id", "=", id));
    const space = records.space(edit.spaceId);
    if (edit.action === "space.create") {
      if (edit.expectedRevision !== 0 || !availableId(edit.spaceId)) {
        return result("conflict", "The Space ID already exists. Choose a new ID.", { space });
      }
      const created: Space = {
        ...edit.fields,
        id: edit.spaceId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      records.writeSpace(created);
      return {
        ...result("applied", "Space created.", { space: created }),
        historyId: history(null, created, null),
      };
    }
    if (!space) {
      return result("not-found", "The Space does not exist or its Trash period ended.");
    }
    if (
      edit.action === "space.update" ||
      edit.action === "space.delete" ||
      edit.action === "space.restore"
    ) {
      if (space.revision !== edit.expectedRevision) {
        return result(
          "conflict",
          "The Space changed. Your draft is not saved. Review the current values.",
          { space },
        );
      }
      if (edit.action === "space.restore" && space.deletedAt === null) {
        return result("rejected", "This Space is not in Trash.", { space });
      }
      if (edit.action !== "space.restore" && space.deletedAt !== null) {
        return result("rejected", "Restore this Space from Trash before editing it.", { space });
      }
      const updated: Space = {
        ...space,
        ...(edit.action === "space.update" ? edit.fields : {}),
        revision: space.revision + 1,
        updatedAt: now,
        deletedAt:
          edit.action === "space.delete"
            ? now
            : edit.action === "space.restore"
              ? null
              : space.deletedAt,
      };
      if (
        edit.action === "space.update" &&
        edit.fields.kind &&
        edit.fields.kind !== space.kind &&
        first(db, sql.selectFrom("items").select("id").where("space_id", "=", space.id))
      ) {
        return result("rejected", "A Space with saved items cannot change its view type.", {
          space,
        });
      }
      records.writeSpace(updated);
      return {
        ...result(
          "applied",
          edit.action === "space.delete" ? "Space moved to Trash for 30 days." : "Space saved.",
          { space: updated },
        ),
        historyId: history(space, updated, null),
      };
    }
    if (edit.action === "undo") {
      const entry = first(
        db,
        sql
          .selectFrom("history")
          .selectAll()
          .where("id", "=", edit.historyId)
          .where("space_id", "=", space.id),
      );
      if (!entry) {
        return result("not-found", "The history entry does not exist or its 30-day period ended.");
      }
      const snapshot = historyRecord(entry);
      const currentItem = snapshot.itemId !== null ? records.item(snapshot.itemId) : undefined;
      const current = snapshot.itemId === null ? space : currentItem;
      if (!current || current.revision !== edit.expectedRevision) {
        return result("conflict", "The record changed after this edit. Review it before undoing.", {
          space,
          ...(currentItem ? { item: currentItem } : {}),
        });
      }
      if (snapshot.after?.revision !== current.revision) {
        return result("conflict", "Only the latest change to this record can be undone.", {
          space,
        });
      }
      if (snapshot.itemId !== null) {
        if (space.deletedAt !== null) {
          return result("rejected", "Restore this Space before undoing an item change.", { space });
        }
        const item = currentItem;
        if (!item) {
          return result("not-found", "The item does not exist.");
        }
        const group = ["shopping.combine", "undo"].includes(snapshot.action)
          ? all(
              db,
              sql
                .selectFrom("history")
                .selectAll()
                .where("operation_id", "=", snapshot.operationId),
            ).rows.map(historyRecord)
          : [];
        if (snapshot.action === "shopping.combine" && group.length !== 2) {
          return result("rejected", "The combine history is incomplete.");
        }
        if (group.length > 1) {
          if (group.length !== 2) {
            return result("rejected", "The combine history is incomplete.");
          }
          const changes: { before: Item; after: Item }[] = [];
          for (const member of group) {
            if (member.itemId === null || !member.before || !member.after) {
              return result("rejected", "The combine history is incomplete.");
            }
            const held = records.item(member.itemId);
            if (!held || held.revision !== member.after.revision) {
              return result(
                "conflict",
                "A combined item changed. Review both items before undoing.",
              );
            }
            const restored = { ...member.before, revision: held.revision + 1, updatedAt: now };
            const invalid = validateItem(restored, space);
            if (invalid) {
              return result("rejected", invalid);
            }
            changes.push({ before: held, after: restored });
          }
          let historyId: string | undefined;
          for (const change of changes) {
            records.writeItem(change.after);
            const entryId = history(change.before, change.after, change.after.id);
            historyId ??= entryId;
          }
          return {
            ...result("applied", "Both combined items restored.", { item: records.item(item.id) }),
            historyId,
          };
        }
        const before = snapshot.before;
        const restored: Item = {
          ...(before ?? item),
          revision: item.revision + 1,
          updatedAt: now,
          deletedAt: before ? before.deletedAt : now,
        };
        const invalid = validateItem(restored, space);
        if (invalid) {
          return result("rejected", invalid, { space, item });
        }
        records.writeItem(restored);
        return {
          ...result("applied", "Item change undone.", { item: restored }),
          historyId: history(item, restored, item.id),
        };
      }
      const before = snapshot.before;
      const restored: Space = {
        ...(before ?? space),
        revision: space.revision + 1,
        updatedAt: now,
        deletedAt: before ? before.deletedAt : now,
      };
      if (
        restored.kind !== space.kind &&
        first(db, sql.selectFrom("items").select("id").where("space_id", "=", space.id))
      ) {
        return result("rejected", "A Space with saved items cannot change its view type.", {
          space,
        });
      }
      records.writeSpace(restored);
      return {
        ...result("applied", "Space change undone.", { space: restored }),
        historyId: history(space, restored, null),
      };
    }
    if (space.deletedAt !== null) {
      return result("rejected", "Restore this Space from Trash before editing items.", { space });
    }
    if (edit.action === "read-later.import") {
      if (space.kind !== "read-later") {
        return result("rejected", "Import requires a Read Later Space.", { space });
      }
      if (space.revision !== edit.expectedRevision) {
        return result("conflict", "The Space changed after preview. Preview the import again.", {
          space,
        });
      }
      const preview = readSpaces(
        db,
        records,
        {
          action: "read-later.preview",
          spaceId: space.id,
          items: edit.items,
        },
        now,
      ).preview;
      if (!preview || (edit.duplicates === "reject" && preview.some((row) => row.duplicate))) {
        return result(
          "rejected",
          "The import includes duplicate URLs. Preview again and choose Skip duplicates.",
        );
      }
      const planned = edit.items.filter((_item, index) => !preview[index]?.duplicate);
      if (
        new Set(planned.map((item) => item.id)).size !== planned.length ||
        planned.some((item) => !availableId(item.id))
      ) {
        return result("conflict", "An import item ID already exists. Preview again with new IDs.");
      }
      for (const entry of planned) {
        const item: Item = {
          ...entry,
          url: canonicalSourceUrl(entry.url),
          spaceId: space.id,
          status: "open",
          quantity: null,
          unit: "",
          category: "",
          dueDate: null,
          sourceDate: null,
          estimate: null,
          currency: null,
          parentId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        records.writeItem(item);
        history(null, item, item.id);
      }
      return {
        ...result("applied", `${planned.length} links imported.`),
        imported: planned.length,
        skipped: edit.items.length - planned.length,
      };
    }
    const item = records.item(edit.itemId);
    if (edit.action === "item.create") {
      if (edit.expectedRevision !== 0 || !availableId(edit.itemId)) {
        return result("conflict", "The item ID already exists. Choose a new ID.", {
          item: item?.spaceId === space.id ? item : undefined,
        });
      }
      const created: Item = {
        ...edit.fields,
        url: edit.fields.url ? canonicalSourceUrl(edit.fields.url) : null,
        id: edit.itemId,
        spaceId: space.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const invalid = validateItem(created, space);
      if (invalid) {
        return result("rejected", invalid);
      }
      records.writeItem(created);
      return {
        ...result("applied", "Item added.", { item: created }),
        historyId: history(null, created, created.id),
      };
    }
    if (!item || item.spaceId !== space.id) {
      return result("not-found", "The item does not exist in this Space.");
    }
    if (item.revision !== edit.expectedRevision) {
      return result(
        "conflict",
        "The item changed. Your draft is not saved. Review the current values.",
        { item },
      );
    }
    if (edit.action === "shopping.combine") {
      const source = records.item(edit.sourceId);
      if (
        space.kind !== "shopping" ||
        !source ||
        source.spaceId !== space.id ||
        source.id === item.id ||
        item.deletedAt !== null ||
        source.deletedAt !== null ||
        item.status !== "open" ||
        source.status !== "open"
      ) {
        return result("rejected", "Choose two different open items from this Shopping Space.");
      }
      if (source.revision !== edit.sourceRevision) {
        return result("conflict", "The source item changed. Review both items before combining.", {
          item: source,
        });
      }
      if (
        source.title.trim().toLocaleLowerCase("en-US") !==
          item.title.trim().toLocaleLowerCase("en-US") ||
        source.unit !== item.unit ||
        source.category !== item.category ||
        source.parentId !== item.parentId ||
        source.quantity === null ||
        item.quantity === null ||
        source.notes !== item.notes ||
        source.url !== item.url ||
        source.dueDate !== item.dueDate ||
        source.sourceDate !== item.sourceDate ||
        source.estimate !== item.estimate ||
        source.currency !== item.currency ||
        item.quantity + source.quantity > 1e9
      ) {
        return result(
          "rejected",
          "Combine requires matching item details, including sources and estimates, with saved quantities.",
        );
      }
      if (first(db, sql.selectFrom("items").select("id").where("parent_id", "=", source.id))) {
        return result("rejected", "Move the source checklist items before combining.");
      }
      const merged = {
        ...item,
        quantity: item.quantity + source.quantity,
        revision: item.revision + 1,
        updatedAt: now,
      };
      const deleted = { ...source, deletedAt: now, revision: source.revision + 1, updatedAt: now };
      records.writeItem(merged);
      records.writeItem(deleted);
      const historyId = history(item, merged, item.id);
      history(source, deleted, source.id);
      return {
        ...result("applied", "Items combined. The source item is in Trash.", { item: merged }),
        historyId,
      };
    }
    if (edit.action === "item.restore" ? item.deletedAt === null : item.deletedAt !== null) {
      return result(
        "rejected",
        edit.action === "item.restore"
          ? "This item is not in Trash."
          : "Restore this item from Trash before editing it.",
        { item },
      );
    }
    const updated: Item = {
      ...item,
      ...(edit.action === "item.update" ? edit.fields : {}),
      revision: item.revision + 1,
      updatedAt: now,
      deletedAt:
        edit.action === "item.delete"
          ? now
          : edit.action === "item.restore"
            ? null
            : item.deletedAt,
    };
    if (updated.url) {
      updated.url = canonicalSourceUrl(updated.url);
    }
    const invalid = validateItem(updated, space);
    if (invalid) {
      return result("rejected", invalid, { item });
    }
    records.writeItem(updated);
    return {
      ...result(
        "applied",
        edit.action === "item.delete" ? "Item moved to Trash for 30 days." : "Item saved.",
        { item: updated },
      ),
      historyId: history(item, updated, item.id),
    };
  }
  function validateItem(item: Item, space: Space): string | undefined {
    if (
      item.deletedAt !== null &&
      first(
        db,
        sql
          .selectFrom("items")
          .select("id")
          .where("parent_id", "=", item.id)
          .where("deleted_at", "is", null),
      )
    ) {
      return "Move or delete this item's checklist children first.";
    }
    const statuses =
      space.kind === "read-later"
        ? ["open", "read", "archived"]
        : space.kind === "vacation"
          ? ["open", "selected", "archived"]
          : ["open", "done"];
    if (!statuses.includes(item.status)) {
      return `Status ${item.status} is not available in this view.`;
    }
    if (["read-later", "vacation"].includes(space.kind) && !item.url) {
      return "Save a source URL for this research item.";
    }
    if (item.estimate !== null && (!item.currency || !item.sourceDate)) {
      return "A price estimate needs a currency and source date.";
    }
    const visited = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId) {
      const parent = records.item(parentId);
      if (
        visited.has(parentId) ||
        !parent ||
        parent.spaceId !== space.id ||
        parent.deletedAt !== null
      ) {
        return "Checklist parents must be active items in this Space, without a cycle.";
      }
      visited.add(parentId);
      parentId = parent.parentId;
    }
    return undefined;
  }
  return {
    execute(command) {
      if (command.type === "query") {
        return runSqliteDeferredTransactionSync(db, () =>
          readSpaces(db, records, command.input.query, command.input.now),
        );
      }
      const { edit, actor, now } = command.input;
      const digest = createHash("sha256").update(JSON.stringify(edit)).digest("hex");
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { operationId: edit.operationId },
      });
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          purge(now);
          const saved = first(
            db,
            sql.selectFrom("operations").selectAll().where("id", "=", edit.operationId),
          );
          if (saved) {
            if (saved.digest !== digest || saved.actor !== actor) {
              return {
                operationId: edit.operationId,
                status: "rejected",
                message: "This operation ID belongs to a different request or actor.",
              };
            }
            return saved.result_json === null
              ? {
                  operationId: edit.operationId,
                  status: "expired",
                  message:
                    "The saved result expired. Read the current record before making another edit.",
                }
              : editResultSchema.parse(JSON.parse(saved.result_json));
          }
          const result = apply(edit, actor, now);
          all(
            db,
            sql.insertInto("operations").values({
              id: edit.operationId,
              digest,
              actor,
              at: now,
              result_json: JSON.stringify(result),
            }),
          );
          return result;
        },
        {
          withCommit(commit) {
            requestSqliteWorkerOperationAdmission({
              stage: "commit",
              facts: { operationId: edit.operationId },
            });
            commit();
          },
        },
      );
    },
    close() {
      db.close();
    },
  };
}
