import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { describe, expect, it } from "vitest";
import { EphemeralMemoryIndex, EphemeralMemoryIndexes } from "./manager-ephemeral.js";

describe("member memory index", () => {
  const chunking = { tokens: 400, overlap: 80 };
  it("isolates member indexes and rebuilds on the retained worker", async () => {
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Member authority revoked.");
      }
    };
    const identityA = { memberKey: "member-a", workspaceGeneration: "one" };
    const identityB = { memberKey: "member-b", workspaceGeneration: "one" };
    const accessA = { ...identityA, assertCurrent };
    const accessASecondChat = { ...identityA, assertCurrent: () => {} };
    const accessB = { ...identityB, assertCurrent: () => {} };
    const a = new EphemeralMemoryIndex(identityA);
    const b = new EphemeralMemoryIndex(identityB);
    try {
      await Promise.all([a.open(accessA), b.open(accessB)]);
      await Promise.all([
        a.rebuild(
          [
            {
              path: "memory/2026-01-01.md",
              content: "Likes imaginary yellow lanterns.",
              mtimeMs: 1.25,
              originClass: "agent",
            },
          ],
          accessA,
          chunking,
        ),
        b.rebuild([], accessB, chunking),
      ]);
      expect(
        (await a.search("yellow lanterns", 10, accessASecondChat)).map((row) => row.snippet),
      ).toContain("Likes imaginary yellow lanterns.");
      expect(await b.search("yellow lanterns", 10, accessB)).toEqual([]);
      await expect(a.search("yellow lanterns", 10, accessB)).rejects.toThrow(
        "belongs to another workspace",
      );
      const staleSearch = a.search("yellow lanterns", 10, accessA);
      const rebuild = a.rebuild(
        [
          {
            path: "memory/2026-01-02.md",
            content: "Prefers imaginary blue boats.",
            mtimeMs: 2,
            originClass: "agent",
          },
        ],
        accessA,
        chunking,
      );
      await expect(staleSearch).rejects.toThrow("changed during search");
      await rebuild;
      expect(await a.search("yellow lanterns", 10, accessA)).toEqual([]);
      expect((await a.search("blue boats", 10, accessA)).map((row) => row.snippet)).toContain(
        "Prefers imaginary blue boats.",
      );
      const replacementIdentity = { memberKey: "member-a", workspaceGeneration: "two" };
      const replacementAccess = { ...replacementIdentity, assertCurrent };
      const replacement = new EphemeralMemoryIndex(replacementIdentity);
      try {
        await replacement.open(replacementAccess);
        await replacement.rebuild([], replacementAccess, chunking);
        expect(await replacement.search("blue boats", 10, replacementAccess)).toEqual([]);
        await expect(a.search("blue boats", 10, replacementAccess)).rejects.toThrow(
          "belongs to another workspace",
        );
      } finally {
        await replacement.close();
      }
      active = false;
      await expect(a.search("blue boats", 10, accessA)).rejects.toThrow(
        "Member authority revoked.",
      );
      expect(
        (await a.search("blue boats", 10, accessASecondChat)).map((row) => row.snippet),
      ).toContain("Prefers imaginary blue boats.");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("does not return an old index after a rebuild exceeds capacity", async () => {
    const access = {
      memberKey: "member-a",
      workspaceGeneration: "one",
      assertCurrent: () => {},
    };
    const index = new EphemeralMemoryIndex(access);
    try {
      await index.open(access);
      await index.rebuild([], access, chunking);
      await expect(
        index.rebuild(
          [
            {
              path: "memory/large.md",
              content: "x".repeat(16 * 1024 * 1024 + 1),
              mtimeMs: 1,
              originClass: "agent",
            },
          ],
          access,
          chunking,
        ),
      ).rejects.toThrow("exceeds its rebuild capacity");
      await expect(index.search("x", 10, access)).rejects.toThrow("requires a successful rebuild");
    } finally {
      await index.close();
    }
  });

  it("does not publish a rebuild after member authority is revoked", async () => {
    let active = true;
    const access = {
      memberKey: "member-a",
      workspaceGeneration: "one",
      assertCurrent: () => {
        if (!active) {
          throw new Error("Member authority revoked.");
        }
      },
    };
    const index = new EphemeralMemoryIndex(access);
    try {
      await index.open(access);
      await index.rebuild([], access, chunking);
      const rebuild = index.rebuild(
        [
          {
            path: "memory/note.md",
            content: "An imaginary violet bicycle.",
            mtimeMs: 1,
            originClass: "agent",
          },
        ],
        access,
        chunking,
      );
      active = false;
      await expect(rebuild).rejects.toThrow("Member authority revoked.");
      active = true;
      await expect(index.search("violet bicycle", 10, access)).rejects.toThrow(
        "requires a successful rebuild",
      );
    } finally {
      await index.close();
    }
  });

  it("shares only live member leases and retires the index before replacing it", async () => {
    const indexes = new EphemeralMemoryIndexes(1);
    const first = { memberKey: "member-a", workspaceGeneration: "one", assertCurrent: () => {} };
    const replacement = { ...first, workspaceGeneration: "two" };
    const other = { ...first, memberKey: "member-b" };
    const a = await indexes.acquire(first);
    const anotherChat = await indexes.acquire(first);
    try {
      await a.rebuild(
        [
          {
            path: "memory/note.md",
            content: "An imaginary green sailboat.",
            mtimeMs: 1,
            originClass: "agent",
          },
        ],
        chunking,
      );
      await a.release();
      await expect(a.search("sailboat", 10)).rejects.toThrow("no longer current");
      expect((await anotherChat.search("sailboat", 10)).map((row) => row.snippet)).toContain(
        "An imaginary green sailboat.",
      );
      await expect(indexes.acquire(other)).rejects.toThrow("capacity is unavailable");
      await expect(indexes.acquire(replacement)).rejects.toThrow("workspace changed");
      await indexes.retire(first.memberKey);
      await expect(anotherChat.search("sailboat", 10)).rejects.toThrow();
      const b = await indexes.acquire(other);
      try {
        await b.rebuild([], chunking);
        expect(await b.search("sailboat", 10)).toEqual([]);
      } finally {
        await b.release();
      }
      const next = await indexes.acquire(replacement);
      try {
        await expect(next.search("sailboat", 10)).rejects.toThrow("requires a successful rebuild");
      } finally {
        await next.release();
      }
    } finally {
      await a.release();
      await anotherChat.release();
      await indexes.close();
    }
  });
});
