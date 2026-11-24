import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  collectSqliteSchemaIssues,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { ensureFirstUseStateColumns } from "./openclaw-state-db-schema-helpers.js";
import {
  PROTECTED_SHARED_STATE_SCHEMA_SQL,
  widenProtectedCronScratchInDatabase,
} from "./openclaw-state-protected-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("upgrades populated automation tables without rewriting rows or resetting a cursor on replay", () => {
  const db = new DatabaseSync(":memory:");
  const tables = ["protected_automations", "protected_automation_run_chats"];
  const schema = tables
    .map((table) => extractSqliteTableSchema(PROTECTED_SHARED_STATE_SCHEMA_SQL, table))
    .join("\n");
  const priorSchema = schema.replace(/,\n {2}pacing_\w+ INTEGER/gu, "");
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    db.exec(`
      PRAGMA user_version = 21;
      CREATE TABLE user_profiles (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO user_profiles VALUES ('owner');
      ${priorSchema}
    `);
    db.prepare(`INSERT INTO protected_automations
      (id, creator_profile_id, central_owner_profile_id, provider, definition_json,
       definition_revision, visibility, created_at, updated_at)
      VALUES (?, 'owner', 'owner', 'sparky', ?, 1, 'private', 1, 1)`).run(
      id,
      '"opaque legacy envelope"',
    );
    db.prepare(`INSERT INTO protected_automation_run_chats
      (automation_id, profile_id, chat_id, last_scheduled_at_ms, charged_bytes)
      VALUES (?, 'owner', 'chat', 42, 512)`).run(id);
    const definition = () => db.prepare("SELECT * FROM protected_automations").get();
    const chat = () => db.prepare("SELECT * FROM protected_automation_run_chats").get();
    const oldDefinition = definition();
    const oldChat = chat();
    db.exec("BEGIN IMMEDIATE");
    ensureFirstUseStateColumns(db, tables);
    db.exec("ROLLBACK");
    expect(definition()).toEqual(oldDefinition);
    expect(chat()).toEqual(oldChat);

    ensureFirstUseStateColumns(db, tables);
    expect(collectSqliteSchemaIssues(db, schema)).toEqual([]);
    expect(definition()).toEqual({ ...oldDefinition, pacing_min_ms: null, pacing_max_ms: null });
    expect(chat()).toEqual({
      ...oldChat,
      pacing_revision: null,
      pacing_next_at_ms: null,
      pacing_reason: null,
      pacing_failures: null,
    });
    db.exec(`UPDATE protected_automations SET pacing_min_ms = 60000, pacing_max_ms = 90000;
      UPDATE protected_automation_run_chats SET
        pacing_revision = 1, pacing_next_at_ms = 80000, pacing_reason = 1, pacing_failures = 0`);
    const paced = [definition(), chat()];
    ensureFirstUseStateColumns(db, tables);
    expect([definition(), chat()]).toEqual(paced);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
  } finally {
    db.close();
  }
});

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
