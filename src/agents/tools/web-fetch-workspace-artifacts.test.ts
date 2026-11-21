import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthorizedUserFiles } from "../../infra/authorized-user-files.js";
import { root } from "../../infra/fs-safe.js";
import { createGroguRuntimeFixture } from "../grogu-runtime.test-support.js";
import { createWebFetchArtifactScope } from "./web-fetch-workspace-artifacts.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
const fixture = () => {
  const f = createGroguRuntimeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
});

describe("workspace-owned web fetch spills", () => {
  it("uses the admitted user root instead of the host workspace and rejects another user's cache", async () => {
    const f = fixture();
    const usersRoot = await root(f.directory);
    const admit = (profileId: string) =>
      createAuthorizedUserFiles({
        usersRoot,
        profileId,
        assertCurrent() {},
        maxBytes: 4096,
      });
    const alice = await admit("alice");
    const bob = await admit("bob");
    const scope = createWebFetchArtifactScope({
      workspaceDir: f.workspace,
      userFileScope: { files: alice, directory: "chats/chat", cacheKey: "alice/chat/grant" },
    });
    const spill = await scope.write("retained public source", { chars: 22, truncated: false });
    expect(path.isAbsolute(spill.path)).toBe(false);
    expect(await alice.readText(spill.path)).toBe("retained public source");
    await expect(bob.read(spill.path)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.workspace, ".openclaw"))).toBe(false);
    expect(await scope.canReuse(spill)).toBe(true);
    expect(
      await createWebFetchArtifactScope({
        userFileScope: { files: bob, directory: "chats/chat", cacheKey: "bob/chat/grant" },
      }).canReuse(spill),
    ).toBe(false);
    await alice.remove("chats/chat");
    expect(await scope.canReuse(spill)).toBe(false);
    expect(await alice.list("chats")).toEqual([]);
  });

  it("creates private readable artifacts, isolates cache ownership, and invalidates changed or removed content", async () => {
    const a = fixture();
    const b = fixture();
    const scope = createWebFetchArtifactScope({ workspaceDir: a.workspace, agentId: "synthetic" });
    const spill = await scope.write("public wrapped fixture", { chars: 22, truncated: false });
    expect(spill.path).toContain(path.join(a.workspace, ".openclaw/artifacts/web-fetch"));
    expect(fs.readFileSync(spill.path, "utf8")).toBe("public wrapped fixture");
    expect(fs.statSync(spill.path).mode & 0o077).toBe(0);
    expect(await scope.canReuse(spill)).toBe(true);
    expect(
      await createWebFetchArtifactScope({
        workspaceDir: b.workspace,
        agentId: "synthetic",
      }).canReuse(spill),
    ).toBe(false);
    fs.writeFileSync(spill.path, "changed");
    expect(await scope.canReuse(spill)).toBe(false);
    fs.rmSync(spill.path);
    expect(await scope.canReuse(spill)).toBe(false);
  });

  it("does not permit read-only, unbound or symlink-escaped artifact writes", async () => {
    const f = fixture();
    await expect(
      createWebFetchArtifactScope({ workspaceDir: f.workspace, readOnly: true }).write("fixture", {
        chars: 7,
        truncated: false,
      }),
    ).rejects.toThrow(/read-only/);
    await expect(
      createWebFetchArtifactScope({}).write("fixture", { chars: 7, truncated: false }),
    ).rejects.toThrow(/trusted workspace/);
    fs.symlinkSync(f.directory, path.join(f.workspace, ".openclaw"));
    await expect(
      createWebFetchArtifactScope({ workspaceDir: f.workspace }).write("fixture", {
        chars: 7,
        truncated: false,
      }),
    ).rejects.toThrow(/could not preserve/);
  });

  it("revalidates authority before asynchronous artifact work may mutate or publish", async () => {
    const f = fixture();
    let current = true;
    const scope = createWebFetchArtifactScope({
      workspaceDir: f.workspace,
      assertInvocationCurrent: () => {
        if (!current) {
          throw new Error("revoked");
        }
      },
    });
    const pending = scope.write("fixture", { chars: 7, truncated: false });
    current = false;
    await expect(pending).rejects.toThrow(/revoked/);
    expect(fs.existsSync(path.join(f.workspace, ".openclaw"))).toBe(false);
  });
});
