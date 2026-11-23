import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { describe, expect, it } from "vitest";
import type { MemberMemoryBinding, MemberMemoryFiles } from "./member-memory-binding.js";
import { createMemberMemoryTool } from "./member-memory-tools.js";
import { mutateMemberMemory, openMemberMemory, retireMemberMemory } from "./member-memory.js";

function files(): MemberMemoryFiles & { remove(path: string): void } {
  const contents = new Map<string, string>();
  return {
    assertCurrent() {},
    async list(directory) {
      if (!directory) {
        return contents.size ? ["memory"] : [];
      }
      return [...contents.keys()]
        .filter((name) => name.startsWith(`${directory}/`))
        .map((name) => name.slice(directory.length + 1));
    },
    async stat(path) {
      if (path === "memory" && contents.size) {
        return { isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
      }
      const content = contents.get(path);
      return content === undefined
        ? undefined
        : { isDirectory: false, isFile: true, size: Buffer.byteLength(content), mtimeMs: 1 };
    },
    async read(path) {
      return contents.get(path);
    },
    async append(path, text) {
      contents.set(path, `${contents.get(path) ?? ""}${text}`);
    },
    remove(path) {
      contents.delete(path);
    },
  };
}

describe("member memory owner", () => {
  it("shares current notes across chats, invalidates the index on writes, and isolates members", async () => {
    const chunking = { tokens: 400, overlap: 80 };
    const audience = {
      kind: "member-private" as const,
      agentId: "protected",
      workspaceKey: "a-generation",
    };
    const ownedFiles = files();
    const binding: MemberMemoryBinding = {
      audience,
      memberKey: "a",
      workspaceGeneration: "generation",
      files: ownedFiles,
    };
    const otherAudience = { ...audience, workspaceKey: "b-generation" };
    const otherBinding = {
      audience: otherAudience,
      memberKey: "b",
      workspaceGeneration: "generation",
      files: files(),
    };
    const first = await openMemberMemory(binding, audience, () => {}, chunking);
    const second = await openMemberMemory(binding, audience, () => {}, chunking);
    const other = await openMemberMemory(otherBinding, otherAudience, () => {}, chunking);
    try {
      expect(await second.search("lantern", 10)).toEqual([]);
      await first.append("memory/2026-01-01.md", "An imaginary yellow lantern.\n");
      expect((await second.search("lantern", 10))[0]?.snippet).toContain(
        "An imaginary yellow lantern.",
      );
      expect(await other.search("lantern", 10)).toEqual([]);
      expect(await other.list()).toEqual([]);
      expect((await other.read("memory/2026-01-01.md")).status).toBe("not_found");
      expect((await second.read("memory/2026-01-01.md")).text).toContain("yellow lantern");
      await expect(first.append("../other.md", "no")).rejects.toThrow();
      await mutateMemberMemory(
        { memberKey: "a", workspaceGeneration: "generation", assertCurrent: () => {} },
        async () => ownedFiles.remove("memory/2026-01-01.md"),
      );
      expect(await second.search("lantern", 10)).toEqual([]);
      await retireMemberMemory("a");
      await expect(second.search("lantern", 10)).rejects.toThrow("no longer current");
    } finally {
      await Promise.all([first.release(), second.release(), other.release()]);
    }
  });

  it("uses the bound member's notes for tool writes and reads, and rejects another audience", async () => {
    const audience = {
      kind: "member-private" as const,
      agentId: "protected",
      workspaceKey: "a-generation",
    };
    const binding: MemberMemoryBinding = {
      audience,
      memberKey: "tool-member-a",
      workspaceGeneration: "generation",
      files: files(),
    };
    const context = {
      memoryAudience: audience,
      assertMemoryAudienceCurrent: () => {},
      assertInvocationCurrent: () => {},
    };
    const options = {
      config: { agents: { entries: { protected: { memory: { search: { enabled: false } } } } } },
      agentId: "protected",
      memoryAudience: audience,
    };
    const tool = (name: "memory_search" | "memory_get" | "memory_store") => {
      const result = createMemberMemoryTool({ name, binding, context, options });
      if (!result) {
        throw new Error("Member memory tool was not created.");
      }
      return result;
    };
    const stored = await tool("memory_store").execute("store", {
      content: "Likes imaginary blue boats.",
    });
    expect(stored.details).toMatchObject({ stored: true });
    const duplicate = await tool("memory_store").execute("store-again", {
      content: "Likes imaginary blue boats.",
    });
    expect(duplicate.details).toMatchObject({ stored: false });
    await expect(
      tool("memory_store").execute("oversized", { content: "x".repeat(501) }),
    ).rejects.toThrow("limit");
    const search = await tool("memory_search").execute("search", { query: "blue boats" });
    expect(search.details).toMatchObject({
      mode: "keyword",
      results: [expect.objectContaining({ snippet: expect.stringContaining("blue boats") })],
    });
    const result = search.details as { results: Array<{ path: string }> };
    const read = await tool("memory_get").execute("get", { path: result.results[0]!.path });
    expect(read.details).toMatchObject({
      status: "ok",
      text: expect.stringContaining("blue boats"),
    });
    const wrongContext = { ...context, memoryAudience: { ...audience } };
    const wrong = createMemberMemoryTool({
      name: "memory_search",
      binding,
      context: wrongContext,
      options,
    });
    await expect(wrong!.execute("search", { query: "blue boats" })).rejects.toThrow(
      "Member memory authority is unavailable",
    );
  });
});
