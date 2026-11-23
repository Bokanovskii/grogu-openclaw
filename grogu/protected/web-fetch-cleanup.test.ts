import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProtectedChatSummary } from "@openclaw/gateway-protocol/protected";
import {
  authorizedUserFilesDirectory,
  createAuthorizedUserFiles,
  type AuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { loadStorageValueEncryptionFromFile } from "../../src/storage/sqlite-encryption.js";
import { listProtectedArtifacts } from "./artifacts.js";
import { measureProtectedStorage, storageEntryOverheadBytes } from "./capacity.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const maxFileBytes = 2 * 1024 * 1024;
const uuidV1 = "123e4567-e89b-12d3-a456-426614174000";

void test("cleanup removes only legacy web_fetch spills for every member", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-web-fetch-cleanup-"));
  const stateDir = path.join(home, "state");
  const usersDir = path.join(stateDir, "users");
  const keyPath = path.join(home, "secrets", "storage-key");
  const configPath = path.join(home, "config", "openclaw.json");
  await Promise.all([
    mkdir(usersDir, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyPath,
  };
  const encryption = loadStorageValueEncryptionFromFile(keyPath, stateDir);
  const usersRoot = await root(usersDir);
  const filesByMember: AuthorizedUserFiles[] = [];
  t.after(async () => {
    filesByMember.forEach((files) => files.dispose());
    encryption.dispose();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(home, { recursive: true, force: true });
  });
  const memberOne = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "synthetic-member-one",
    assertCurrent: () => undefined,
    maxBytes: maxFileBytes,
    encryption,
  });
  const memberTwo = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "synthetic-member-two",
    assertCurrent: () => undefined,
    maxBytes: maxFileBytes,
    encryption,
  });
  filesByMember.push(memberOne, memberTwo);

  const chatOne = randomUUID();
  const chatTwo = randomUUID();
  const spillOne = `web-fetch-${randomUUID()}.log`;
  const spillTwo = `web-fetch-${randomUUID()}.log`;
  const spillOneContent = "synthetic member one spill";
  const spillTwoContent = "synthetic member two spill";
  const spillTwoBackup = `web-fetch-${randomUUID()}.log.bak`;
  const elsewhereFile = `elsewhere/web-fetch/web-fetch-${randomUUID()}.log`;
  const otherChatFile = `chats/${randomUUID()}/web-fetch-${randomUUID()}.log`;
  const webFetchOne = `chats/${chatOne}/web-fetch`;
  const webFetchTwo = `chats/${chatTwo}/web-fetch`;
  await memberOne.create(`${webFetchOne}/${spillOne}`, spillOneContent);
  await memberTwo.create(`${webFetchTwo}/${spillTwo}`, spillTwoContent);
  await memberTwo.create(`${webFetchTwo}/other.log`, "keep other log");
  await memberTwo.create(`${webFetchTwo}/web-fetch-not-a-uuid.log`, "keep non-UUID name");
  await memberTwo.create(`${webFetchTwo}/web-fetch-${uuidV1}.log`, "keep non-v4 UUID");
  await memberTwo.create(`${webFetchTwo}/${spillTwoBackup}`, "keep suffix");
  await memberOne.create(elsewhereFile, "keep elsewhere");
  await memberTwo.create(otherChatFile, "keep elsewhere");

  const chats: Parameters<typeof measureProtectedStorage>[0]["chats"] = {
    async capacityEntries() {
      return [
        {
          id: chatOne,
          profileId: "synthetic-member-one",
          sessionKey: `agent:protected:family:synthetic-member-one:${chatOne}`,
          title: "Member one chat",
          updatedAt: 1,
          transient: false,
        },
        {
          id: chatTwo,
          profileId: "synthetic-member-two",
          sessionKey: `agent:protected:family:synthetic-member-two:${chatTwo}`,
          title: "Member two chat",
          updatedAt: 2,
          transient: false,
        },
      ];
    },
    async transcriptBytes() {
      return 0;
    },
  };
  const measure = () =>
    measureProtectedStorage(
      { usersRoot, encryption, chats, maxFileBytes },
      "synthetic-member-one",
      () => undefined,
      true,
    );
  const before = await measure();
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", ...args],
      { cwd: repoRoot, env, encoding: "utf8" },
    );

  const dryRun = run(["cleanup-web-fetch-spills", "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunActions = dryRun.stdout.trim().split("\n").toSorted();
  assert.deepEqual(
    dryRunActions,
    [
      `directory users/${authorizedUserFilesDirectory("synthetic-member-one")}/${webFetchOne}`,
      `file users/${authorizedUserFilesDirectory("synthetic-member-one")}/${webFetchOne}/${spillOne}`,
      `file users/${authorizedUserFilesDirectory("synthetic-member-two")}/${webFetchTwo}/${spillTwo}`,
    ].toSorted(),
  );
  assert.equal((await memberOne.stat(`${webFetchOne}/${spillOne}`)).isFile, true);
  assert.equal((await memberTwo.stat(`${webFetchTwo}/${spillTwo}`)).isFile, true);
  assert.deepEqual(await measure(), before);

  const listener = await acquireProtectedStateOwner(stateDir);
  assert.ok(listener);
  try {
    const refused = run(["cleanup-web-fetch-spills"]);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stderr, "Stop the listener before cleaning web_fetch spill files.\n");
    assert.equal((await memberOne.stat(`${webFetchOne}/${spillOne}`)).isFile, true);
  } finally {
    listener.release();
  }

  const cleaned = run(["cleanup-web-fetch-spills"]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(cleaned.stdout, "Removed 2 web_fetch spill files and 1 empty directories.\n");
  await assert.rejects(memberOne.list(webFetchOne), { code: "not-found" });
  assert.deepEqual(
    (await memberTwo.list(webFetchTwo)).toSorted(),
    ["other.log", "web-fetch-not-a-uuid.log", `web-fetch-${uuidV1}.log`, spillTwoBackup].toSorted(),
  );
  assert.equal(await memberOne.readText(elsewhereFile), "keep elsewhere");
  assert.equal(await memberTwo.readText(otherChatFile), "keep elsewhere");
  const after = await measure();
  const memberOneFreed =
    memberOne.storedSize(Buffer.byteLength(spillOneContent)) + 2 * storageEntryOverheadBytes;
  const memberTwoFreed =
    memberTwo.storedSize(Buffer.byteLength(spillTwoContent)) + storageEntryOverheadBytes;
  assert.equal(before.globalBytes - after.globalBytes, memberOneFreed + memberTwoFreed);
  assert.equal(before.personalBytes - after.personalBytes, memberOneFreed);

  const remainingArtifacts = await listProtectedArtifacts({
    files: memberTwo,
    chats: [
      {
        id: chatTwo,
        title: "Member two chat",
        version: "2",
        updatedAt: 2,
      } satisfies ProtectedChatSummary,
    ],
    cursor: null,
    maxFileBytes,
  });
  assert.equal(
    remainingArtifacts.artifacts.some((artifact) => artifact.id.endsWith(spillTwo)),
    false,
  );
  assert.equal(
    remainingArtifacts.artifacts.every((artifact) => artifact.chatTitle === "Member two chat"),
    true,
  );
  assert.ok(
    remainingArtifacts.artifacts.some(
      (artifact) => artifact.kind === "file" && artifact.name === "other.log",
    ),
  );

  const repeated = run(["cleanup-web-fetch-spills"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, "Removed 0 web_fetch spill files and 0 empty directories.\n");
});
