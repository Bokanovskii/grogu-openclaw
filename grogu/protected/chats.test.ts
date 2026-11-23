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
    widgets: [{ id: `cv_${"a".repeat(32)}`, title: "Synthetic result" }],
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
    saved.messages.map(({ role, text, agentId, runId, widgets }) => ({
      role,
      text,
      agentId,
      runId,
      widgets,
    })),
    [
      {
        role: "assistant",
        text: result.text,
        agentId: result.agentId,
        runId: result.runId,
        widgets: result.widgets,
      },
    ],
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
  const failed = {
    ...result,
    runId: randomUUID(),
    text: "The agent could not complete its work.",
    widgets: [],
    status: "failed" as const,
  };
  await chats.saveChildResult(authority, chat.id, failed);
  const messages = (await chats.read(authority, chat.id)).messages;
  assert.deepEqual(messages[0]?.widgets, result.widgets);
  assert.equal(messages[1]?.runId, failed.runId);
  assert.equal(messages[1]?.status, "failed");
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

async function seedSideParent(t: TestContext) {
  const chats = await createChats(t);
  const authority = { profileId: randomUUID(), assertCurrent() {} };
  const parent = await chats.create(authority);
  const assistant = (text: string) =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "sparky",
      model: "synthetic",
      usage: makeZeroUsageSnapshot(),
      stopReason: "stop",
      timestamp: Date.now(),
    }) satisfies SessionTranscriptAssistantMessage;
  const append = (chatId: string, messages: unknown[]) =>
    appendTranscriptMessages(
      { ...chats.scope(authority, chatId), sessionId: chatId },
      { messages: messages.map((message) => ({ message })) },
    );
  const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() });
  return { chats, authority, parent, append, user, assistant };
}

void test("a side chat forks the parent's completed prefix and projects only its own messages", async (t) => {
  const { chats, authority, parent, append, user, assistant } = await seedSideParent(t);
  await append(parent.id, [
    user("First question"),
    assistant("First answer"),
    user("Second question"),
    assistant("Second answer"),
    user("An unfinished question"),
  ]);
  const requestId = randomUUID();
  const { chat: side, created } = await chats.createSide(authority, parent.id, {
    requestId,
    title: "Detour",
  });
  assert.equal(created, true);
  const parentMessages = (await chats.read(authority, parent.id)).messages;
  assert.equal(side.title, "Detour");
  assert.equal(side.side?.parentId, parent.id);
  assert.deepEqual(side.side?.forkedAt, { messageId: parentMessages[3]?.id, messageCount: 4 });
  assert.equal((await chats.read(authority, side.id)).messages.length, 0);

  const transcript = (id: string) =>
    chats.readReportChatSource(authority, id).then(({ events }) => events);
  const parentEvents = await transcript(parent.id);
  const sideEvents = await transcript(side.id);
  const messageEvents = (events: unknown[]) =>
    events.filter((event) => (event as { type?: string }).type === "message");
  // The inherited prefix is copied unchanged, including its entry ids, and stops before the open turn.
  assert.deepEqual(messageEvents(sideEvents), messageEvents(parentEvents).slice(0, 4));

  await append(side.id, [user("A side question"), assistant("A side answer")]);
  assert.deepEqual(
    (await chats.read(authority, side.id)).messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "A side question" },
      { role: "assistant", text: "A side answer" },
    ],
  );
  assert.equal((await chats.read(authority, parent.id)).messages.length, 5);
  assert.equal(
    messageEvents(await transcript(parent.id)).length,
    5,
    "the parent transcript does not receive side chat messages",
  );
  assert.deepEqual(
    (await chats.list(authority)).map(({ id, side: link }) => ({ id, parentId: link?.parentId })),
    [
      { id: parent.id, parentId: undefined },
      { id: side.id, parentId: parent.id },
    ],
  );
});

void test("side chat creation is idempotent, one level deep and limited to eligible chats", async (t) => {
  const { chats, authority, parent, append, user, assistant } = await seedSideParent(t);
  await append(parent.id, [user("Question"), assistant("Answer")]);
  const requestId = randomUUID();
  const { chat: side } = await chats.createSide(authority, parent.id, { requestId });
  assert.equal(side.title, "Side chat");
  assert.deepEqual(await chats.createSide(authority, parent.id, { requestId }), {
    chat: side,
    created: false,
  });
  assert.equal((await chats.list(authority)).length, 2);

  // A side chat's own side chat branches from the same parent, at the parent's current state.
  const { chat: sibling } = await chats.createSide(authority, side.id, {
    requestId: randomUUID(),
  });
  assert.equal(sibling.side?.parentId, parent.id);
  await assert.rejects(chats.createSide(authority, parent.id, { requestId: randomUUID() }), {
    status: 413,
    code: "quota_exceeded",
  });
  assert.equal((await chats.createSide(authority, parent.id, { requestId })).created, false);

  // A retry key never links to a different chat.
  await chats.delete(authority, sibling.id, sibling.version, async () => {});
  const other = await chats.create(authority);
  await append(other.id, [user("Another question"), assistant("Another answer")]);
  await assert.rejects(chats.createSide(authority, other.id, { requestId }), {
    status: 409,
    code: "request_conflict",
  });
  await chats.delete(authority, side.id, side.version, async () => {});
  await assert.rejects(
    chats.createSide(authority, other.id, {
      requestId: randomUUID(),
      selectedAgentId: "missing-agent",
    }),
    { status: 422, code: "agent_unavailable" },
  );
});

void test("side chats are refused without history, for run and authoring chats, and across profiles", async (t) => {
  const { chats, authority, parent } = await seedSideParent(t);
  await assert.rejects(chats.createSide(authority, parent.id, { requestId: randomUUID() }), {
    status: 422,
    code: "side_unavailable",
  });
  const authoring = await chats.create(authority, "Authoring", undefined, { kind: "automation" });
  await assert.rejects(chats.createSide(authority, authoring.id, { requestId: randomUUID() }), {
    status: 422,
    code: "side_unavailable",
  });
  const run = await chats.create(authority, "Run", undefined, undefined, {
    chatId: randomUUID(),
    automationId: randomUUID(),
  });
  await assert.rejects(chats.createSide(authority, run.id, { requestId: randomUUID() }), {
    status: 422,
    code: "side_unavailable",
  });
  const stranger = { profileId: randomUUID(), assertCurrent() {} };
  await assert.rejects(chats.createSide(stranger, parent.id, { requestId: randomUUID() }), {
    status: 404,
  });
  await assert.rejects(chats.createSide(authority, randomUUID(), { requestId: randomUUID() }), {
    status: 404,
  });
});
