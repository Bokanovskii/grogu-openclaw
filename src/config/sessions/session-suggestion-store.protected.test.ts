import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
} from "./session-suggestion-store.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-protected-suggestions-");

it("protects suggestion fields without changing author filtering or limits", async () => {
  const dir = sessionDirs.make();
  const keyPath = path.join(dir, "key");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  const storePath = path.join(stateDir, "protected.sqlite");
  fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  await withEnvAsync(
    { OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath, OPENCLAW_STATE_DIR: stateDir },
    async () => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath,
      };
      const scope = { agentId: "main", env, storePath, sessionKey: "agent:main:main" };
      const options = { agentId: "main", env, path: storePath };
      const preparatory = openNodeSqliteDatabase(storePath);
      try {
        await withAgentDatabaseMaintenanceLease({ env }, async () => {
          ensureOpenClawAgentDatabaseSchema(preparatory, options);
        });
      } finally {
        preparatory.close();
      }
      await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
      for (let index = 0; index < 20; index++) {
        addSessionSuggestion(scope, {
          id: `suggestion-${index}`,
          authorId: "alice",
          authorLabel: index === 0 ? "Alice" : undefined,
          text: index === 0 ? "OCSEAL1:literal" : `idea ${index}`,
          createdAt: index,
          expectedSessionId: "session-a",
        });
      }
      addSessionSuggestion(scope, {
        id: "bob",
        authorId: "bob",
        text: "bob's idea",
        createdAt: 20,
        expectedSessionId: "session-a",
      });
      expect(() =>
        addSessionSuggestion(scope, {
          authorId: "alice",
          text: "one too many",
          expectedSessionId: "session-a",
        }),
      ).toThrow("author pending suggestion limit reached");
      const visible = await listSessionSuggestions(scope, { authorId: " alice " });
      expect(visible).toHaveLength(20);
      expect(visible[0]).toMatchObject({
        authorId: "alice",
        authorLabel: "Alice",
        text: "OCSEAL1:literal",
      });
      const database = openOpenClawAgentDatabase(options);
      const row = database.db
        .prepare(
          "SELECT author_id, author_label, text FROM session_suggestions WHERE id = 'suggestion-0'",
        )
        .get();
      expect(row?.author_id).not.toBe("alice");
      expect(row?.author_label).not.toBe("Alice");
      expect(row?.text).not.toBe("OCSEAL1:literal");
      const claim = claimSessionSuggestionDispatch(scope, {
        id: "suggestion-0",
        resolution: "edit",
        expectedSessionId: "session-a",
      });
      expect(claim?.kind).toBe("claimed");
      if (claim?.kind !== "claimed") {
        throw new Error("Suggestion dispatch was not claimed");
      }
      expect(
        finalizeSessionSuggestionClaim(scope, {
          id: "suggestion-0",
          token: claim.token,
          state: "accepted",
          expectedSessionId: "session-a",
        }),
      ).toMatchObject({ authorId: "alice", text: "OCSEAL1:literal", state: "accepted" });
    },
  );
});
