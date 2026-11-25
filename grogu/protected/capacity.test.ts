import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ProtectedAutomationDraft } from "../../packages/gateway-protocol/src/protected.js";
import { loadSubagentRunsForChildSessionFromSqlite } from "../../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import { createSessionEntryWithTranscript } from "../../src/config/sessions/session-accessor.js";
import { hasTranscriptArchiveInDatabase } from "../../src/config/sessions/session-accessor.sqlite-archive-read.js";
import { readSessionEntryReadOnlyInWorker } from "../../src/config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import { withOpenClawStateDatabaseReadOnly } from "../../src/state/openclaw-state-db-readonly.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { createProtectedAgentCatalog } from "./agents.js";
import {
  createStorageAdmission,
  measureProtectedStorage,
  storageEntryOverheadBytes,
} from "./capacity.js";
import { createProtectedChats } from "./chats.js";
import { createMemberMemoryFiles } from "./memory-files.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

void test("retained member memory counts against global and owner storage without chats", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    assertCurrent: () => {},
    maxBytes: 16_384,
    encryption,
  });
  const ciphertextBytes = files.storedSize(1_000);
  try {
    await files.write("member-memory/memory/note.md", "x".repeat(1_000));
  } finally {
    files.dispose();
  }
  const options = {
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 16_384,
    limits: { userBytes: 20_000, globalBytes: 100_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  };
  const firstUsage = await measureProtectedStorage(options, "first", () => {}, true);
  const secondUsage = await measureProtectedStorage(options, "second", () => {}, true);
  const secondOnly = await measureProtectedStorage(options, "second", () => {}, false);
  assert.equal(firstUsage.personalBytes, ciphertextBytes + 3 * storageEntryOverheadBytes);
  assert.equal(firstUsage.globalBytes, firstUsage.personalBytes);
  assert.equal(secondUsage.globalBytes, firstUsage.globalBytes);
  assert.equal(secondUsage.personalBytes, 0);
  assert.equal(secondOnly.globalBytes, 0);

  const admit = createStorageAdmission(options);
  const second = await admit("second", () => {}, "stored-data");
  const first = await admit("first", () => {}, "stored-data");
  const owned = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    assertCurrent: () => {},
    maxBytes: 16_384,
    encryption,
  });
  const deletion = await admit("first", () => {}, "delete");
  try {
    assert.throws(() => first.charge(8_000), { code: "quota_exceeded" });
    assert.equal(
      await deletion
        .files(owned)
        .removeFileIfBytesMatch(
          "member-memory/memory/note.md",
          Buffer.from("x".repeat(1_000)),
          async () => {},
        ),
      true,
    );
    first.charge(8_000);
    second.charge(8_000);
  } finally {
    deletion.release();
    owned.dispose();
    first.release();
    second.release();
  }
});

void test("concurrent encrypted memory updates preserve both writes and enforce file limits", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    assertCurrent: () => {},
    maxBytes: 1024,
    encryption,
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { userBytes: 50_000, globalBytes: 100_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "stored-data"),
    admit("first", () => {}, "stored-data"),
  ]);
  const otherFiles = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "second",
    assertCurrent: () => {},
    maxBytes: 1024,
    encryption,
  });
  t.after(() => otherFiles.dispose());
  const other = await admit("second", () => {}, "stored-data");
  const name = "member-memory/memory/note.md";
  try {
    const firstMemory = createMemberMemoryFiles(first.files(files));
    const secondMemory = createMemberMemoryFiles(second.files(files));
    const otherMemory = createMemberMemoryFiles(other.files(otherFiles));
    await Promise.all([
      firstMemory.append("memory/note.md", "first\n"),
      secondMemory.append("memory/note.md", "second\n"),
    ]);
    assert.deepEqual(await firstMemory.list("memory"), ["note.md"]);
    assert.equal(await secondMemory.read("memory/note.md"), "first\nsecond\n");
    assert.deepEqual(await otherMemory.list("memory"), []);
    assert.equal(await otherMemory.read("memory/note.md"), undefined);
    await assert.rejects(firstMemory.read("../chats/private.md"), { code: "invalid-path" });
    await assert.rejects(firstMemory.append("../chats/private.md", "x"), {
      code: "invalid-path",
    });
    assert.equal(await files.readText(name), "first\nsecond\n");
    const stored = await readFile(
      path.join(stateDir, createHash("sha256").update("first").digest("hex"), name),
    );
    assert.equal(stored.includes(Buffer.from("first\nsecond\n")), false);
    await assert.rejects(firstMemory.append("memory/note.md", "x".repeat(1025)), {
      code: "file_too_large",
    });
    assert.equal(await files.readText(name), "first\nsecond\n");
    const removable = first.files(files);
    assert.equal(
      await removable.removeFileIfBytesMatch(name, Buffer.from("first\n"), async () => {}),
      false,
    );
    assert.equal(
      await removable.removeFileIfBytesMatch(name, Buffer.from("first\nsecond\n"), async () => {}),
      true,
    );
    assert.equal(await secondMemory.read("memory/note.md"), undefined);
    first.release();
    await assert.rejects(firstMemory.read("memory/note.md"), /Storage admission is closed/);
    await assert.rejects(firstMemory.append("memory/note.md", "x"), /Storage admission is closed/);
  } finally {
    first.release();
    second.release();
    other.release();
  }
});

void test("concurrent members share storage quota without blocking each other", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 49_152, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    first.charge(16_384);
    second.charge(16_384);
    await assert.rejects(
      admit("third", () => {}, "create"),
      { code: "quota_exceeded" },
    );
    assert.throws(() => first.charge(1), { code: "quota_exceeded" });
  } finally {
    first.release();
    second.release();
  }
  const next = await admit("third", () => {}, "create");
  next.release();
  const [sameFirst, sameSecond] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("first", () => {}, "turn"),
  ]);
  try {
    sameFirst.charge(16_384);
    assert.throws(() => sameSecond.charge(1), { code: "quota_exceeded" });
  } finally {
    sameFirst.release();
    sameSecond.release();
  }
});

void test("storage admission reports how long it queued and measured", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const admit = createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    maxFileBytes: 1024,
    limits: { userBytes: 49_152, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    assert.ok(first.scanMs > 0);
    // The second admission waited for the first to finish measuring, then reused its ledger.
    assert.ok(second.queueMs >= first.scanMs);
    assert.equal(second.scanMs, 0);
  } finally {
    first.release();
    second.release();
  }
});

void test("idle measurement removes the scan from a later turn but never bypasses disk or dirty data", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-idle-capacity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const profiles = ["first", "second"];
  const entries = Array.from({ length: 16 }, (_, index) => ({
    profileId: profiles[index % 2]!,
    id: randomUUID(),
    sessionKey: `key-${index}`,
    updatedAt: index,
    transient: false,
  }));
  const limits = { userBytes: 16 * 1024 * 1024, globalBytes: 32 * 1024 * 1024, freeFloorBytes: 1 };
  let background = Promise.resolve();
  let bytes = 1024;
  let reads = 0;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    maxFileBytes: 1024,
    limits,
    chats: {
      capacityEntries: async () => entries,
      transcriptBytes: async () => {
        reads++;
        return bytes;
      },
    },
    idleMeasurement: {
      assertCurrent: () => {},
      track: (work) => {
        background = work;
      },
    },
  });
  const turn = () => admit("first", () => {}, "turn");
  const first = await turn();
  assert.ok(first.scanMs > 0);
  first.release();
  await background;
  assert.equal(reads, 2 * entries.length);
  const next = await turn();
  assert.equal(next.scanMs, 0);
  assert.equal(reads, 2 * entries.length);
  t.diagnostic(
    `16-chat fixture: cold scan ${first.scanMs.toFixed(2)} ms; prepared scan ${next.scanMs.toFixed(2)} ms; prepared queue ${next.queueMs.toFixed(2)} ms`,
  );
  next.release();
  await background;
  limits.freeFloorBytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(turn(), { code: "storage_full" });
  limits.freeFloorBytes = 1;
  const finish = admit.beginUntrackedMutation();
  bytes = limits.userBytes;
  finish();
  await assert.rejects(turn(), { code: "quota_exceeded" });
  await background;
});

void test("a mutation during idle measurement cannot publish the old shared quota", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-idle-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let background = Promise.resolve();
  let reads = 0;
  let storedBytes = 0;
  let mutated = false;
  let hostChecks = 0;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    maxFileBytes: 1024,
    limits: { globalBytes: 16 * 1024 * 1024, userBytes: 16 * 1024 * 1024, freeFloorBytes: 1 },
    chats: { capacityEntries: async () => [], transcriptBytes: async () => 0 },
    async storedDataUsage() {
      if (++reads === 2) {
        setImmediate(() => {
          const finish = admit.beginUntrackedMutation();
          storedBytes = 16 * 1024 * 1024;
          mutated = true;
          finish();
        });
      }
      return Array.from({ length: 2048 }, (_, i) => ({
        profileId: "other",
        id: `entry-${i}`,
        bytes: i === 0 ? storedBytes : 0,
      }));
    },
    idleMeasurement: {
      assertCurrent: () => {
        hostChecks++;
      },
      track: (work) => {
        background = work;
      },
    },
  });
  (await admit("member", () => {}, "turn")).release();
  await background;
  assert.ok(mutated, "idle receipt processing yields to waiting listener work");
  assert.ok(hostChecks < 100, "idle measurement must not open the host lock per receipt");
  await assert.rejects(
    admit("member", () => {}, "create"),
    { code: "quota_exceeded" },
  );
  await background;
});

void test("per-member limits override the default and the owner is exempt", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const admit = createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    maxFileBytes: 1024,
    limits: { userBytes: 32_768, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const raised = await admit("member", () => {}, "turn", 49_152);
  const owner = await admit("owner", () => {}, "turn", null);
  try {
    raised.charge(32_768);
    assert.throws(() => raised.charge(1), { code: "quota_exceeded" });
    // The owner passes both the member default and the shared budget.
    owner.charge(8_192);
    owner.charge(8_192);
    await assert.rejects(
      admit("other", () => {}, "turn", 32_768),
      (error: Error) => {
        assert.equal((error as { code?: string }).code, "quota_exceeded");
        assert.match(error.message, /shared storage/u);
        return true;
      },
    );
  } finally {
    raised.release();
    owner.release();
  }
});

void test("deleted chats free quota while another member is still running", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  let present = true;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 65_536, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return present
          ? [
              {
                profileId: "first",
                id: "one",
                sessionKey: "synthetic",
                updatedAt: 1,
                transient: false,
              },
            ]
          : [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  try {
    present = false;
    admit.deletedChat("first", "one");
    first.charge(20_000);
  } finally {
    first.release();
  }
  const second = await admit("second", () => {}, "create");
  second.release();
});

void test("deleting a newly created chat frees its reservation during another turn", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 70_000, globalBytes: 70_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  const created = await admit("second", () => {}, "create");
  created.recordCreatedChat("new", "new-session");
  created.release();
  try {
    admit.deletedChat("second", "new");
    first.charge(25_000);
  } finally {
    first.release();
  }
});

void test("deletion during the initial scan does not leave a stale charge", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 32_768, globalBytes: 32_768, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          { profileId: "first", id: "one", sessionKey: "one", updatedAt: 1, transient: false },
        ];
      },
      async transcriptBytes() {
        started.resolve();
        await finish.promise;
        return 0;
      },
    },
  });
  const admission = admit("second", () => {}, "create");
  await started.promise;
  admit.deletedChat("first", "one");
  finish.resolve();
  (await admission).release();
});

void test("quota rescans do not double-charge a running turn's persisted transcript", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  let present = true;
  let transcriptBytes = 0;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 95_000, globalBytes: 95_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          { profileId: "first", id: "one", sessionKey: "one", updatedAt: 1, transient: false },
          ...(present
            ? [
                {
                  profileId: "second",
                  id: "two",
                  sessionKey: "two",
                  updatedAt: 1,
                  transient: false,
                },
              ]
            : []),
        ];
      },
      async transcriptBytes(id) {
        return id === "one" ? transcriptBytes : 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  try {
    first.charge(10_000);
    transcriptBytes = 10_000;
    present = false;
    const second = await admit("second", () => {}, "create");
    second.release();
  } finally {
    first.release();
  }
});

void test("quota rescan restarts when the last running turn finishes during the scan", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  let scanStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    scanStarted = resolve;
  });
  let finishScan!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishScan = resolve;
  });
  let scans = 0;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 32_768, globalBytes: 32_768, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        if (++scans === 2) {
          scanStarted();
          await blocked;
        }
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  const next = admit("second", () => {}, "create");
  await started;
  first.release();
  finishScan();
  (await next).release();
});

void test("failed file writes do not consume another member's quota", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 65_536, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  try {
    await assert.rejects(first.files(files).create("../invalid", "x".repeat(20_000)), {
      code: "invalid-path",
    });
    const second = await admit("second", () => {}, "create");
    second.release();
  } finally {
    first.release();
  }
});

void test("failed file writes do not block an already-admitted member", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 65_536, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    await assert.rejects(first.files(files).create("../invalid", "x".repeat(20_000)), {
      code: "invalid-path",
    });
    second.charge(10_000);
  } finally {
    first.release();
    second.release();
  }
});

void test("file replacements do not consume another member's quota twice", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const data = "x".repeat(20_000);
  await files.create("chats/one/file.bin", data);
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 130_000, globalBytes: 130_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          {
            profileId: "first",
            id: "one",
            sessionKey: "synthetic",
            updatedAt: 1,
            transient: false,
          },
        ];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    await first.files(files).write("chats/one/file.bin", data);
    second.charge(15_000);
  } finally {
    first.release();
    second.release();
  }
});

void test("nested file creation reserves the directories counted by storage scans", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 1024,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 1024,
    limits: { userBytes: 80_000, globalBytes: 80_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          { profileId: "first", id: "one", sessionKey: "one", updatedAt: 1, transient: false },
        ];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    await assert.rejects(first.files(files).create("chats/one/a/b/file", ""), {
      code: "quota_exceeded",
    });
  } finally {
    first.release();
    second.release();
  }
});

void test("a quota rescan during a replacement does not block an admitted turn", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const data = "x".repeat(20_000);
  await files.create("chats/one/file.bin", data);
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 130_000, globalBytes: 130_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          {
            profileId: "first",
            id: "one",
            sessionKey: "synthetic",
            updatedAt: 1,
            transient: false,
          },
        ];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  let startWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    startWrite = resolve;
  });
  let finishWrite!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const write = first
    .files({
      ...files,
      async write(name, contents) {
        startWrite();
        await blocked;
        await files.write(name, contents);
      },
    })
    .write("chats/one/file.bin", data);
  try {
    await writing;
    await assert.rejects(
      admit("third", () => {}, "create"),
      { code: "quota_exceeded" },
    );
    finishWrite();
    await write;
    second.charge(15_000);
  } finally {
    finishWrite();
    await write;
    first.release();
    second.release();
  }
});

void test("a failed file operation still charges data committed before the error", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 110_000, globalBytes: 110_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [
          {
            profileId: "first",
            id: "one",
            sessionKey: "synthetic",
            updatedAt: 1,
            transient: false,
          },
        ];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const [first, second] = await Promise.all([
    admit("first", () => {}, "turn"),
    admit("second", () => {}, "turn"),
  ]);
  try {
    await assert.rejects(
      first
        .files({
          ...files,
          async create(name, data) {
            await files.create(name, data);
            throw new Error("write completed before failure");
          },
        })
        .create("chats/one/file.bin", "x".repeat(20_000)),
      /write completed before failure/,
    );
    assert.throws(() => second.charge(22_000), { code: "quota_exceeded" });
  } finally {
    first.release();
    second.release();
  }
});

void test("quota rescans keep in-flight file writes reserved", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: "first",
    maxBytes: 25_000,
    assertCurrent() {},
  });
  t.after(() => files.dispose());
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    maxFileBytes: 25_000,
    limits: { userBytes: 65_536, globalBytes: 65_536, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const first = await admit("first", () => {}, "turn");
  let finishWrite!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const write = first
    .files({
      ...files,
      async create(name, data) {
        await blocked;
        return files.create(name, data);
      },
    })
    .create("pending.bin", "x".repeat(20_000));
  try {
    first.release();
    await assert.rejects(
      admit("second", () => {}, "create"),
      { code: "quota_exceeded" },
    );
  } finally {
    finishWrite();
    await write;
    first.release();
  }
});

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
          return hasChat
            ? [{ profileId, id: "one", sessionKey: "synthetic", updatedAt: 1, transient: false }]
            : [];
        },
        async transcriptBytes() {
          return 0;
        },
      },
    })(profileId, () => {}, "turn");
  const chargedPathOverhead = 3 * 4096;
  const tooSmall = await admission(16_384 + chargedPathOverhead + data.length);
  try {
    await assert.rejects(async () => tooSmall.files(files).create("chats/one/file.bin", data), {
      code: "quota_exceeded",
      message:
        "Storage limit reached. Delete stored data to free space, or contact the server operator.",
    });
    await assert.rejects(files.stat("chats/one/file.bin"), { code: "not-found" });
  } finally {
    tooSmall.release();
  }
  const exactWrite = await admission(16_384 + chargedPathOverhead + physicalBytes);
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

void test("concurrent chat admissions share quota without returning storage_busy", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-concurrent-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { userBytes: 70_000, globalBytes: 70_000, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
  });
  const reservations = await Promise.all([
    admission("synthetic-profile", () => {}, "create"),
    admission("synthetic-profile", () => {}, "create"),
  ]);
  try {
    assert.equal(reservations.length, 2);
  } finally {
    for (const reservation of reservations) {
      reservation.release();
    }
  }
});

void test("automation definitions remain charged in the shared reservation ledger", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-capacity-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-automation-profile";
  const definition = {
    name: "Synthetic automation",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  } satisfies ProtectedAutomationDraft;
  const currentDefinition = { ...definition, instructions: "x".repeat(3_000) };
  const nextDefinition = { ...currentDefinition, instructions: "short" };
  const currentDefinitionBytes = Buffer.byteLength(JSON.stringify(currentDefinition), "utf8");
  const nextDefinitionBytes = Buffer.byteLength(JSON.stringify(nextDefinition), "utf8");
  const createBytes = Buffer.byteLength(JSON.stringify(definition), "utf8") + 4096;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: {
      userBytes: 16_384 + currentDefinitionBytes + 4096 + createBytes - 1_000,
      globalBytes: 16_384 + currentDefinitionBytes + 4096 + createBytes - 1_000,
      freeFloorBytes: 1,
    },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      return {
        totalDefinitionBytes: currentDefinitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: currentDefinitionBytes,
        profileRecords: 1,
        profiles: [{ profileId, definitionBytes: currentDefinitionBytes, records: 1 }],
        entries: [
          {
            id: "measured-automation",
            profileId,
            definitionBytes: currentDefinitionBytes,
          },
        ],
      };
    },
  });
  const turn = await admission(profileId, () => {}, "turn");
  const automation = await admission(profileId, () => {}, "automation");
  const blockedCreate = await admission(profileId, () => {}, "automation");
  try {
    automation.chargeAutomationPatch(currentDefinitionBytes, nextDefinitionBytes);
    assert.throws(() => blockedCreate.chargeAutomationCreate(createBytes - 4096), {
      code: "quota_exceeded",
    });
    automation.settleAutomationPatch(currentDefinitionBytes, nextDefinitionBytes, true);
    const admittedCreate = await admission(profileId, () => {}, "automation");
    try {
      assert.doesNotThrow(() => admittedCreate.chargeAutomationCreate(createBytes - 4096));
    } finally {
      admittedCreate.release();
    }
  } finally {
    blockedCreate.release();
    automation.release();
    turn.release();
  }
});

void test("retired definitions release measured and reserved bytes without double refunds", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-retirement-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const retiredProfileId = "synthetic-retired-profile";
  const thirdProfileId = "synthetic-retry-profile";
  const measuredDefinition = {
    name: "Measured private draft",
    instructions: "x".repeat(3_000),
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  } satisfies ProtectedAutomationDraft;
  const postMeasurementDefinition = {
    ...measuredDefinition,
    name: "New private draft",
    instructions: "Summarize synthetic test material.",
  };
  const measured = {
    id: "measured-automation",
    profileId: retiredProfileId,
    definitionBytes: Buffer.byteLength(JSON.stringify(measuredDefinition), "utf8"),
  };
  const created = {
    id: "created-after-measurement",
    profileId: retiredProfileId,
    definitionBytes: Buffer.byteLength(JSON.stringify(postMeasurementDefinition), "utf8"),
  };
  const measuredBytes = measured.definitionBytes + 4096;
  const createdBytes = created.definitionBytes + 4096;
  const limit = 16 * 1024 + measuredBytes + createdBytes + 32 * 1024 - 1;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { globalBytes: limit, userBytes: limit, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      return {
        totalDefinitionBytes: measured.definitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: measured.definitionBytes,
        profileRecords: 1,
        profiles: [
          {
            profileId: retiredProfileId,
            definitionBytes: measured.definitionBytes,
            records: 1,
          },
        ],
        entries: [measured],
      };
    },
  });
  const turn = await admission("synthetic-active-profile", () => {}, "turn");
  const automation = await admission(retiredProfileId, () => {}, "automation");
  try {
    automation.chargeAutomationCreate(created.definitionBytes);
    automation.settleAutomationCreate(created.definitionBytes, true, created.id);
    await assert.rejects(
      admission(thirdProfileId, () => {}, "create"),
      {
        code: "quota_exceeded",
      },
    );

    admission.deletedAutomations([measured, created]);
    admission.deletedAutomations([measured, created]);

    const retry = await admission(thirdProfileId, () => {}, "create");
    const noDuplicateCredit = await admission(thirdProfileId, () => {}, "automation");
    try {
      assert.throws(() => noDuplicateCredit.charge(measuredBytes + createdBytes), {
        code: "quota_exceeded",
      });
    } finally {
      noDuplicateCredit.release();
      retry.release();
    }
  } finally {
    automation.release();
    turn.release();
  }
});

void test("automation retirement reconciles with an in-progress storage measurement", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-automation-scan-race-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const profileId = "synthetic-retired-profile";
  const measured = {
    id: "measured-automation",
    profileId,
    definitionBytes: 4_000,
  };
  const absentFromSnapshot = {
    id: "already-retired-automation",
    profileId,
    definitionBytes: measured.definitionBytes,
  };
  const bytes = measured.definitionBytes + 4096;
  const measureStarted = Promise.withResolvers<void>();
  const finishMeasure = Promise.withResolvers<void>();
  const limit = 16 * 1024 + bytes + 32 * 1024 - 1;
  const admission = createStorageAdmission({
    stateDir,
    usersRoot,
    encryption,
    maxFileBytes: 1024,
    limits: { globalBytes: limit, userBytes: limit, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    async automationUsage() {
      measureStarted.resolve();
      await finishMeasure.promise;
      return {
        totalDefinitionBytes: measured.definitionBytes,
        totalRecords: 1,
        profileDefinitionBytes: measured.definitionBytes,
        profileRecords: 1,
        profiles: [{ profileId, definitionBytes: measured.definitionBytes, records: 1 }],
        entries: [measured],
      };
    },
  });
  const pendingTurn = admission("synthetic-active-profile", () => {}, "turn");
  await measureStarted.promise;
  admission.deletedAutomations([measured, absentFromSnapshot]);
  finishMeasure.resolve();
  const turn = await pendingTurn;
  try {
    const retry = await admission("synthetic-retry-profile", () => {}, "create");
    const noAbsentCredit = await admission("synthetic-retry-profile", () => {}, "automation");
    try {
      assert.throws(() => noAbsentCredit.charge(bytes), { code: "quota_exceeded" });
    } finally {
      noAbsentCredit.release();
      retry.release();
    }
  } finally {
    turn.release();
  }
});

void test("transient children are charged and recovered across registration crash windows", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-capacity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir);
  const usersRoot = await root(usersDir);
  const chats = createProtectedChats({
    stateDir,
    maxChatsPerUser: 10,
    agentCatalog: createProtectedAgentCatalog(),
    usersRoot,
    maxFileBytes: 100_000,
  });
  const profileId = randomUUID();
  const authority = { profileId, assertCurrent: () => {} };
  const parent = await chats.create(authority);
  const parentSessionKey = chats.scope(authority, parent.id).sessionKey;
  const admit = createStorageAdmission({
    stateDir,
    usersRoot,
    limits: { globalBytes: 1_000_000, userBytes: 70_000, freeFloorBytes: 1 },
    chats,
    maxFileBytes: 100_000,
  });
  (await admit(profileId, authority.assertCurrent, "turn")).release();

  const childId = randomUUID();
  const sessionKey = `agent:protected:subagent:${randomUUID()}`;
  const childScope = {
    agentId: chats.agentId,
    env: chats.env,
    storePath: chats.storePath,
    sessionKey,
  };
  const entry: InternalSessionEntry = {
    sessionId: childId,
    lifecycleRevision: randomUUID(),
    updatedAt: Date.now(),
    createdVia: "spawn",
    parentSessionKey,
    spawnedBy: parentSessionKey,
    transientLifetime: {
      kind: "request",
      profileId,
      parentSessionKey,
      parentSessionId: parent.id,
    },
  };
  const registeredScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const registeredEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const changedScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const changedEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const corruptScope = {
    ...childScope,
    sessionKey: `agent:protected:subagent:${randomUUID()}`,
  };
  const corruptEntry = { ...entry, sessionId: randomUUID(), lifecycleRevision: randomUUID() };
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "--eval",
      `
        const { createSessionEntryWithTranscript, appendTranscriptEvent } =
          await import("./src/config/sessions/session-accessor.js");
        const { acquireProtectedStateOwner } = await import("./grogu/protected/state-owner.js");
        const { bindSubagentRunRecord } =
          await import("./src/agents/subagents/registry/subagent-registry.store.codec.js");
        const { writeSubagentRunValuesInDatabase } =
          await import("./src/agents/subagents/registry/subagent-registry.store.kernel.js");
        const { runOpenClawStateWriteTransaction } =
          await import("./src/state/openclaw-state-db.js");
        const scope = JSON.parse(process.env.PROOF_CHILD_SCOPE);
        const entry = JSON.parse(process.env.PROOF_CHILD_ENTRY);
        const registeredScope = JSON.parse(process.env.PROOF_REGISTERED_SCOPE);
        const registeredEntry = JSON.parse(process.env.PROOF_REGISTERED_ENTRY);
        const changedScope = JSON.parse(process.env.PROOF_CHANGED_SCOPE);
        const changedEntry = JSON.parse(process.env.PROOF_CHANGED_ENTRY);
        const corruptScope = JSON.parse(process.env.PROOF_CORRUPT_SCOPE);
        const corruptEntry = JSON.parse(process.env.PROOF_CORRUPT_ENTRY);
        const owner = await acquireProtectedStateOwner(process.env.OPENCLAW_STATE_DIR);
        if (!owner) throw new Error("Could not own child state");
        const created = await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }));
        if (!created.ok) throw new Error("Child creation failed");
        await appendTranscriptEvent({ ...scope, sessionId: entry.sessionId },
          { type: "custom", id: "child-proof", data: "x".repeat(10_000) });
        const registered = await createSessionEntryWithTranscript(registeredScope,
          () => ({ ok: true, entry: registeredEntry }));
        if (!registered.ok) throw new Error("Registered child creation failed");
        const changed = await createSessionEntryWithTranscript(changedScope,
          () => ({ ok: true, entry: changedEntry }));
        if (!changed.ok) throw new Error("Changed child creation failed");
        const corrupt = await createSessionEntryWithTranscript(corruptScope,
          () => ({ ok: true, entry: corruptEntry }));
        if (!corrupt.ok) throw new Error("Corrupt child creation failed");
        const run = {
          runId: "synthetic-owned-run",
          childSessionKey: registeredScope.sessionKey,
          childSessionIdentity: {
            sessionId: registeredEntry.sessionId,
            lifecycleRevision: registeredEntry.lifecycleRevision,
          },
          requesterSessionKey: entry.parentSessionKey,
          requesterDisplayKey: entry.parentSessionKey,
          task: "", cleanup: "delete", expectsCompletionMessage: false,
          spawnMode: "run", createdAt: Date.now(),
          execution: { status: "running", suppressSessionEffects: true },
          completion: { required: false },
          delivery: { status: "not_required" },
          cleanupHandled: true,
        };
        const stale = {
          ...run,
          runId: "synthetic-stale-run",
          childSessionKey: changedScope.sessionKey,
          childSessionIdentity: {
            sessionId: changedEntry.sessionId,
            lifecycleRevision: "different-generation",
          },
        };
        const corruptRow = bindSubagentRunRecord({
          ...run,
          runId: "synthetic-corrupt-run",
          childSessionKey: corruptScope.sessionKey,
          childSessionIdentity: {
            sessionId: corruptEntry.sessionId,
            lifecycleRevision: corruptEntry.lifecycleRevision,
          },
        });
        const corruptPayload = JSON.parse(corruptRow.payload_json);
        corruptPayload.requesterSessionKey = "another-parent";
        corruptRow.payload_json = JSON.stringify(corruptPayload);
        runOpenClawStateWriteTransaction((database) =>
          writeSubagentRunValuesInDatabase(database,
            [bindSubagentRunRecord(run), bindSubagentRunRecord(stale), corruptRow], []));
        process.exit(0);
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        PROOF_CHILD_SCOPE: JSON.stringify(childScope),
        PROOF_CHILD_ENTRY: JSON.stringify(entry),
        PROOF_REGISTERED_SCOPE: JSON.stringify(registeredScope),
        PROOF_REGISTERED_ENTRY: JSON.stringify(registeredEntry),
        PROOF_CHANGED_SCOPE: JSON.stringify(changedScope),
        PROOF_CHANGED_ENTRY: JSON.stringify(changedEntry),
        PROOF_CORRUPT_SCOPE: JSON.stringify(corruptScope),
        PROOF_CORRUPT_ENTRY: JSON.stringify(corruptEntry),
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const childFiles = await createAuthorizedUserFiles({
    usersRoot,
    profileId,
    assertCurrent: authority.assertCurrent,
    maxBytes: 100_000,
  });
  try {
    await childFiles.write(`chats/${childId}/child.txt`, "x".repeat(80_000));
  } finally {
    childFiles.dispose();
  }
  const measurement = await measureProtectedStorage(
    { usersRoot, chats, maxFileBytes: 100_000 },
    profileId,
    authority.assertCurrent,
    false,
  );
  assert.equal(measurement.chatCount, 1);
  assert.equal(measurement.lastChatActivityAt, parent.updatedAt);
  await assert.rejects(admit(profileId, authority.assertCurrent, "turn"), {
    code: "quota_exceeded",
  });
  (await admit(randomUUID(), authority.assertCurrent, "turn")).release();

  await assert.rejects(
    chats.recoverTransient(() => {}),
    /Exclusive service state ownership/u,
  );
  const stateOwner = await acquireProtectedStateOwner(stateDir);
  assert.ok(stateOwner);
  try {
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 2,
      skipped: 2,
    });
    const remainingFiles = await createAuthorizedUserFiles({
      usersRoot,
      profileId,
      assertCurrent: stateOwner.assertCurrent,
      maxBytes: 100_000,
    });
    try {
      await assert.rejects(remainingFiles.stat(`chats/${childId}/child.txt`), {
        code: "not-found",
      });
    } finally {
      remainingFiles.dispose();
    }
    const remaining = withOpenClawStateDatabaseReadOnly(
      (database) => loadSubagentRunsForChildSessionFromSqlite(registeredScope.sessionKey, database),
      { env: chats.env },
    );
    assert.equal(remaining.length, 0);
    const changedRuns = withOpenClawStateDatabaseReadOnly(
      (database) => loadSubagentRunsForChildSessionFromSqlite(changedScope.sessionKey, database),
      { env: chats.env },
    );
    assert.equal(changedRuns.length, 1);
    assert.equal(
      (await readSessionEntryReadOnlyInWorker({ ...changedScope, projection: "full" }))?.sessionId,
      changedEntry.sessionId,
    );
    assert.equal(
      (await readSessionEntryReadOnlyInWorker({ ...corruptScope, projection: "full" }))?.sessionId,
      corruptEntry.sessionId,
    );
    assert.equal((await chats.read(authority, parent.id)).id, parent.id);
    const archive = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        hasTranscriptArchiveInDatabase(database, {
          logicalAgentId: chats.agentId,
          sessionId: childId,
          sessionKey,
        }),
      { agentId: chats.agentId, env: chats.env, path: chats.storePath },
    );
    assert.ok(archive.found);
    assert.equal(archive.value, false);
    await assert.rejects(admit(profileId, authority.assertCurrent, "turn"), {
      code: "quota_exceeded",
    });
    const ambiguousKey = `agent:protected:subagent:${randomUUID()}`;
    const ambiguousId = randomUUID();
    const ambiguousEntry: InternalSessionEntry = {
      ...entry,
      sessionId: ambiguousId,
      lifecycleRevision: randomUUID(),
      transientLifetime: {
        kind: "request",
        profileId: randomUUID(),
        parentSessionKey,
        parentSessionId: parent.id,
      },
    };
    const ambiguousScope = { ...childScope, sessionKey: ambiguousKey };
    const ambiguous = await createSessionEntryWithTranscript(ambiguousScope, () => ({
      ok: true,
      entry: ambiguousEntry,
    }));
    assert.ok(ambiguous.ok);
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 0,
      skipped: 3,
    });
    const retained = await readSessionEntryReadOnlyInWorker({
      ...ambiguousScope,
      projection: "full",
    });
    assert.equal(retained?.sessionId, ambiguousId);

    const invalidKey = `agent:protected:subagent:${randomUUID()}`;
    const invalidId = randomUUID();
    const invalidScope = { ...childScope, sessionKey: invalidKey };
    const invalid = await createSessionEntryWithTranscript(invalidScope, () => ({
      ok: true,
      entry: {
        ...entry,
        sessionId: invalidId,
        lifecycleRevision: randomUUID(),
        transientLifetime: { ...entry.transientLifetime!, parentSessionId: "" },
      },
    }));
    assert.ok(invalid.ok);
    assert.deepEqual(await chats.recoverTransient(stateOwner.assertCurrent), {
      deleted: 0,
      skipped: 4,
    });
    const invalidRetained = await readSessionEntryReadOnlyInWorker({
      ...invalidScope,
      projection: "full",
    });
    assert.equal(invalidRetained?.sessionId, invalidId);
  } finally {
    stateOwner.release();
  }
});
