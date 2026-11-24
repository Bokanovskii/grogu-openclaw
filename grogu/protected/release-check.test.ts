import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acquireProtectedStateOwner } from "./state-owner.js";

for (const kind of ["recoverable", "unsafe", "parent-placeholder"]) {
  void test(`release-check preserves protected state: ${kind}`, async (t) => {
    const home = path.resolve(".artifacts", `protected-release-check-${randomUUID()}`);
    t.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      OPENCLAW_CONFIG_PATH: path.join(home, "config", "openclaw.json"),
      OPENCLAW_PROTECTED_STORAGE_KEY_FILE: path.join(home, "secrets", "storage-key"),
      PROOF_KIND: kind,
    };
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "./scripts/tsx.mjs", ...args], {
        env,
        encoding: "utf8",
      });
    // A separate writer exits before the real maintenance command inspects its encrypted stores.
    const seeded = run([
      "--input-type=module",
      "--eval",
      `
      import { mkdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      import { randomUUID } from "node:crypto";
      import { createInitialSubagentSession } from "./src/agents/subagents/spawn/subagent-spawn-session-patch.js";
      import { createSessionEntryWithTranscript, deleteSessionEntryLifecycle } from "./src/config/sessions/session-accessor.js";
      import { appendTranscriptMessages } from "./src/config/sessions/session-accessor.transcript-turn.js";
      import { bindSubagentRunRecord } from "./src/agents/subagents/registry/subagent-registry.store.codec.js";
      import { writeSubagentRunValuesInDatabase } from "./src/agents/subagents/registry/subagent-registry.store.kernel.js";
      import { runOpenClawStateWriteTransaction } from "./src/state/openclaw-state-db.js";
      import { createProtectedChats } from "./grogu/protected/chats.js";
      import { createProtectedAgentCatalog } from "./grogu/protected/agents.js";
      import { acquireProtectedStateOwner } from "./grogu/protected/state-owner.js";
      import { provisionProtectedStorageKeyAndMigrate } from "./grogu/protected/storage-key.js";
      import { root } from "./src/infra/fs-safe.js";
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      await mkdir(stateDir, { mode: 0o700 });
      await mkdir(path.join(process.env.HOME, "secrets"), { mode: 0o700 });
      const owner = await acquireProtectedStateOwner(stateDir);
      if (!owner) throw new Error("Fixture owner unavailable");
      await provisionProtectedStorageKeyAndMigrate(owner.assertCurrent);
      await writeFile(path.join(stateDir, "users", "retained-file.txt"), "synthetic retained file");
      const chats = createProtectedChats({
        stateDir, maxChatsPerUser: 3, maxFileBytes: 64000,
        usersRoot: await root(path.join(stateDir, "users")),
        agentCatalog: createProtectedAgentCatalog(),
      });
      const authority = { profileId: randomUUID(), assertCurrent: owner.assertCurrent };
      await chats.create(authority, "Unrelated healthy chat");
      const children = process.env.PROOF_KIND === "unsafe"
        ? ["owner-mismatch", "registry-mismatch"]
        : [process.env.PROOF_KIND];
      for (const kind of children) {
        const parent = await chats.create(authority);
        const scope = chats.scope(authority, parent.id);
        const childSessionKey = "agent:protected:subagent:" + randomUUID();
        const child = await createInitialSubagentSession({
          cfg: {}, requesterAgentId: "protected", targetAgentId: "protected",
          requesterInternalKey: scope.sessionKey, childSessionKey,
          expectedParentSessionId: parent.id, completionOwnerSessionKey: scope.sessionKey,
          transientLifetime: {
            parentSessionId: parent.id, parentSessionKey: scope.sessionKey,
            profileId: authority.profileId,
          },
          creationPolicy: { actor: { type: "agent", id: "protected" } },
          incognito: false, collect: false, modelPatch: {},
        });
        if (child.status === "error" || !child.entry) throw new Error("Fixture spawn failed");
        if (kind === "parent-placeholder") {
          await appendTranscriptMessages({ ...scope, sessionId: parent.id }, {
            messages: [{ message: { role: "user", content: "retained parent history", timestamp: 1 } }],
          });
        }
        await deleteSessionEntryLifecycle({
          ...scope, target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          expectedSessionId: parent.id, archiveTranscript: false,
          deleteTranscriptWithoutArchive: kind !== "parent-placeholder",
        });
        if (kind === "owner-mismatch") {
          const target = { ...scope, sessionKey: childSessionKey };
          await deleteSessionEntryLifecycle({
            ...target, target: { canonicalKey: childSessionKey, storeKeys: [childSessionKey] },
            expectedSessionId: child.entry.sessionId,
            archiveTranscript: false, deleteTranscriptWithoutArchive: true,
          });
          await createSessionEntryWithTranscript(target, () => ({ ok: true, entry: {
            ...child.entry, createdActor: { type: "human", source: "profile", id: randomUUID() },
          } }));
        }
        const run = {
          runId: randomUUID(), childSessionKey,
          childSessionIdentity: {
            sessionId: child.entry.sessionId,
            lifecycleRevision: kind === "registry-mismatch"
              ? "different-generation" : child.entry.lifecycleRevision,
          },
          requesterSessionKey: scope.sessionKey, requesterDisplayKey: scope.sessionKey,
          task: "", cleanup: "delete", expectsCompletionMessage: false,
          spawnMode: "run", createdAt: 1,
          execution: { status: "running", suppressSessionEffects: true },
          completion: { required: false }, delivery: { status: "not_required" },
          cleanupHandled: true,
        };
        runOpenClawStateWriteTransaction((database) =>
          writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(run)], []));
      }
      owner.release();
      process.exit(0);
    `,
    ]);
    assert.equal(seeded.status, 0, seeded.stderr);
    const storedBytes = async () => {
      const names = (await readdir(env.OPENCLAW_STATE_DIR, { recursive: true }))
        .filter(
          (name) => name.endsWith(".sqlite") || name.endsWith("-wal") || name.endsWith(".txt"),
        )
        .toSorted();
      return (
        await Promise.all(
          names.map(
            async (name) =>
              [name, await readFile(path.join(env.OPENCLAW_STATE_DIR, name))] as const,
          ),
        )
      ).flatMap(([name, bytes]) =>
        // SQLite read-only opens can create an empty WAL, but must never add or change a frame.
        name.endsWith("-wal") && bytes.length === 0
          ? []
          : [[name, createHash("sha256").update(bytes).digest("hex")]],
      );
    };
    const before = await storedBytes();
    const checked = run(["grogu/protected/maintain.ts", "release-check"]);
    assert.deepEqual(await storedBytes(), before, `${kind}: preflight changed stored bytes`);
    if (kind === "recoverable") {
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(
        checked.stdout,
        "Child recovery release check passed: 1 recoverable child chat(s). No stored state was changed.\n",
      );
    } else if (kind === "unsafe") {
      assert.equal(checked.status, 1, checked.stderr);
      assert.equal(checked.stdout, "");
      assert.match(
        checked.stderr,
        /^Release refused: 2 child chat\(s\) cannot be recovered at startup\./mu,
      );
      assert.match(
        checked.stderr,
        /operator to repair ambiguous child ownership.*rerun release-check/u,
      );
    } else {
      assert.equal(checked.status, 1, checked.stderr);
      assert.equal(checked.stdout, "");
      assert.match(
        checked.stderr,
        /^Release refused: protected session data needs repair before child recovery can be checked\./mu,
      );
      assert.match(checked.stderr, /repair the isolated session state.*rerun release-check/u);
    }
    if (kind === "recoverable") {
      const owner = await acquireProtectedStateOwner(env.OPENCLAW_STATE_DIR);
      assert.ok(owner);
      try {
        const busy = run(["grogu/protected/maintain.ts", "release-check"]);
        assert.equal(busy.status, 1);
        assert.match(busy.stderr, /^Stop the listener before running release-check\.$/mu);
      } finally {
        owner.release();
      }
    }
  });
}
