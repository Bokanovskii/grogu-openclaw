import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { appendTranscriptMessages } from "../../src/config/sessions/session-accessor.transcript-turn.js";
import type { SessionTranscriptAssistantMessage } from "../../src/config/sessions/transcript.js";
import { root } from "../../src/infra/fs-safe.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../src/shared/transcript-only-openclaw-assistant.js";
import { createProtectedAgentCatalog, protectedResearchAgent } from "./agents.js";
import { createProtectedChats } from "./chats.js";

async function createChats(t: TestContext) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "protected-chat-"));
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
  return createProtectedChats({
    stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([protectedResearchAgent]),
    usersRoot: await root(usersDir),
    maxFileBytes: 64_000,
  });
}

void test("a child result is saved once in its owner's chat and charged to the request", async (t) => {
  const chats = await createChats(t);
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

void test("saved tool fragments need completion in their own turn, not a child result", async (t) => {
  const chats = await createChats(t);
  const authority = { profileId: randomUUID(), assertCurrent() {} };
  const chat = await chats.create(authority);
  const entry = await chats.readEntry(authority, chat.id);
  const scope = { ...chats.scope(authority, chat.id), sessionId: chat.id };
  const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() });
  const assistant = (
    text: string,
    stopReason: SessionTranscriptAssistantMessage["stopReason"] = "stop",
  ) =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "sparky",
      model: "synthetic",
      usage: makeZeroUsageSnapshot(),
      stopReason,
      timestamp: Date.now(),
    }) satisfies SessionTranscriptAssistantMessage;
  const widget = {
    kind: "canvas",
    view: { id: `cv_${"a".repeat(32)}` },
    presentation: { title: "Synthetic route" },
  };
  const tool = (text: string, id: string, isWidget = false) => ({
    ...assistant(text, "toolUse"),
    content: [
      { type: "text", text },
      {
        type: "toolCall",
        id,
        name: isWidget ? "show_widget" : "web_search",
        arguments: isWidget
          ? { title: "Synthetic route", html: "<p>A route</p>" }
          : { query: "synthetic route" },
      },
    ],
  });
  const result = (id: string, isWidget = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: isWidget ? "show_widget" : "web_search",
    content: [{ type: "text", text: "Saved" }],
    details: isWidget ? widget : { results: [] },
    isError: false,
    timestamp: Date.now(),
  });
  const append = (messages: unknown[]) =>
    appendTranscriptMessages(scope, { messages: messages.map((message) => ({ message })) });

  await append([
    user("A normal completed turn"),
    tool("Looking for a route.", "search"),
    result("search"),
    tool("", "widget", true),
    result("widget", true),
    assistant("The route is ready."),
    user("An unfinished parent turn"),
    tool("Still working.", "unfinished"),
    result("unfinished"),
  ]);
  await chats.saveChildResult(authority, chat.id, {
    runId: randomUUID(),
    agentId: "research",
    text: "A separate child result.",
    timestamp: Date.now(),
    parentLifecycleRevision: entry.lifecycleRevision ?? null,
  });
  await append([
    user("A tool-only completed turn"),
    tool("Preparing a widget.", "prepare"),
    result("prepare"),
    tool("", "terminal-widget", true),
    result("terminal-widget", true),
    {
      ...assistant(""),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
      model: OPENCLAW_DELIVERY_MIRROR_MODEL,
      protectedTerminalCompletion: "tool-batch",
    },
    user("A turn with a real failure before recovery"),
    { ...assistant("", "error"), errorMessage: "Synthetic provider failure" },
    tool("Trying the next step.", "retry"),
    result("retry"),
    assistant("Recovered."),
    user("An interrupted turn"),
    tool("This step did not finish.", "interrupted"),
    assistant("Cancelled.", "aborted"),
    user("A later successful turn"),
    assistant("Done."),
  ]);

  const replies = (await chats.read(authority, chat.id)).messages.filter(
    (message) => message.role === "assistant",
  );
  assert.deepEqual(
    replies.map(({ status }) => status),
    [
      "complete",
      "complete",
      "failed",
      "complete",
      "complete",
      "complete",
      "failed",
      "complete",
      "complete",
      "failed",
      "interrupted",
      "complete",
    ],
  );
  assert.deepEqual(
    replies
      .filter(({ widgets }) => widgets?.length)
      .map(({ text, status, widgets }) => ({
        text,
        status,
        widgets,
      })),
    [
      {
        text: "The route is ready.",
        status: "complete",
        widgets: [{ id: widget.view.id, title: widget.presentation.title }],
      },
      {
        text: "",
        status: "complete",
        widgets: [{ id: widget.view.id, title: widget.presentation.title }],
      },
    ],
  );
});
