import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { createStorageAdmission } from "./capacity.js";

void test("Family capacity charges encrypted bytes for existing files and new writes", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-capacity-profile";
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId,
    encryption,
    maxBytes: 1024,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const data = Buffer.alloc(256, 0x61);
  await files.create("probe.bin", data);
  const directory = path.join(stateDir, createHash("sha256").update(profileId).digest("hex"));
  const physicalBytes = (await stat(path.join(directory, "probe.bin"))).size;
  assert.ok(physicalBytes > data.length);
  let hasChat = false;
  const admission = (userBytes: number) =>
    createStorageAdmission({
      stateDir,
      usersRoot,
      encryption,
      maxFileBytes: 1024,
      limits: { userBytes, globalBytes: userBytes, freeFloorBytes: 1 },
      chats: {
        async capacityEntries() {
          return hasChat ? [{ profileId, id: "one", sessionKey: "synthetic" }] : [];
        },
        async transcriptBytes() {
          return 0;
        },
      },
    })(profileId, () => {}, "turn");
  const tooSmall = await admission(16_384 + 4096 + data.length);
  try {
    await assert.rejects(async () => tooSmall.files(files).create("chats/one/file.bin", data), {
      code: "quota_exceeded",
      message: "Storage limit reached. Delete a chat to free space.",
    });
    await assert.rejects(files.stat("chats/one/file.bin"), { code: "not-found" });
  } finally {
    tooSmall.release();
  }
  const exactWrite = await admission(16_384 + 4096 + physicalBytes);
  try {
    await exactWrite.files(files).create("chats/one/file.bin", data);
  } finally {
    exactWrite.release();
  }
  hasChat = true;
  const existingAndTurn = 32_768 + 4096 + 4096 + physicalBytes + 16_384;
  await assert.rejects(admission(existingAndTurn - 1), { code: "quota_exceeded" });
  const exactExisting = await admission(existingAndTurn);
  exactExisting.release();
});
