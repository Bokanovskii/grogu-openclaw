import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { root } from "../../src/infra/fs-safe.js";
import { createProtectedAgentCatalog, protectedResearchAgent } from "./agents.js";
import { createProtectedChats } from "./chats.js";

void test("a child result is saved once in its owner's chat and charged to the request", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-chat-result-"));
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const chats = createProtectedChats({
    stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([protectedResearchAgent]),
    usersRoot: await root(usersDir),
    maxFileBytes: 64_000,
  });
  let current = true;
  const authority = {
    profileId: randomUUID(),
    assertCurrent() {
      if (!current) {
        throw new Error("Request authority ended");
      }
    },
  };
  const chat = await chats.create(authority);
  const entry = await chats.readEntry(authority, chat.id);
  const result = {
    runId: randomUUID(),
    agentId: "research",
    text: "A synthetic research result.",
    timestamp: Date.now(),
    parentLifecycleRevision: entry.lifecycleRevision ?? null,
  };
  let charged = 0;
  await withTranscriptWriteBudget(
    (bytes) => (charged += bytes),
    async () => {
      await chats.saveChildResult(authority, chat.id, result);
      const firstCharge = charged;
      await chats.saveChildResult(authority, chat.id, result);
      assert.equal(charged, firstCharge);
    },
  );
  const saved = await chats.read(authority, chat.id);
  assert.deepEqual(
    saved.messages.map(({ role, text, agentId }) => ({ role, text, agentId })),
    [{ role: "assistant", text: result.text, agentId: result.agentId }],
  );
  assert.ok(charged > 0);
  await assert.rejects(
    chats.saveChildResult({ ...authority, profileId: randomUUID() }, chat.id, result),
    { status: 404 },
  );
  await assert.rejects(
    withTranscriptWriteBudget(
      () => {
        throw new Error("Budget exhausted");
      },
      () => chats.saveChildResult(authority, chat.id, { ...result, runId: randomUUID() }),
    ),
    /Budget exhausted/,
  );
  await assert.rejects(
    chats.saveChildResult(authority, chat.id, {
      ...result,
      runId: randomUUID(),
      parentLifecycleRevision: randomUUID(),
    }),
    { code: "save_failed" },
  );
  assert.equal((await chats.read(authority, chat.id)).messages.length, 1);
  current = false;
  await assert.rejects(chats.saveChildResult(authority, chat.id, result), /authority ended/);
});
