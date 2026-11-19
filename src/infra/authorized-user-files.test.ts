import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAuthorizedUserFiles } from "./authorized-user-files.js";
import { root } from "./fs-safe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const directory = tempDirs.make("protected-user-files-");
  const usersRoot = await root(directory);
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("grant revoked");
    }
  };
  const admit = (profileId: string) =>
    createAuthorizedUserFiles({ usersRoot, profileId, assertCurrent, maxBytes: 1024 });
  const alice = await admit("alice");
  const bob = await admit("bob");
  const userPath = (profileId: string) =>
    path.join(directory, createHash("sha256").update(profileId).digest("hex"));
  return {
    alice,
    bob,
    admit,
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

  it.each(["../bob/private", "a/../secret", "/etc/passwd", "a\\..\\secret", "%2e%2e/x", "a//b"])(
    "rejects an untrusted path on every operation: %s",
    async (name) => {
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
    },
  );

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
