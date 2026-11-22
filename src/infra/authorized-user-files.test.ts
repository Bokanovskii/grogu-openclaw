import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createStorageValueEncryption,
  type StorageValueEncryption,
} from "../storage/encryption.js";
import {
  createAuthorizedUserFiles,
  migrateAuthorizedUserFiles,
  verifyAuthorizedUserFiles,
} from "./authorized-user-files.js";
import { root } from "./fs-safe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(options: { encryption?: StorageValueEncryption } = {}) {
  const directory = tempDirs.make("protected-user-files-");
  const usersRoot = await root(directory);
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("grant revoked");
    }
  };
  const admit = (profileId: string, encryption = options.encryption) =>
    createAuthorizedUserFiles({ encryption, usersRoot, profileId, assertCurrent, maxBytes: 1024 });
  const alice = await admit("alice");
  const bob = await admit("bob");
  const userPath = (profileId: string) =>
    path.join(directory, createHash("sha256").update(profileId).digest("hex"));
  return {
    alice,
    bob,
    admit,
    usersRoot,
    userPath,
    revoke: () => {
      active = false;
    },
    restore: () => {
      active = true;
    },
  };
}

describe("authorized user files", () => {
  it("keeps encrypted file contents usable across writes, moves, and readmission", async () => {
    const key = randomBytes(32);
    const encryption = createStorageValueEncryption(key);
    const reloadedEncryption = createStorageValueEncryption(key);
    const wrongEncryption = createStorageValueEncryption(randomBytes(32));
    try {
      const { alice, admit, userPath } = await fixture({ encryption });
      const first = "Private itinerary stored only as ciphertext";
      await alice.create("draft/report.txt", first);
      const stored = await fs.readFile(path.join(userPath("alice"), "draft/report.txt"));
      expect(stored.includes(Buffer.from(first))).toBe(false);
      expect(stored.length).toBeGreaterThan(Buffer.byteLength(first));
      expect(await alice.readText("draft/report.txt")).toBe(first);
      await alice.write("draft/report.txt", "revised");
      await alice.move("draft/report.txt", "draft/final.txt");
      expect(await alice.stat("draft/final.txt")).toMatchObject({ isFile: true, size: 7 });
      expect((await alice.stat("draft/final.txt")).storedSize).toBe(
        (await fs.stat(path.join(userPath("alice"), "draft/final.txt"))).size,
      );
      encryption.dispose();
      const reloaded = await admit("alice", reloadedEncryption);
      expect(await reloaded.readText("draft/final.txt")).toBe("revised");
      await expect(
        (await admit("alice", wrongEncryption)).read("draft/final.txt"),
      ).rejects.toThrow();
      await expect(alice.write("closed.txt", "not saved")).rejects.toThrow("encryption is closed");
      await reloaded.create("draft/empty.txt", "");
      expect(await reloaded.read("draft/empty.txt")).toEqual(Buffer.alloc(0));
      await reloaded.remove("draft");
      expect(await reloaded.list()).toEqual([]);
    } finally {
      encryption.dispose();
      reloadedEncryption.dispose();
      wrongEncryption.dispose();
    }
  });

  it("resumes staged user-file migration and refuses unauthenticated copies", async () => {
    const encryption = createStorageValueEncryption(randomBytes(32));
    const wrongEncryption = createStorageValueEncryption(randomBytes(32));
    try {
      const { alice, usersRoot, userPath } = await fixture({ encryption });
      const profileHash = createHash("sha256").update("alice").digest("hex");
      const pendingPath = "draft/report.txt";
      const pendingPlaintext = Buffer.from("staged before an interrupted migration");
      const ordinaryPath = "legacy.txt";
      const ordinaryPlaintext = Buffer.from("plaintext awaiting migration");
      const migrationDirectory = ".openclaw-protected-storage-migration";
      const migrationPath = path.join(userPath("alice"), migrationDirectory);
      const stagedPath = path.join(migrationPath, pendingPath);
      await fs.mkdir(path.dirname(path.join(userPath("alice"), pendingPath)), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(userPath("alice"), ordinaryPath), ordinaryPlaintext);
      await fs.writeFile(path.join(userPath("alice"), pendingPath), pendingPlaintext);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(migrationPath, "owner"), "openclaw-protected-user-files-v1\n", {
        mode: 0o600,
      });
      const stagedCiphertext = encryption.encrypt(
        pendingPlaintext,
        `openclaw:user-file:${profileHash}`,
      );
      await fs.writeFile(stagedPath, stagedCiphertext, { mode: 0o600 });

      const options = { usersRoot, assertCurrent: () => undefined, maxBytes: 1024 };
      await expect(
        verifyAuthorizedUserFiles({ ...options, encryption: wrongEncryption }),
      ).rejects.toThrow("could not be authenticated");
      expect(await fs.readFile(path.join(userPath("alice"), ordinaryPath))).toEqual(
        ordinaryPlaintext,
      );
      expect(await fs.readFile(path.join(userPath("alice"), pendingPath))).toEqual(
        pendingPlaintext,
      );
      expect(await fs.readFile(stagedPath)).toEqual(stagedCiphertext);

      await verifyAuthorizedUserFiles({ ...options, encryption });
      await migrateAuthorizedUserFiles({ ...options, encryption });

      expect(await alice.readText(ordinaryPath)).toBe(ordinaryPlaintext.toString("utf8"));
      expect(await alice.readText(pendingPath)).toBe(pendingPlaintext.toString("utf8"));
      expect(
        (await fs.readFile(path.join(userPath("alice"), ordinaryPath))).includes(ordinaryPlaintext),
      ).toBe(false);
      await expect(fs.stat(migrationPath)).rejects.toThrow();
    } finally {
      encryption.dispose();
      wrongEncryption.dispose();
    }
  });

  it("resumes cleanup after interrupted removal leaves only empty staging directories", async () => {
    const encryption = createStorageValueEncryption(randomBytes(32));
    try {
      const { alice, usersRoot, userPath } = await fixture({ encryption });
      const migrationDirectory = ".openclaw-protected-storage-migration";
      const migrationPath = path.join(userPath("alice"), migrationDirectory);
      const plaintext = "already-promoted encrypted file";
      await alice.create("complete.txt", plaintext);
      await fs.mkdir(path.join(migrationPath, "partial", "nested"), {
        recursive: true,
        mode: 0o700,
      });

      const options = { usersRoot, assertCurrent: () => undefined, maxBytes: 1024, encryption };
      await verifyAuthorizedUserFiles(options);
      await migrateAuthorizedUserFiles(options);

      expect(await alice.readText("complete.txt")).toBe(plaintext);
      await expect(fs.stat(migrationPath)).rejects.toThrow();
    } finally {
      encryption.dispose();
    }
  });

  it("rejects copied or corrupt ciphertext and enforces the plaintext byte limit", async () => {
    const encryption = createStorageValueEncryption(randomBytes(32));
    try {
      const { alice, bob, userPath, revoke } = await fixture({ encryption });
      const data = Buffer.alloc(1024, 0x61);
      await alice.create("private.bin", data);
      expect(await alice.read("private.bin")).toEqual(data);
      await expect(alice.write("oversized.bin", Buffer.alloc(1025))).rejects.toMatchObject({
        code: "too-large",
      });
      const filename = path.join(userPath("alice"), "private.bin");
      const stored = await fs.readFile(filename);
      expect(alice.storedSize(data.length)).toBe(stored.length);
      await fs.writeFile(path.join(userPath("bob"), "copied.bin"), stored);
      await expect(bob.read("copied.bin")).rejects.toThrow();
      const corrupted = Buffer.from(stored);
      corrupted.writeUInt8(corrupted.readUInt8(corrupted.length - 1) ^ 1, corrupted.length - 1);
      await fs.writeFile(filename, corrupted);
      await expect(alice.read("private.bin")).rejects.toThrow();
      await fs.writeFile(filename, data);
      await expect(alice.read("private.bin")).rejects.toThrow("Invalid encrypted storage value");
      await fs.writeFile(filename, stored);
      const pending = alice.read("private.bin");
      revoke();
      await expect(pending).rejects.toThrow("grant revoked");
    } finally {
      encryption.dispose();
    }
  });

  it("keeps the complete file lifecycle under the canonical user across readmission", async () => {
    const { alice, bob, admit } = await fixture();
    await alice.create("draft/report.txt", "first");
    await bob.create("draft/report.txt", "other user");
    await alice.write("draft/report.txt", "revised");
    await alice.move("draft/report.txt", "draft/final.txt");
    expect(await alice.list("draft")).toEqual(["final.txt"]);
    expect(await alice.stat("draft/final.txt")).toMatchObject({ isFile: true, size: 7 });
    expect(await (await admit("alice")).readText("draft/final.txt")).toBe("revised");
    expect(await bob.readText("draft/report.txt")).toBe("other user");
    await expect(bob.read("draft/final.txt")).rejects.toThrow();
    await alice.remove("draft");
    expect(await alice.list()).toEqual([]);
    expect(await bob.readText("draft/report.txt")).toBe("other user");
  });

  it.each([
    "../bob/private",
    "a/../secret",
    "/etc/passwd",
    "a\\..\\secret",
    "%2e%2e/x",
    "a//b",
    ".openclaw-protected-storage-migration/owner",
  ])("rejects an untrusted path on every operation: %s", async (name) => {
    const { alice } = await fixture();
    for (const operation of [
      () => alice.read(name),
      () => alice.readText(name),
      () => alice.list(name),
      () => alice.stat(name),
      () => alice.mkdir(name),
      () => alice.create(name, "bad"),
      () => alice.write(name, "bad"),
      () => alice.move(name, "destination"),
      () => alice.move("source", name),
      () => alice.remove(name),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it.skipIf(process.platform === "win32")(
    "denies links and a replaced root without touching another user",
    async () => {
      const { alice, bob, userPath } = await fixture();
      await bob.create("secret.txt", "private");
      await fs.symlink(
        path.join(userPath("bob"), "secret.txt"),
        path.join(userPath("alice"), "link"),
      );
      await fs.link(
        path.join(userPath("bob"), "secret.txt"),
        path.join(userPath("alice"), "hardlink"),
      );
      await expect(alice.read("link")).rejects.toThrow();
      await expect(alice.read("hardlink")).rejects.toMatchObject({ code: "hardlink" });
      await expect(alice.stat("link")).rejects.toThrow();
      await expect(alice.stat("hardlink")).rejects.toThrow();
      await expect(alice.write("link", "changed")).rejects.toThrow();
      await fs.unlink(path.join(userPath("alice"), "hardlink"));
      await fs.rename(userPath("alice"), `${userPath("alice")}-retired`);
      await fs.symlink(userPath("bob"), userPath("alice"), "dir");
      await expect(alice.create("replacement.txt", "bad")).rejects.toThrow();
      await expect(alice.read("secret.txt")).rejects.toThrow();
      expect(await bob.readText("secret.txt")).toBe("private");
      await expect(bob.read("replacement.txt")).rejects.toThrow();
    },
  );

  it("does not deliver an awaited read after revocation and cannot revive its grant", async () => {
    const { alice, revoke, restore } = await fixture();
    await alice.create("private.txt", "secret");
    const reading = alice.read("private.txt");
    revoke();
    await expect(reading).rejects.toThrow("grant revoked");
    restore();
    await expect(alice.read("private.txt")).rejects.toThrow("grant revoked");
    await expect(alice.write("private.txt", "bad")).rejects.toThrow("grant revoked");
  });

  it("bounds reads and writes and retires a disposed request", async () => {
    const { alice, userPath } = await fixture();
    await expect(alice.write("too-big.txt", "x".repeat(1025))).rejects.toMatchObject({
      code: "too-large",
    });
    await fs.writeFile(path.join(userPath("alice"), "imported.txt"), "x".repeat(1025));
    await expect(alice.read("imported.txt")).rejects.toMatchObject({ code: "too-large" });
    alice.dispose();
    await expect(alice.list()).rejects.toThrow("authority is closed");
  });
});
