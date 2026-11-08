import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync as all,
  executeSqliteQueryTakeFirstSync as first,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  canonicalSourceUrl,
  editResultSchema,
  retentionMs,
  type Query,
  type QueryResult,
} from "./contracts.js";
import { historyRecord, itemRecord, spaceRecord, type createRecords } from "./records.worker.js";

export function readSpaces(
  db: DatabaseSync,
  records: ReturnType<typeof createRecords>,
  query: Query,
  now: number,
): QueryResult {
  const sql = records.sql;
  const cutoff = now - retentionMs;
  switch (query.action) {
    case "spaces.list": {
      let selection = sql
        .selectFrom("spaces")
        .where("deleted_at", query.trash ? "is not" : "is", null);
      if (query.trash) {
        selection = selection.where("deleted_at", ">", cutoff);
      }
      if (query.search) {
        selection = selection.where((eb) =>
          eb.or([
            eb("name", "like", `%${query.search}%`),
            eb("description", "like", `%${query.search}%`),
          ]),
        );
      }
      const count =
        first(
          db,
          selection.select((eb) => eb.fn.countAll<number>().as("count")),
        )?.count ?? 0;
      const spaces = all(
        db,
        selection
          .selectAll()
          .orderBy("created_at")
          .orderBy("id")
          .limit(query.limit)
          .offset(query.offset),
      ).rows.map(spaceRecord);
      return {
        spaces,
        total: count,
        nextOffset: query.offset + spaces.length < count ? query.offset + spaces.length : null,
      };
    }
    case "space.read": {
      const space = records.space(query.spaceId);
      if (!space || (space.deletedAt !== null && space.deletedAt <= cutoff)) {
        return { items: [], total: 0, nextOffset: null };
      }
      let selection = sql
        .selectFrom("items")
        .where("space_id", "=", space.id)
        .where("deleted_at", query.trash ? "is not" : "is", null);
      if (query.trash) {
        selection = selection.where("deleted_at", ">", cutoff);
      }
      if (query.search) {
        selection = selection.where((eb) =>
          eb.or([
            eb("title", "like", `%${query.search}%`),
            eb("notes", "like", `%${query.search}%`),
            eb("category", "like", `%${query.search}%`),
          ]),
        );
      }
      const count =
        first(
          db,
          selection.select((eb) => eb.fn.countAll<number>().as("count")),
        )?.count ?? 0;
      const items = all(
        db,
        selection
          .selectAll()
          .orderBy("created_at")
          .orderBy("id")
          .limit(query.limit)
          .offset(query.offset),
      ).rows.map(itemRecord);
      return {
        space,
        items,
        total: count,
        nextOffset: query.offset + items.length < count ? query.offset + items.length : null,
      };
    }
    case "history": {
      const selection = sql
        .selectFrom("history")
        .where("space_id", "=", query.spaceId)
        .where("at", ">", cutoff);
      const count =
        first(
          db,
          selection.select((eb) => eb.fn.countAll<number>().as("count")),
        )?.count ?? 0;
      const history = all(
        db,
        selection
          .selectAll()
          .orderBy("at", "desc")
          .orderBy("id")
          .limit(query.limit)
          .offset(query.offset),
      ).rows.map(historyRecord);
      return {
        history,
        total: count,
        nextOffset: query.offset + history.length < count ? query.offset + history.length : null,
      };
    }
    case "operation": {
      const row = first(
        db,
        sql.selectFrom("operations").selectAll().where("id", "=", query.operationId),
      );
      return {
        operation: !row
          ? null
          : row.result_json === null || row.at <= cutoff
            ? {
                operationId: row.id,
                status: "expired",
                message:
                  "The saved result expired. Read the current record before making another edit.",
              }
            : editResultSchema.parse(JSON.parse(row.result_json)),
      };
    }
    case "read-later.preview": {
      const space = records.space(query.spaceId);
      if (!space || space.deletedAt !== null || space.kind !== "read-later") {
        throw new Error("Choose an active Read Later Space before importing links.");
      }
      const seen = new Set<string>();
      const preview = query.items.map((item) => {
        const url = canonicalSourceUrl(item.url);
        const duplicate =
          seen.has(url) ||
          Boolean(
            first(
              db,
              sql
                .selectFrom("items")
                .select("id")
                .where("space_id", "=", space.id)
                .where("url", "=", url)
                .where("deleted_at", "is", null),
            ),
          );
        seen.add(url);
        return { id: item.id, url, duplicate };
      });
      return { space, preview };
    }
    default:
      throw new Error("Unsupported Spaces query action.");
  }
}
