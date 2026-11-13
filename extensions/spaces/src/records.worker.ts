import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  itemRecordSchema,
  spaceRecordSchema,
  type HistoryEntry,
  type Item,
  type ItemFields,
  type Space,
  type SpaceFields,
} from "./contracts.js";

export type SpaceRow = SpaceFields & {
  id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
export type ItemRow = Omit<ItemFields, "dueDate" | "sourceDate" | "parentId"> & {
  id: string;
  space_id: string;
  due_date: string | null;
  source_date: string | null;
  parent_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
export type HistoryRow = {
  id: string;
  operation_id: string;
  space_id: string;
  item_id: string | null;
  action: string;
  actor: string;
  at: number;
  before_json: string | null;
  after_json: string | null;
};
export type Tables = {
  spaces: SpaceRow;
  items: ItemRow;
  history: HistoryRow;
  operations: { id: string; digest: string; actor: string; at: number; result_json: string | null };
  retired_records: { id: string };
};
export function spaceRecord(row: SpaceRow): Space {
  const { created_at, updated_at, deleted_at, ...fields } = row;
  return { ...fields, createdAt: created_at, updatedAt: updated_at, deletedAt: deleted_at };
}
export function itemRecord(row: ItemRow): Item {
  const {
    space_id,
    due_date,
    source_date,
    parent_id,
    created_at,
    updated_at,
    deleted_at,
    ...fields
  } = row;
  return {
    ...fields,
    spaceId: space_id,
    dueDate: due_date,
    sourceDate: source_date,
    parentId: parent_id,
    createdAt: created_at,
    updatedAt: updated_at,
    deletedAt: deleted_at,
  };
}
function spaceRow(record: Space): SpaceRow {
  const { createdAt, updatedAt, deletedAt, ...fields } = record;
  return { ...fields, created_at: createdAt, updated_at: updatedAt, deleted_at: deletedAt };
}
function itemRow(record: Item): ItemRow {
  const { spaceId, dueDate, sourceDate, parentId, createdAt, updatedAt, deletedAt, ...fields } =
    record;
  return {
    ...fields,
    space_id: spaceId,
    due_date: dueDate,
    source_date: sourceDate,
    parent_id: parentId,
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: deletedAt,
  };
}
export function historyRecord(row: HistoryRow): HistoryEntry {
  const base = {
    id: row.id,
    operationId: row.operation_id,
    spaceId: row.space_id,
    action: row.action,
    actor: row.actor,
    at: row.at,
  };
  return row.item_id === null
    ? {
        ...base,
        itemId: null,
        before:
          row.before_json === null ? null : spaceRecordSchema.parse(JSON.parse(row.before_json)),
        after: row.after_json === null ? null : spaceRecordSchema.parse(JSON.parse(row.after_json)),
      }
    : {
        ...base,
        itemId: row.item_id,
        before:
          row.before_json === null ? null : itemRecordSchema.parse(JSON.parse(row.before_json)),
        after: row.after_json === null ? null : itemRecordSchema.parse(JSON.parse(row.after_json)),
      };
}
export function createRecords(db: DatabaseSync) {
  const sql = getNodeSqliteKysely<Tables>(db);
  return {
    sql,
    space(id: string) {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        sql.selectFrom("spaces").selectAll().where("id", "=", id),
      );
      return row ? spaceRecord(row) : undefined;
    },
    item(id: string) {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        sql.selectFrom("items").selectAll().where("id", "=", id),
      );
      return row ? itemRecord(row) : undefined;
    },
    writeSpace(record: Space) {
      executeSqliteQuerySync(
        db,
        sql
          .insertInto("spaces")
          .values(spaceRow(record))
          .onConflict((conflict) => conflict.column("id").doUpdateSet(spaceRow(record))),
      );
    },
    writeItem(record: Item) {
      executeSqliteQuerySync(
        db,
        sql
          .insertInto("items")
          .values(itemRow(record))
          .onConflict((conflict) => conflict.column("id").doUpdateSet(itemRow(record))),
      );
    },
  };
}
