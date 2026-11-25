import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { after, mock, test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import {
  fakeSessionEntryReadModule,
  fakeSessionGenerationModule,
  fakeSessionOwner,
} from "../../src/plugins/memory-audience.test-support.js";
import {
  emitUserProfilesChanged,
  publishUserProfileAliasChange,
} from "../../src/state/user-profile-events.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";

const agentId = "protected";
const profileId = "member-a";
const cfg: OpenClawConfig = {
  agents: { entries: { protected: { memory: { search: { enabled: false } } } } },
};

// The subject runs over a fake session owner and the real memory index. The wrapper records
// every index lease opened and every member retired, so the tests can tell a turn's own
// work from a tool call's. Named imports must still resolve, so the fakes extend the real
// modules; the session mocks go in before anything loads the audience owner.
const realGeneration = await import("../../src/config/sessions/session-delivery-generation.js");
const realEntryRead = await import("../../src/config/sessions/session-entry-read-runtime.js");
const mocked = [
  mock.module("../../src/config/sessions/session-delivery-generation.js", {
    exports: { ...realGeneration, ...fakeSessionGenerationModule },
  }),
  mock.module("../../src/config/sessions/session-entry-read-runtime.js", {
    exports: { ...realEntryRead, ...fakeSessionEntryReadModule },
  }),
];
const core = await import("../../extensions/memory-core/src/member-memory.js");
const spy = { opened: [] as string[], retired: [] as string[] };
mocked.push(
  mock.module("../../extensions/memory-core/src/member-memory.js", {
    exports: {
      ...core,
      openMemberMemory: (...args: Parameters<typeof core.openMemberMemory>) => {
        spy.opened.push(args[0].memberKey);
        return core.openMemberMemory(...args);
      },
      retireMemberMemory: (memberKey: string) => {
        spy.retired.push(memberKey);
        return core.retireMemberMemory(memberKey);
      },
    },
  }),
);
after(() => {
  for (const entry of mocked) {
    entry.restore();
  }
});
const { createProtectedMemberMemory } = await import("./member-memory.js");
const { createStorageAdmission } = await import("./capacity.js");
const { assertMemoryAudienceCurrent } = await import("../../src/plugins/memory-audience.js");
const { createMemberMemoryTool } =
  await import("../../extensions/memory-core/src/member-memory-tools.js");

async function setup(t: TestContext) {
  fakeSessionOwner.reset();
  spy.opened.length = 0;
  spy.retired.length = 0;
  const stateDir = path.resolve(".artifacts", `protected-member-memory-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const encryption = createStorageValueEncryption(randomBytes(32));
  const memberMemory = createProtectedMemberMemory();
  t.after(async () => {
    await memberMemory.close();
    encryption.dispose();
    await rm(stateDir, { recursive: true, force: true });
  });
  const usersRoot = await root(stateDir);
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 16_384,
    limits: { userBytes: 1_000_000, globalBytes: 10_000_000, freeFloorBytes: 1 },
    chats: { capacityEntries: async () => [], transcriptBytes: async () => 0 },
  });
  const admission = await admit(profileId, () => {}, "stored-data");
  const userFiles = await createAuthorizedUserFiles({
    usersRoot,
    profileId,
    assertCurrent: () => {},
    maxBytes: 1_000_000,
    encryption,
  });
  t.after(() => {
    admission.release();
    userFiles.dispose();
  });
  const sessionKey = `agent:${agentId}:main`;
  const sessionId = randomUUID();
  const lifecycleRevision = randomUUID();
  fakeSessionOwner.rows.set(sessionKey, { sessionId, lifecycleRevision, updatedAt: 1 });
  const open = () =>
    memberMemory.open({
      cfg,
      profileId,
      agentId,
      sessionKey,
      sessionId,
      lifecycleRevision,
      storePath: path.join(stateDir, "protected.sqlite"),
      files: admission.files(userFiles),
      assertCurrent: () => {},
    });
  const tool = (
    lease: Awaited<ReturnType<typeof open>>,
    name: "memory_search" | "memory_get" | "memory_store",
  ) => {
    const { audience } = lease.binding;
    const created = createMemberMemoryTool({
      name,
      binding: lease.binding,
      context: {
        memoryAudience: audience,
        assertMemoryAudienceCurrent: () => assertMemoryAudienceCurrent(audience),
        assertInvocationCurrent() {},
      },
      options: { config: cfg, agentId, memoryAudience: audience },
    });
    assert.ok(created, `${name} should be available to a member turn`);
    return created;
  };
  return { memberMemory, open, tool };
}

void test("a turn holds its grant without opening a memory index", async (t) => {
  const { open } = await setup(t);
  const lease = await open();
  assert.equal(lease.binding.audience.kind, "member-private");
  assert.equal(fakeSessionOwner.activeLeases, 1);
  lease.release();
  lease.release();
  assert.equal(fakeSessionOwner.activeLeases, 0);
  assert.deepEqual(spy.opened, []);
});

void test("memory tools open their own index lease for each call", async (t) => {
  const { open, tool } = await setup(t);
  const lease = await open();
  try {
    const stored = await tool(lease, "memory_store").execute("store", {
      content: "Likes imaginary blue boats.",
    });
    assert.deepEqual(stored.details, { stored: true });
    assert.deepEqual(spy.opened, [profileId]);
    const search = tool(lease, "memory_search");
    const query = { query: "blue boats" };
    assert.equal(Value.Check(search.parameters, { ...query, corpus: "all" }), false);
    assert.equal(Value.Check(search.parameters, query), true);
    const found = await search.execute("search", query);
    assert.deepEqual(spy.opened, [profileId, profileId]);
    const { results } = found.details as { results: Array<{ path: string; snippet: string }> };
    assert.match(results[0]?.snippet ?? "", /blue boats/);
    const get = tool(lease, "memory_get");
    const excerpt = { path: results[0]!.path, corpus: "memory" };
    assert.equal(Value.Check(get.parameters, { ...excerpt, corpus: "wiki" }), false);
    assert.equal(Value.Check(get.parameters, excerpt), true);
    const read = await get.execute("get", excerpt);
    assert.deepEqual(spy.opened, [profileId, profileId, profileId]);
    assert.match((read.details as { text: string }).text, /blue boats/);
  } finally {
    lease.release();
  }
  await assert.rejects(
    tool(lease, "memory_search").execute("after-release", { query: "boats" }),
    /released by its owner/,
  );
});

void test("a profile alias change retires memory only while a turn is active", async (t) => {
  const { memberMemory, open } = await setup(t);
  const lease = await open();
  publishUserProfileAliasChange();
  emitUserProfilesChanged();
  lease.release();
  publishUserProfileAliasChange();
  emitUserProfilesChanged();
  // Closing waits for every retirement the two changes started.
  await memberMemory.close();
  assert.deepEqual(spy.retired, [profileId]);
});
