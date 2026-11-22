import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../src/infra/kysely-sync.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { operateUserConnector } from "../../src/state/user-connectors.js";
import {
  gmailReadOnlyScope,
  type UserGmailConnector,
} from "../../src/state/user-connectors.types.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

void test("connector ownership stays exact, replacement is conditional, and revocation erases credentials", async (t) => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    t.after(async () => {
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    }),
  );
  const stateDir = dirs.make("openclaw-connector-state-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const profileId = ensureProfileForEmail("owner@example.test", { env }).id;
  const memberId = ensureProfileForEmail("member@example.test", { env }).id;
  let live = true;
  const options = {
    env,
    assertCurrent() {
      if (!live) {
        throw new Error("Owner retired");
      }
    },
  };
  const gmail: UserGmailConnector = {
    version: 1,
    kind: "gmail",
    generation: randomUUID(),
    client: { clientId: "synthetic-client", redirectUri: "https://alcove.example/callback" },
    credential: {
      account: "owner@example.test",
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3600_000,
      scope: gmailReadOnlyScope,
    },
  };
  await operateUserConnector(
    {
      action: "replace",
      profileId,
      kind: "gmail",
      connector: gmail,
      expectedGeneration: null,
    },
    options,
  );
  assert.deepEqual(
    await operateUserConnector({ action: "read", profileId, kind: "gmail" }, options),
    gmail,
  );
  assert.equal(
    await operateUserConnector(
      {
        action: "read",
        profileId: memberId,
        kind: "gmail",
      },
      options,
    ),
    undefined,
  );
  await assert.rejects(
    operateUserConnector(
      {
        action: "replace",
        profileId,
        kind: "gmail",
        expectedGeneration: null,
        connector: { ...gmail, generation: randomUUID() },
      },
      options,
    ),
    /Connector changed/,
  );
  live = false;
  await assert.rejects(
    operateUserConnector(
      {
        action: "delete",
        profileId,
        kind: "gmail",
        expectedGeneration: gmail.generation,
      },
      options,
    ),
    /Owner retired/,
  );
  live = true;
  await operateUserConnector(
    {
      action: "replace",
      profileId,
      kind: "icloud-calendar",
      expectedGeneration: null,
      connector: {
        version: 1,
        kind: "icloud-calendar",
        generation: randomUUID(),
        account: "owner@example.test",
        password: "aaaa-bbbb-cccc-dddd",
      },
    },
    options,
  );
  const db = openOpenClawStateDatabase({ env }).db;
  const stored = () =>
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("secret_store_entries")
        .select(["scope_kind", "scope_id", "name", "value"])
        .where("scope_id", "=", profileId),
    ).rows;
  assert.equal(stored().length, 2);
  assert.ok(stored().every((row) => row.scope_kind === "identity"));
  await updateCanonicalUserProfileAccess({ action: "revoke", profileId }, { env });
  assert.deepEqual(stored(), []);
  await assert.rejects(
    operateUserConnector(
      {
        action: "replace",
        profileId,
        kind: "gmail",
        expectedGeneration: null,
        connector: { ...gmail, generation: randomUUID() },
      },
      options,
    ),
    /profile is unavailable/,
  );
});
