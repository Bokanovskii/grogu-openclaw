import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  collectSqliteSchemaIssues,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  PROTECTED_SHARED_STATE_SCHEMA_SQL,
  widenProtectedCronScratchInDatabase,
} from "./openclaw-state-protected-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("keeps the personal scratch limit and verifies the protected v21 constraint", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const scratch = (schema: string) =>
      extractSqliteTableSchema(schema, "cron_job_scratch", { errorMessage: "missing scratch" });
    const personal = scratch(OPENCLAW_STATE_SCHEMA_SQL);
    const protectedSchema = scratch(PROTECTED_SHARED_STATE_SCHEMA_SQL);
    db.exec(personal);
    db.exec(
      "CREATE INDEX idx_cron_job_scratch_store_updated ON cron_job_scratch(store_key, updated_at_ms DESC, job_id)",
    );
    const insert = db.prepare("INSERT INTO cron_job_scratch VALUES ('store', ?, ?, 1, NULL, 1)");
    insert.run("job", "x".repeat(262_144));
    expect(() => insert.run("too-large", "x".repeat(262_145))).toThrow();
    const policy: SqliteSchemaCompatibility = {};
    expect(collectSqliteSchemaIssues(db, protectedSchema, policy)).not.toEqual([]);
    db.exec("BEGIN IMMEDIATE");
    widenProtectedCronScratchInDatabase(db);
    db.exec("COMMIT");
    expect(collectSqliteSchemaIssues(db, protectedSchema, policy)).toEqual([]);
    expect(collectSqliteSchemaIssues(db, personal, policy)).not.toEqual([]);
    expect(db.prepare("SELECT length(content) AS length FROM cron_job_scratch").get()?.length).toBe(
      262_144,
    );
    insert.run("protected-limit", "x".repeat(699_188));
    expect(() => insert.run("too-large", "x".repeat(699_189))).toThrow();
  } finally {
    db.close();
  }
});
