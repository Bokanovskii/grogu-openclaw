import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { loadTranscriptEvents } from "../../src/config/sessions/session-accessor.js";
import { appendTranscriptMessages } from "../../src/config/sessions/session-accessor.transcript-turn.js";
import type { SessionTranscriptAssistantMessage } from "../../src/config/sessions/transcript.js";
import { root } from "../../src/infra/fs-safe.js";
import {
  isTranscriptOnlyOpenClawAssistantMessage,
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../src/shared/transcript-only-openclaw-assistant.js";
import { createProtectedAgentCatalog, protectedResearchAgent } from "./agents.js";
import { createProtectedChats } from "./chats.js";
import { sideReturnTextLimit, sideReturnTruncationMarker } from "./side-return.js";

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
  const rawEvents = (chatId: string) =>
    loadTranscriptEvents({ ...chats.scope(authority, chatId), sessionId: chatId });
  return { chats, authority, parent, append, user, assistant, rawEvents };
}

void test("a side chat forks the parent's completed prefix and projects only its own messages", async (t) => {
  const { chats, authority, parent, append, user, assistant, rawEvents } = await seedSideParent(t);
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

  const parentEvents = await rawEvents(parent.id);
  const sideEvents = await rawEvents(side.id);
  const messageEvents = (events: unknown[]) =>
    events.filter((event) => (event as { type?: string }).type === "message");
  // The inherited prefix is copied unchanged, including its entry ids, and stops before the open turn.
  assert.deepEqual(messageEvents(sideEvents), messageEvents(parentEvents).slice(0, 4));
  assert.deepEqual(
    (await chats.readReportChatSource(authority, side.id)).events,
    [],
    "report evidence for a side chat excludes the inherited parent prefix",
  );

  await append(side.id, [user("A side question"), assistant("A side answer")]);
  assert.deepEqual(
    (await chats.read(authority, side.id)).messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "A side question" },
      { role: "assistant", text: "A side answer" },
    ],
  );
  const report = await chats.readReportChatSource(authority, side.id);
  assert.deepEqual(
    messageEvents(report.events).map(
      (event) => (event as { message: { role: string } }).message.role,
    ),
    ["user", "assistant"],
  );
  assert.deepEqual(
    (await chats.readReportChatSource(authority, side.id, 1)).chat.messages.map(({ text }) => text),
    ["A side question"],
    "a retained report bound counts only the side chat's own events",
  );
  assert.equal((await chats.read(authority, parent.id)).messages.length, 5);
  assert.equal(
    messageEvents(await rawEvents(parent.id)).length,
    5,
    "the parent transcript does not receive side chat messages",
  );
  assert.deepEqual(
    (await chats.list(authority))
      .map(({ id, side: link }) => ({ id, parentId: link?.parentId }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    [
      { id: parent.id, parentId: undefined },
      { id: side.id, parentId: parent.id },
    ].toSorted((a, b) => a.id.localeCompare(b.id)),
  );
});

void test("a widget replaces the newest earlier widget of the same title in its own chat", async (t) => {
  const { chats, authority, parent, append, user, assistant } = await seedSideParent(t);
  const widgetId = (letter: string) => `cv_${letter.repeat(32)}`;
  const widgetTurn = (question: string, id: string, title: string) => [
    user(question),
    {
      ...assistant(""),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id, name: "show_widget", arguments: { title, html: "<p>x</p>" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "show_widget",
      content: [{ type: "text", text: "Saved" }],
      details: { kind: "canvas", view: { id: widgetId(id) }, presentation: { title } },
      isError: false,
      timestamp: Date.now(),
    },
    assistant(`Shown ${title}`),
  ];
  const widgetsOf = async (chatId: string) =>
    (await chats.read(authority, chatId)).messages.flatMap(({ widgets }) => widgets ?? []);
  await append(parent.id, [
    ...widgetTurn("One", "a", "Plan"),
    ...widgetTurn("Two", "b", "Other"),
    ...widgetTurn("Three", "c", "Plan"),
  ]);
  assert.deepEqual(await widgetsOf(parent.id), [
    { id: widgetId("a"), title: "Plan" },
    { id: widgetId("b"), title: "Other" },
    { id: widgetId("c"), title: "Plan", replaces: widgetId("a") },
  ]);

  const { chat: side } = await chats.createSide(authority, parent.id, { requestId: randomUUID() });
  await append(side.id, [
    ...widgetTurn("Side one", "d", "Plan"),
    ...widgetTurn("Side two", "e", "Plan"),
  ]);
  assert.deepEqual(
    await widgetsOf(side.id),
    [
      { id: widgetId("d"), title: "Plan" },
      { id: widgetId("e"), title: "Plan", replaces: widgetId("d") },
    ],
    "a side chat never replaces the parent's widget",
  );
  assert.equal((await widgetsOf(parent.id)).length, 3);
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

async function seedSideReturn(t: TestContext) {
  const seeded = await seedSideParent(t);
  const { chats, authority, parent, append, user, assistant } = seeded;
  const widgetId = (letter: string) => `cv_${letter.repeat(32)}`;
  const widgetTurn = (id: string, title: string, answer: string) => [
    user(`Show ${title}`),
    {
      ...assistant(""),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id, name: "show_widget", arguments: { title, html: "<p>x</p>" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "show_widget",
      content: [{ type: "text", text: "Saved" }],
      details: { kind: "canvas", view: { id: widgetId(id) }, presentation: { title } },
      isError: false,
      timestamp: Date.now(),
    },
    assistant(answer),
  ];
  await append(parent.id, [...widgetTurn("a", "Plan", "Parent plan"), user("Q"), assistant("A")]);
  const { chat: side } = await chats.createSide(authority, parent.id, { requestId: randomUUID() });
  await append(side.id, [
    user("Side one"),
    assistant("First side reply"),
    ...widgetTurn("b", "Plan", "Second side reply"),
    user("Side three"),
    assistant("Third side reply"),
  ]);
  const replies = (await chats.read(authority, side.id)).messages.filter(
    (message) => message.role === "assistant",
  );
  return { ...seeded, side, replies, widgetId };
}

void test("sending side replies adds one cited message to the parent without a model call", async (t) => {
  const { chats, authority, parent, side, replies, rawEvents, widgetId } = await seedSideReturn(t);
  const before = await chats.read(authority, parent.id);
  const sideBefore = await chats.read(authority, side.id);
  const requestId = randomUUID();
  const sent = await chats.returnSide(authority, side.id, {
    requestId,
    messageIds: [replies[0]!.id, replies[1]!.id],
    note: "  Use these.  ",
  });

  const after = await chats.read(authority, parent.id);
  assert.equal(after.messages.length, before.messages.length + 1);
  assert.deepEqual(after.messages.at(-1), sent.message);
  assert.equal(sent.message.role, "assistant");
  assert.equal(sent.message.status, "complete");
  assert.equal(sent.message.text, "Use these.\n\nFirst side reply\n\nSecond side reply");
  assert.deepEqual(sent.message.sideNote, { chatId: side.id, title: "Side chat" });
  assert.deepEqual(sent.message.widgets, [{ id: widgetId("b"), title: "Plan" }]);
  assert.deepEqual(sent.parent, { id: parent.id, version: after.version });
  assert.notEqual(after.version, before.version);

  // The parent's own history keeps its widgets: a returned widget is a reference, never a replacement.
  assert.deepEqual(
    after.messages.slice(0, -1).flatMap(({ widgets }) => widgets ?? []),
    before.messages.flatMap(({ widgets }) => widgets ?? []),
  );
  assert.deepEqual(await chats.read(authority, side.id), sideBefore, "the side chat is unchanged");

  // The next parent turn replays the copied text as an assistant message.
  const stored = (await rawEvents(parent.id)).filter(
    (event) => (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey,
  ) as { message: Record<string, unknown> }[];
  assert.equal(stored.length, 1);
  assert.equal(isTranscriptOnlyOpenClawAssistantMessage(stored[0]!.message), false);
});

void test("sending side replies again with the same request returns the same message", async (t) => {
  const { chats, authority, parent, side, replies } = await seedSideReturn(t);
  const requestId = randomUUID();
  const first = await chats.returnSide(authority, side.id, {
    requestId,
    messageIds: [replies[0]!.id],
  });
  const count = (await chats.read(authority, parent.id)).messages.length;
  assert.deepEqual(
    await chats.returnSide(authority, side.id, { requestId, messageIds: [replies[2]!.id] }),
    first,
  );
  assert.equal((await chats.read(authority, parent.id)).messages.length, count);

  // A retry key never sends from a different side chat.
  const { chat: sibling } = await chats.createSide(authority, parent.id, {
    requestId: randomUUID(),
  });
  await assert.rejects(
    chats.returnSide(authority, sibling.id, { requestId, messageIds: [replies[0]!.id] }),
    { status: 409, code: "request_conflict" },
  );
});

void test("only finished replies of this side chat can be sent, and only from side chats", async (t) => {
  const { chats, authority, parent, side, replies } = await seedSideReturn(t);
  const own = (await chats.read(authority, side.id)).messages;
  const question = own.find((message) => message.role === "user")!;
  const parentReply = (await chats.read(authority, parent.id)).messages.find(
    (message) => message.role === "assistant",
  )!;
  for (const messageIds of [
    [question.id],
    [randomUUID()],
    [parentReply.id],
    [replies[0]!.id, randomUUID()],
  ]) {
    await assert.rejects(
      chats.returnSide(authority, side.id, { requestId: randomUUID(), messageIds }),
      { status: 422, code: "invalid_message" },
    );
  }
  // A main chat has no side chat to send from.
  await assert.rejects(
    chats.returnSide(authority, parent.id, {
      requestId: randomUUID(),
      messageIds: [replies[0]!.id],
    }),
    { status: 422, code: "side_unavailable" },
  );
  const stranger = { profileId: randomUUID(), assertCurrent() {} };
  await assert.rejects(
    chats.returnSide(stranger, side.id, { requestId: randomUUID(), messageIds: [replies[0]!.id] }),
    { status: 404 },
  );
  await assert.rejects(
    chats.returnSide(authority, randomUUID(), {
      requestId: randomUUID(),
      messageIds: [replies[0]!.id],
    }),
    { status: 404 },
  );
  assert.equal(
    (await chats.read(authority, parent.id)).messages.some((message) => message.sideNote),
    false,
    "a refused request adds nothing to the parent",
  );
});

void test("a sent reply is capped, keeps the note first and never splits a character", async (t) => {
  const { chats, authority, side, append, assistant } = await seedSideReturn(t);
  await append(side.id, [
    assistant(`${"a".repeat(sideReturnTextLimit - 1)}😀${"b".repeat(50)}`),
    assistant("x".repeat(sideReturnTextLimit + 500)),
  ]);
  const [long, longer] = (await chats.read(authority, side.id)).messages.slice(-2);
  const surrogate = await chats.returnSide(authority, side.id, {
    requestId: randomUUID(),
    messageIds: [long!.id],
    note: "Note",
  });
  assert.equal(
    surrogate.message.text,
    `Note\n\n${"a".repeat(sideReturnTextLimit - 1)}${sideReturnTruncationMarker}`,
  );
  const capped = await chats.returnSide(authority, side.id, {
    requestId: randomUUID(),
    messageIds: [longer!.id],
  });
  assert.equal(
    capped.message.text,
    `${"x".repeat(sideReturnTextLimit)}${sideReturnTruncationMarker}`,
  );
});

void test("a widget-only side reply is sent with a line naming its widget", async (t) => {
  const { chats, authority, side, append, user, assistant, widgetId } = await seedSideReturn(t);
  await append(side.id, [
    user("Chart it"),
    {
      ...assistant(""),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "c",
          name: "show_widget",
          arguments: { title: "Chart", html: "<p>x</p>" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c",
      toolName: "show_widget",
      content: [{ type: "text", text: "Saved" }],
      details: { kind: "canvas", view: { id: widgetId("c") }, presentation: { title: "Chart" } },
      isError: false,
      timestamp: Date.now(),
    },
    assistant(""),
  ]);
  const widgetReply = (await chats.read(authority, side.id)).messages.at(-1)!;
  const sent = await chats.returnSide(authority, side.id, {
    requestId: randomUUID(),
    messageIds: [widgetReply.id],
  });
  assert.equal(sent.message.text, "Shared from a side chat: Chart");
  assert.deepEqual(sent.message.widgets, [{ id: widgetId("c"), title: "Chart" }]);
});
