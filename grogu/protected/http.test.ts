import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, watch, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as connectSocket } from "node:net";
import path from "node:path";
import { after, before as beforeTests, mock, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import {
  ProtectedAgentCatalogSchema,
  ProtectedAgentCatalogV1Schema,
  ProtectedAutomationCatalogSchema,
  ProtectedAutomationCatalogV1Schema,
  ProtectedAutomationDraftValidationSchema,
  ProtectedAutomationListResponseSchema,
  ProtectedAutomationResponseSchema,
  ProtectedMeSchema,
  type ProtectedAutomationDraft,
  ProtectedMemoryListResponseSchema,
  ProtectedMemoryReadResponseSchema,
  type ProtectedModel,
  type ProtectedPeople,
} from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import type { ProtectedAuthoringTurnEvent } from "../../packages/gateway-protocol/src/protected-authoring.js";
import {
  ProtectedAutomationInboxResponseSchema,
  ProtectedAutomationLifecycleListResponseSchema,
} from "../../packages/gateway-protocol/src/protected-automation-results.js";
import { FailoverError } from "../../src/agents/failover/error.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { createCanvasDocument } from "../../src/canvas/documents.js";
import { appendTranscriptMessages } from "../../src/config/sessions/session-accessor.transcript-turn.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  authorizedUserFilesDirectory,
  createAuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { bindGithubCopilotToken } from "../../src/plugin-sdk/github-copilot-domain.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../../src/state/openclaw-agent-db-lease.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import {
  bindProtectedAutomationJobWithAdmission,
  createProtectedAutomationWithAdmission,
} from "../../src/state/protected-automation-operations.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../src/state/user-preferences.js";
import {
  ensureCanonicalUserProfileForVerifiedIdentity,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
} from "../../src/state/user-profile-writes.js";
import {
  createStorageValueEncryption,
  isStorageValueEncrypted,
} from "../../src/storage/encryption.js";
import { addProtectedSubject, bindProtectedProfile } from "./admission-store.js";
import {
  createProtectedAgentCatalog,
  protectedAgentTools,
  protectedResearchAgent,
  type ProtectedAgentExtension,
} from "./agents.js";
import {
  ALCOVE_BROWSER_HANDOFF_TOOL_NAME,
  ALCOVE_BROWSER_TOOL_NAMES,
} from "./alcove-browser/contract.js";
import { readProtectedAutomationLifecycleStorageUsage } from "./automation-lifecycle-store.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import type { ProtectedBrowserBroker } from "./browser/broker.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError, publicError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import type { ProtectedIdentityVerifier } from "./identity.js";
import { createProtectedMemberMemory } from "./member-memory.js";
import { createProtectedMemoryReview } from "./memory-review.js";
import { withThinking } from "./models.js";
import { createProviderRelay } from "./provider-relay.js";
import { closeProtectedServer, createProtectedServer } from "./server.js";
import { protectedOpenClawConfig } from "./settings.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";
import { createProtectedStaticClient } from "./static-client.js";
import { installFixtureFetch } from "./test-fetch-guard.js";
import { createCanonicalProtectedTurns } from "./turns.js";
import { listProtectedUsage } from "./usage-store.js";

const protectedCleanupAgent: ProtectedAgentExtension = {
  id: "cleanup",
  name: "Cleanup proof",
  description: "Creates a widget to verify transient file cleanup.",
  instructions: "Create a widget so transient files are cleaned.",
  selectable: true,
};

void test("Protected turns load skills on request and retain credentials during overflow recovery", async (t) => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(
    stateDir && path.relative(path.resolve(".artifacts"), stateDir).startsWith("protected-proof-"),
  );
  protectedTestStateDirs.add(stateDir);
  const usersDir = path.join(stateDir, "users");
  const workspaceDir = path.join(stateDir, "workspace");
  const agentDir = path.join(stateDir, "agents", "protected", "agent");
  await Promise.all(
    [usersDir, workspaceDir, agentDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  const requests: Array<{
    authorization?: string;
    model?: string;
    messages: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  let overflow = false;
  let blockedAutomation: { entered: () => void; wait: Promise<void> } | undefined;
  const previousAmbientKey = process.env.SPARKY_API_KEY;
  process.env.SPARKY_API_KEY = "synthetic-ambient-key";
  t.after(() => {
    if (previousAmbientKey === undefined) {
      delete process.env.SPARKY_API_KEY;
    } else {
      process.env.SPARKY_API_KEY = previousAmbientKey;
    }
  });
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ ...body, authorization: request.headers.authorization });
      const messages = JSON.stringify(body.messages);
      if (blockedAutomation && messages.includes("Summarize synthetic public news.")) {
        blockedAutomation.entered();
        await blockedAutomation.wait;
      }
      if (!overflow && messages.includes("Trigger synthetic overflow")) {
        overflow = true;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 32000 tokens. However, your messages resulted in 33000 tokens.",
              code: "context_length_exceeded",
            },
          }),
        );
        return;
      }
      const summary = messages.includes("context summarization assistant");
      const readSkill =
        !summary &&
        messages.includes("Make a travel dashboard") &&
        !body.messages.some((message: { role: string }) => message.role === "tool");
      const delta = readSkill
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "skill-call",
                type: "function",
                function: { name: "skills_read", arguments: '{"name":"Travel dashboard"}' },
              },
            ],
          }
        : { role: "assistant", content: summary ? "Synthetic summary." : "Synthetic answer." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [{ index: 0, delta: {}, finish_reason: readSkill ? "tool_calls" : "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch(() => response.destroy());
  });
  const providerOrigin = await listen(provider);
  t.after(() => close(provider));
  const serviceConfig = protectedOpenClawConfig(
    stateDir,
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const config: OpenClawConfig = {
    ...serviceConfig,
    agents: {
      ...serviceConfig.agents,
      defaults: {
        ...serviceConfig.agents?.defaults,
        compaction: { mode: "default", keepRecentTokens: 1, postIndexSync: "off" },
      },
      entries: { protected: { workspace: workspaceDir, agentDir } },
    },
    models: {
      mode: "replace",
      providers: {
        sparky: {
          baseUrl: `${providerOrigin}/v1`,
          api: "openai-completions",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "synthetic",
              name: "Synthetic",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  await prepareProtectedSharedState(stateDir, () => {});
  await addProtectedSubject(stateDir, {
    issuer: "https://synthetic.example",
    subject: "synthetic-discovery",
  });
  await addProtectedSubject(stateDir, {
    issuer: "https://synthetic.example",
    subject: "synthetic-other",
  });
  const origin = "https://family.example";
  const expiresAt = Date.now() + 3_600_000;
  const browserSessions = { opened: 0, open: 0, handoffs: 0 };
  const browser: ProtectedBrowserBroker = {
    openSession({ handoff }) {
      browserSessions.opened += 1;
      browserSessions.handoffs += handoff ? 1 : 0;
      browserSessions.open += 1;
      const unused = async () => ({ status: "unavailable" as const, reason: "synthetic" });
      return {
        bindings: {
          browser: "fresh",
          open: unused,
          snapshot: unused,
          followLink: unused,
          back: unused,
          ...(handoff ? { requestUser: unused } : {}),
        },
        async close() {
          browserSessions.open -= 1;
        },
      };
    },
    async shutdown() {},
  };
  const { publishConfiguredModelRuntimeSnapshots } =
    await import("../../src/gateway/server-startup-model-runtime.js");
  await publishConfiguredModelRuntimeSnapshots({ cfg: config, workspaceDir });
  const appOptions = {
    origin,
    accessIssuer: "https://synthetic.example",
    ownerSubject: "synthetic-discovery",
    browser: { handoff: true },
    stateDir,
    usersRoot: await root(usersDir),
    encryption,
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 16_000_000, userBytes: 8_000_000, freeFloorBytes: 1 },
    directory: {
      issuer: "https://synthetic.example",
      allowedSubjects: ["synthetic-discovery", "synthetic-other"],
    },
    verifyIdentity: async (request) => {
      const subject = request.headers.get("x-synthetic-subject") ?? "synthetic-discovery";
      return {
        issuer: "https://synthetic.example",
        subject,
        kind: "human",
        expiresAt,
        sessionId: createHash("sha256").update(`${subject}-session`).digest("hex"),
        assertCurrent() {},
        async revalidate() {},
      };
    },
    turns: createCanonicalProtectedTurns({
      config,
      workspaceDir,
      agentDir,
      browser,
      models: [withThinking({ provider: "sparky", id: "synthetic", label: "Synthetic" })],
      resolveSparkyKey: async () => "synthetic-request-only-key",
    }),
  } satisfies Parameters<typeof createProtectedHttp>[0];
  let app = createProtectedHttp(appOptions);
  t.after(() => assert.equal(browserSessions.open, 0, "every browser session closes"));
  let server = createProtectedServer(origin, app.fetch);
  let url = await listen(server);
  t.after(() => closeProtectedServer(server, app, stateDir));
  const call = (route: string, init?: RequestInit) =>
    fetch(`${url}/api/protected/v1${route}`, {
      ...init,
      headers: { origin, "content-type": "application/json", ...init?.headers },
    });
  const me = await call("/me");
  assert.equal(me.status, 200, await me.clone().text());
  const { user } = await me.json();
  const created = await call("/chats", { method: "POST", body: "{}" });
  assert.equal(created.status, 200, await created.clone().text());
  const { chat } = await created.json();
  const sibling = await call(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Hello"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.match(await sibling.text(), /"type":"done"/u);
  assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /## Available skills/u);
  const readChat = await (await call(`/chats/${chat.id}`)).json();
  assert.equal(
    (
      await call(`/chats/${chat.id}/agent`, {
        method: "PATCH",
        headers: { "if-match": readChat.chat.version },
        body: '{"selectedAgentId":"travel"}',
      })
    ).status,
    200,
  );
  const firstTravel = requests.length;
  const travel = await call(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Make a travel dashboard"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.match(await travel.text(), /"type":"done"/u);
  const discovery = JSON.stringify(requests[firstTravel]?.messages);
  const loaded = JSON.stringify(requests[firstTravel + 1]?.messages);
  assert.match(
    discovery,
    /Travel dashboard: Plan a trip step by step and show it as a live HTML travel dashboard/u,
  );
  assert.doesNotMatch(discovery, /Work like a careful travel planner/u);
  assert.match(loaded, /Work like a careful travel planner/u);
  const toolNames = requests[firstTravel]?.tools?.map((tool) => tool.function.name);
  assert.ok(toolNames);
  assert.ok(toolNames.includes("skills_read"));
  assert.ok(!toolNames.includes("create_artifact"));
  assert.ok(ALCOVE_BROWSER_TOOL_NAMES.every((name) => toolNames.includes(name)));
  const allowedTools = new Set<string>([
    "route_to_agent",
    ...protectedAgentTools,
    ...ALCOVE_BROWSER_TOOL_NAMES,
  ]);
  assert.ok(toolNames.every((name) => allowedTools.has(name)));
  // Member browser control exists only for clients that negotiated it.
  assert.ok(!toolNames.includes(ALCOVE_BROWSER_HANDOFF_TOOL_NAME));
  assert.equal(browserSessions.handoffs, 0);
  const handoffHeaders = {
    "x-grogu-profile": user.id,
    "x-alcove-capabilities": "browser-handoff-v2",
  };
  assert.deepEqual(
    (await (await call("/me", { headers: handoffHeaders })).json()).capabilities.browserHandoff,
    { version: 2 },
  );
  assert.equal((await (await call("/me")).json()).capabilities.browserHandoff, undefined);
  const finishedHandoff = await call(
    `/chats/${chat.id}/runs/synthetic-run/browser-handoffs/AAAAAAAAAAAAAAAAAAAAAA/claim`,
    { method: "POST", headers: handoffHeaders, body: '{"origin":"https://synthetic.example"}' },
  );
  assert.equal(finishedHandoff.status, 404);

  const overflowStart = requests.length;
  const recovered = await call(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Trigger synthetic overflow"}',
    headers: handoffHeaders,
  });
  const recoveredTrace = await recovered.text();
  const recoveryRequests = requests.slice(overflowStart);
  assert.equal(browserSessions.handoffs, 1);
  assert.ok(
    recoveryRequests[0]?.tools?.some(
      (tool) => tool.function.name === ALCOVE_BROWSER_HANDOFF_TOOL_NAME,
    ),
  );
  assert.ok(overflow);
  const summaryRequest = recoveryRequests.find((request) =>
    JSON.stringify(request.messages).includes("context summarization assistant"),
  );
  assert.ok(summaryRequest, "expected a summary request after the overflow");
  assert.equal(recoveryRequests[0]?.authorization, "Bearer synthetic-request-only-key");
  assert.equal(summaryRequest.authorization, "Bearer synthetic-request-only-key");
  assert.equal(summaryRequest.model, "synthetic");
  assert.match(recoveredTrace, /"type":"done"/u);

  const scheduleNow = Math.floor(Date.now() / 60_000) * 60_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: scheduleNow });
  await app.startAutomations(() => {});
  const capabilities = "automation-runs-v1, automation-results-v1, automations-context-v1";
  const automationCall = (route: string, init?: RequestInit) =>
    call(route, {
      ...init,
      headers: { "x-alcove-capabilities": capabilities, ...init?.headers },
    });
  const nextMinute = new Date(scheduleNow + 60_000);
  const cronParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(nextMinute);
  const cronHour = Number(cronParts.find((part) => part.type === "hour")?.value);
  const cronMinute = Number(cronParts.find((part) => part.type === "minute")?.value);
  const createdAutomation = await automationCall("/automations", {
    method: "POST",
    body: JSON.stringify({
      name: "Synthetic news",
      instructions: "Summarize synthetic public news.",
      whenToNotify: "After each briefing.",
      agentId: "grogu",
      model: { provider: "sparky", id: "synthetic" },
      schedule: {
        kind: "cron",
        expr: `${cronMinute} ${cronHour} * * *`,
        tz: "America/Los_Angeles",
      },
    }),
  });
  assert.equal(createdAutomation.status, 201, await createdAutomation.clone().text());
  const automation = (await createdAutomation.json()).automation;
  assert.equal(automation.nextCheckAt, null);
  assert.equal(automation.contextAccess, "member");
  const isolatedDraft: ProtectedAutomationDraft = {
    name: "Synthetic isolated automation",
    instructions: "Summarize synthetic isolated material.",
    whenToNotify: "After each briefing.",
    agentId: "grogu",
    model: { provider: "sparky", id: "synthetic" },
    thinking: "low",
    contextAccess: "isolated",
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const isolatedResponse = await automationCall("/automations", {
    method: "POST",
    body: JSON.stringify(isolatedDraft),
  });
  assert.equal(isolatedResponse.status, 503, await isolatedResponse.clone().text());
  assert.equal((await isolatedResponse.json()).error.code, "automation_isolation_unavailable");
  const seededIsolated = await createProtectedAutomationWithAdmission(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    { profileId: user.id, definition: isolatedDraft, now: Date.now() },
    { profileId: user.id, assertCurrent() {} },
  );
  assert.equal(seededIsolated.status, "created");
  if (seededIsolated.status !== "created") {
    assert.fail("Could not seed the isolated automation.");
  }
  const isolatedId = seededIsolated.automation.id;
  const isolatedView = await automationCall(`/automations/${isolatedId}`);
  assert.equal(isolatedView.status, 200, await isolatedView.clone().text());
  const isolatedAutomation = (await isolatedView.json()).automation;
  assert.equal(isolatedAutomation.contextAccess, "isolated");
  const legacyView = await call(`/automations/${isolatedId}`);
  assert.equal(legacyView.status, 200);
  assert.equal("contextAccess" in (await legacyView.json()).automation, false);
  const beforeIsolatedRun = requests.length;
  const isolatedRun = await automationCall(`/automations/${isolatedAutomation.id}/run`, {
    method: "POST",
  });
  assert.equal(isolatedRun.status, 503);
  assert.equal((await isolatedRun.json()).error.code, "automation_isolation_unavailable");
  assert.equal(requests.length, beforeIsolatedRun);
  const waitForDelivery = async (trigger: "scheduled" | "manual", excluded: string[] = []) => {
    for await (const event of watch(stateDir, { recursive: true })) {
      void event;
      const history = await automationCall(`/automations/${automation.id}/run-history`);
      assert.equal(history.status, 200, await history.clone().text());
      const historyBody = await history.json();
      assert.ok(Value.Check(ProtectedAutomationLifecycleListResponseSchema, historyBody));
      const runs = historyBody.runs as Array<{
        id: string;
        trigger: string;
        status: string;
        resultId: string | null;
        runChatId: string | null;
        delivery: string | null;
        errorCode: string | null;
      }>;
      const failed = runs.find(
        (entry) =>
          entry.trigger === trigger &&
          ["failed", "skipped"].includes(entry.status) &&
          !excluded.includes(entry.id),
      );
      assert.equal(failed, undefined, `Automation ${trigger} failed: ${failed?.errorCode}`);
      const run = runs.find(
        (entry) =>
          entry.trigger === trigger &&
          entry.delivery === "delivered" &&
          !excluded.includes(entry.id),
      );
      if (run) {
        return run;
      }
    }
    throw new Error("Automation storage watcher stopped before delivery.");
  };
  const pausedDelivery = waitForDelivery("manual");
  const pausedRunNow = await automationCall(`/automations/${automation.id}/run`, {
    method: "POST",
  });
  assert.equal(pausedRunNow.status, 202, await pausedRunNow.clone().text());
  const firstManualRun = await pausedDelivery;
  assert.equal(firstManualRun.status, "succeeded");
  const stillPaused = (await (await automationCall(`/automations/${automation.id}`)).json())
    .automation;
  assert.equal(stillPaused.enabled, false);
  assert.equal(stillPaused.version, automation.version);
  assert.equal(stillPaused.nextCheckAt, null);
  assert.ok(firstManualRun.runChatId);
  const runChatRoute = `/chats/${firstManualRun.runChatId}`;
  const legacyRunChat = (await (await call(runChatRoute)).json()).chat;
  assert.equal(legacyRunChat.automationRun, undefined);
  const runChat = (await (await automationCall(runChatRoute)).json()).chat;
  assert.deepEqual(runChat.automationRun, { automationId: automation.id });
  assert.ok(runChat.messages.some((message: { role: string }) => message.role === "assistant"));
  const legacyList = (await (await call("/chats")).json()).chats;
  assert.equal(
    legacyList.find((item: { id: string }) => item.id === firstManualRun.runChatId).automationRun,
    undefined,
  );
  const negotiatedList = (await (await automationCall("/chats")).json()).chats;
  assert.deepEqual(
    negotiatedList.find((item: { id: string }) => item.id === firstManualRun.runChatId)
      .automationRun,
    { automationId: automation.id },
  );
  const deniedTurn = await call(`${runChatRoute}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": user.id },
    body: JSON.stringify({ provider: "sparky", model: "synthetic", text: "Unexpected turn" }),
  });
  assert.equal(deniedTurn.status, 409);
  assert.deepEqual((await deniedTurn.json()).error, {
    code: "run_chat_read_only",
    message: "This chat is a record of an automation run. It is read only.",
  });
  const fakeRun = randomUUID();
  for (const [method, suffix] of [
    ["POST", "steer"],
    ["DELETE", `steer/${randomUUID()}`],
    ["POST", "stop"],
  ] as const) {
    const deniedControl = await call(`${runChatRoute}/runs/${fakeRun}/${suffix}`, {
      method,
    });
    assert.equal(deniedControl.status, 409);
    assert.equal((await deniedControl.json()).error.code, "run_chat_read_only");
  }
  const enabled = await automationCall(`/automations/${automation.id}`, {
    method: "PATCH",
    headers: { "if-match": automation.version },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200, await enabled.clone().text());
  const expectedNextCheck = new Date(scheduleNow + 60_000).toISOString();
  const enabledRecord = (await enabled.clone().json()).automation;
  assert.equal(enabledRecord.nextCheckAt, expectedNextCheck);
  const listed = (await (await automationCall("/automations")).json()).automations;
  assert.equal(
    listed.find((entry: { id: string }) => entry.id === automation.id)?.nextCheckAt,
    expectedNextCheck,
  );
  const read = (await (await automationCall(`/automations/${automation.id}`)).json()).automation;
  assert.equal(read.nextCheckAt, expectedNextCheck);
  const calendarPaused = await automationCall(`/automations/${automation.id}`, {
    method: "PATCH",
    headers: { "if-match": enabledRecord.version },
    body: JSON.stringify({ enabled: false, schedule: { kind: "every", everyMs: 60_000 } }),
  });
  assert.equal(calendarPaused.status, 200, await calendarPaused.clone().text());
  const pausedRecord = (await calendarPaused.json()).automation;
  assert.equal(pausedRecord.nextCheckAt, null);
  const isolatedEnabled = await automationCall(`/automations/${isolatedId}`, {
    method: "PATCH",
    headers: { "if-match": isolatedAutomation.version },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(isolatedEnabled.status, 200, await isolatedEnabled.clone().text());
  const isolatedEnabledRecord = (await isolatedEnabled.json()).automation;
  let resumed = await automationCall(`/automations/${automation.id}`, {
    method: "PATCH",
    headers: { "if-match": pausedRecord.version },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal((await resumed.clone().json()).automation.nextCheckAt, expectedNextCheck);
  const scheduledDelivery = waitForDelivery("scheduled");
  const automationRequestStart = requests.length;
  const browsersBeforeAutomation = browserSessions.opened;
  const isolatedRefusal = Promise.withResolvers<void>();
  const originalError = console.error;
  const errorCapture = t.mock.method(console, "error", (...args: unknown[]) => {
    if (
      args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(`protected-automation:${isolatedId} failed:`) &&
          arg.includes("Isolated automation execution is unavailable"),
      )
    ) {
      isolatedRefusal.resolve();
    }
    originalError(...args);
  });
  t.mock.timers.tick(60_000);
  const [scheduledRun] = await Promise.all([scheduledDelivery, isolatedRefusal.promise]);
  errorCapture.mock.restore();
  const isolatedHistory = await automationCall(`/automations/${isolatedId}/run-history`);
  assert.equal(isolatedHistory.status, 200, await isolatedHistory.clone().text());
  assert.deepEqual((await isolatedHistory.json()).runs, []);
  assert.ok(
    requests
      .slice(automationRequestStart)
      .every((request) => !JSON.stringify(request.messages).includes(isolatedDraft.instructions)),
  );
  const isolatedDeletion = await automationCall(`/automations/${isolatedId}`, {
    method: "DELETE",
    headers: {
      "x-alcove-capabilities": `${capabilities}, automation-delete-v1`,
      "if-match": isolatedEnabledRecord.version,
    },
  });
  assert.equal(isolatedDeletion.status, 204, await isolatedDeletion.clone().text());
  assert.equal(scheduledRun.status, "succeeded");
  assert.ok(scheduledRun.resultId);
  assert.ok(scheduledRun.runChatId);
  assert.equal(scheduledRun.runChatId, firstManualRun.runChatId);
  const automationRequest = requests[automationRequestStart];
  assert.match(JSON.stringify(automationRequest?.messages), /Summarize synthetic public news/u);
  assert.ok(automationRequest?.tools?.some((tool) => tool.function.name === "web_search"));
  assert.ok(automationRequest?.tools?.some((tool) => tool.function.name === "web_fetch"));
  // Automation runs never receive a browser, even for an interactive member's definition.
  assert.ok(
    requests
      .slice(automationRequestStart)
      .every(
        (request) => !request.tools?.some((tool) => tool.function.name.startsWith("browser_")),
      ),
  );
  assert.equal(browserSessions.opened, browsersBeforeAutomation);
  const paused = await automationCall(`/automations/${automation.id}`, {
    method: "PATCH",
    headers: { "if-match": (await resumed.clone().json()).automation.version },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200, await paused.clone().text());
  const originalPost = Worker.prototype.postMessage;
  const originalEmit = Worker.prototype.emit;
  const heldQueue = Promise.withResolvers<{ worker: Worker; runId: string }>();
  let target: { worker: Worker; requestId: number; runId: string } | undefined;
  t.mock.method(
    Worker.prototype,
    "postMessage",
    function (this: Worker, request: unknown, transferList?: Parameters<Worker["postMessage"]>[1]) {
      if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
        const operation: unknown = deserialize(request.input);
        if (
          isRecord(operation) &&
          operation.type === "protectedAutomationLifecycle.commit" &&
          isRecord(operation.input) &&
          isRecord(operation.input.command) &&
          operation.input.command.kind === "queue" &&
          typeof operation.input.command.runId === "string" &&
          typeof request.id === "number" &&
          operation.input.command.automationId === automation.id
        ) {
          target = { worker: this, requestId: request.id, runId: operation.input.command.runId };
        }
      }
      return Reflect.apply(originalPost, this, [request, transferList]);
    },
  );
  t.mock.method(
    Worker.prototype,
    "emit",
    function (this: Worker, event: string | symbol, ...args: unknown[]) {
      const reply = args[0];
      const current = target;
      if (
        current &&
        current.worker === this &&
        event === "message" &&
        isRecord(reply) &&
        reply.id === current.requestId &&
        reply.ok === true
      ) {
        heldQueue.resolve({ worker: this, runId: current.runId });
        target = undefined;
        return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    },
  );
  const uncertainRequest = automationCall(`/automations/${automation.id}/run`, { method: "POST" });
  const lostQueue = await heldQueue.promise;
  await lostQueue.worker.terminate();
  const uncertainResponse = await uncertainRequest;
  assert.notEqual(uncertainResponse.status, 202);
  t.mock.restoreAll();
  const manualDelivery = waitForDelivery("manual", [firstManualRun.id, lostQueue.runId]);
  const runNow = await automationCall(`/automations/${automation.id}/run`, { method: "POST" });
  assert.equal(runNow.status, 202, await runNow.clone().text());
  const recoveredHistory = (await (
    await automationCall(`/automations/${automation.id}/run-history`)
  ).json()) as { runs: Array<{ id: string; status: string; errorCode: string | null }> };
  assert.partialDeepStrictEqual(
    recoveredHistory.runs.find((run) => run.id === lostQueue.runId),
    { id: lostQueue.runId, status: "failed", errorCode: "interrupted" },
  );
  const manualRun = await manualDelivery;
  assert.equal(manualRun.status, "succeeded");
  assert.equal(manualRun.runChatId, scheduledRun.runChatId);
  const afterManual = (await (await automationCall(`/automations/${automation.id}`)).json())
    .automation;
  assert.equal(afterManual.enabled, false);
  assert.equal(afterManual.nextCheckAt, null);
  const results = await automationCall(`/automations/${automation.id}/runs`);
  assert.equal(results.status, 200);
  const resultRows = (await results.json()).runs as Array<{ runId: string; text: string }>;
  assert.equal(resultRows.find((row) => row.runId === scheduledRun.id)?.text, "Synthetic answer.");
  assert.equal(resultRows.find((row) => row.runId === manualRun.id)?.text, "Synthetic answer.");
  const beforeRunChatDeletion = (await (await call(runChatRoute)).json()).chat;
  const deleteRunChat = await call(runChatRoute, {
    method: "DELETE",
    headers: { "if-match": beforeRunChatDeletion.version },
  });
  assert.equal(deleteRunChat.status, 204, await deleteRunChat.clone().text());
  const recreatedDelivery = waitForDelivery("manual", [
    firstManualRun.id,
    lostQueue.runId,
    manualRun.id,
  ]);
  const recreateRun = await automationCall(`/automations/${automation.id}/run`, {
    method: "POST",
  });
  assert.equal(recreateRun.status, 202);
  const recreatedRun = await recreatedDelivery;
  assert.equal(recreatedRun.runChatId, scheduledRun.runChatId);
  assert.deepEqual((await (await automationCall(runChatRoute)).json()).chat.automationRun, {
    automationId: automation.id,
  });
  const inbox = await automationCall("/automations/inbox");
  const inboxBody = await inbox.json();
  assert.ok(Value.Check(ProtectedAutomationInboxResponseSchema, inboxBody));
  const inboxRows = inboxBody.entries as Array<{ runId: string; push: string }>;
  assert.equal(inboxRows.filter((row) => row.runId === scheduledRun.id).length, 1);
  assert.equal(inboxRows.filter((row) => row.runId === manualRun.id).length, 1);
  assert.ok(inboxRows.every((row) => row.push === "not-started"));
  const foreignHeaders = { "x-synthetic-subject": "synthetic-other" };
  assert.equal((await call("/me", { headers: foreignHeaders })).status, 200);
  assert.equal(
    (await automationCall(`/automations/${automation.id}/run-history`, { headers: foreignHeaders }))
      .status,
    404,
  );
  assert.equal(
    (await automationCall(`/automations/${automation.id}/runs`, { headers: foreignHeaders }))
      .status,
    404,
  );
  assert.equal(
    (await call(`/chats/${scheduledRun.runChatId}`, { headers: foreignHeaders })).status,
    404,
  );
  assert.deepEqual(
    (await (await automationCall("/automations/inbox", { headers: foreignHeaders })).json())
      .entries,
    [],
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  blockedAutomation = { entered: entered.resolve, wait: release.promise };
  const nextDelivery = waitForDelivery("manual", [
    firstManualRun.id,
    lostQueue.runId,
    manualRun.id,
    recreatedRun.id,
  ]);
  const activeRun = await automationCall(`/automations/${automation.id}/run`, { method: "POST" });
  assert.equal(activeRun.status, 202);
  await entered.promise;
  const busyDelete = await automationCall(`/automations/${automation.id}`, {
    method: "DELETE",
    headers: { "if-match": (await paused.clone().json()).automation.version },
  });
  assert.equal(busyDelete.status, 409);
  assert.equal((await busyDelete.json()).error.code, "automation_busy");
  blockedAutomation = undefined;
  release.resolve();
  await nextDelivery;
  resumed = await automationCall(`/automations/${automation.id}`, {
    method: "PATCH",
    headers: { "if-match": (await paused.json()).automation.version },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  const memberCreated = await automationCall("/automations", {
    method: "POST",
    headers: foreignHeaders,
    body: JSON.stringify({
      name: "Synthetic member news",
      instructions: "Summarize synthetic public news.",
      whenToNotify: "After each briefing.",
      agentId: "grogu",
      model: { provider: "sparky", id: "synthetic" },
      schedule: { kind: "every", everyMs: 60_000 },
    }),
  });
  assert.equal(memberCreated.status, 201, await memberCreated.clone().text());
  const memberAutomation = (await memberCreated.json()).automation;
  const memberEnabled = await automationCall(`/automations/${memberAutomation.id}`, {
    method: "PATCH",
    headers: { ...foreignHeaders, "if-match": memberAutomation.version },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(memberEnabled.status, 200, await memberEnabled.clone().text());
  await close(server);
  await app.shutdown();
  t.mock.timers.tick(5 * 60_000);
  app = createProtectedHttp({
    ...appOptions,
    storageLimits: { ...appOptions.storageLimits, userBytes: 280_000 },
  });
  server = createProtectedServer(origin, app.fetch);
  url = await listen(server);
  const beforeStart = (await (await automationCall(`/automations/${automation.id}`)).json())
    .automation;
  assert.equal(beforeStart.enabled, true);
  assert.equal(beforeStart.nextCheckAt, null);
  const overdueDelivery = waitForDelivery("scheduled", [scheduledRun.id]);
  const quotaRefusal = (async () => {
    for await (const event of watch(stateDir, { recursive: true })) {
      void event;
      const history = await automationCall(`/automations/${memberAutomation.id}/run-history`, {
        headers: foreignHeaders,
      });
      assert.equal(history.status, 200, await history.clone().text());
      const runs = (await history.json()).runs as Array<{
        status: string;
        errorCode: string | null;
      }>;
      const run = runs.find((entry) => entry.status === "skipped");
      if (run) {
        return run;
      }
      assert.ok(!runs.some((entry) => entry.status === "failed" || entry.status === "succeeded"));
    }
    throw new Error("Automation storage watcher stopped before quota refusal.");
  })();
  await app.startAutomations(() => {});
  t.mock.timers.tick(0);
  const overdue = await overdueDelivery;
  assert.equal((await quotaRefusal).errorCode, "quota_exceeded");
  assert.notEqual(overdue.id, scheduledRun.id);
  t.mock.timers.tick(0);
  const afterRestart = await (
    await automationCall(`/automations/${automation.id}/run-history`)
  ).json();
  assert.equal(
    afterRestart.runs.filter((run: { trigger: string }) => run.trigger === "scheduled").length,
    2,
  );
  const beforeDeletion = await readProtectedAutomationLifecycleStorageUsage(stateDir, () => {});
  const beforeResults = await readProtectedAutomationResultStorageUsage(stateDir, () => {});
  const ownerVersion = (await resumed.json()).automation.version;
  const deletion = await automationCall(`/automations/${automation.id}`, {
    method: "DELETE",
    headers: { "if-match": ownerVersion },
  });
  assert.equal(deletion.status, 204, await deletion.clone().text());
  assert.equal((await automationCall(`/automations/${automation.id}/runs`)).status, 404);
  assert.equal((await automationCall(`/automations/${automation.id}/run-history`)).status, 404);
  const remainingInbox = (await (await automationCall("/automations/inbox")).json()).entries;
  assert.ok(
    remainingInbox.every((entry: { automationId: string }) => entry.automationId !== automation.id),
  );
  assert.equal((await call(`/chats/${scheduledRun.runChatId}`)).status, 200);
  const afterDeletion = await readProtectedAutomationLifecycleStorageUsage(stateDir, () => {});
  const afterResults = await readProtectedAutomationResultStorageUsage(stateDir, () => {});
  assert.ok(
    beforeDeletion.some((entry) => entry.id === `protected-automation-chat:${automation.id}`),
  );
  assert.ok(
    !afterDeletion.some((entry) => entry.id === `protected-automation-chat:${automation.id}`),
  );
  assert.ok(beforeResults.length > afterResults.length);
  const people = (await (await call("/admin/people")).json()).people as Array<{
    id: string;
    subject?: string;
  }>;
  const member = people.find((person) => person.subject === "synthetic-other");
  assert.ok(member);
  const removal = await call(`/admin/people/${member.id}/remove`, { method: "POST" });
  assert.equal(removal.status, 200, await removal.clone().text());
  const requestCount = requests.length;
  const inactiveRun = await automationCall(`/automations/${memberAutomation.id}/run`, {
    method: "POST",
    headers: foreignHeaders,
  });
  assert.equal(inactiveRun.status, 401);
  assert.equal(requests.length, requestCount);
  t.mock.timers.reset();
});

beforeTests(async () => {
  const command = "~/.local/bin/heavy -- bash grogu/protected/test-http-isolated.sh";
  assert.equal(
    process.env.OPENCLAW_PROTECTED_ISOLATED_TEST,
    "1",
    `Run this fixture with: ${command}`,
  );
  const denied = await new Promise<boolean>((resolve) => {
    const socket = connectSocket({ host: "198.51.100.1", port: 443 });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EPERM" || error.code === "EACCES");
    });
  });
  assert.ok(denied, `Native network isolation was not verified. Run: ${command}`);
});

const protectedTestStateDirs = new Set<string>();
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalProtectedKeyFile = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
const sqliteEncryptionStateDir =
  originalOpenClawStateDir ?? path.resolve(".artifacts", `protected-http-${randomUUID()}`);
const sqliteEncryptionKeyFile = `${sqliteEncryptionStateDir}.protected-storage-key`;
beforeTests(async () => {
  await mkdir(sqliteEncryptionStateDir, { recursive: true, mode: 0o700 });
  await writeFile(sqliteEncryptionKeyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  process.env.OPENCLAW_STATE_DIR = sqliteEncryptionStateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = sqliteEncryptionKeyFile;
});
after(async () => {
  await Promise.all(
    [...protectedTestStateDirs].map(async (stateDir) => {
      await rm(stateDir, { recursive: true, force: true });
    }),
  );
  await rm(sqliteEncryptionKeyFile, { force: true });
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    await rm(sqliteEncryptionStateDir, { recursive: true, force: true });
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalProtectedKeyFile === undefined) {
    delete process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
  } else {
    process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = originalProtectedKeyFile;
  }
});

function providerSse(events: Array<{ type: string; [field: string]: unknown }>, named = false) {
  return new Response(
    events
      .map((event) => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesReply(
  text: string,
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = {
    input_tokens: 3,
    output_tokens: 1,
    total_tokens: 4,
  },
  summary?: string,
) {
  const content = { type: "output_text", text, annotations: [] };
  const message = { type: "message", id: "msg_family", role: "assistant", content: [content] };
  const part = { type: "summary_text", text: summary ?? "" };
  const reasoning = { type: "reasoning", id: "rs_family", summary: [part] };
  const at = summary === undefined ? 0 : 1;
  return providerSse([
    ...(summary === undefined
      ? []
      : [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...reasoning, summary: [] },
          },
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_family",
            output_index: 0,
            summary_index: 0,
            part: { ...part, text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_family",
            output_index: 0,
            summary_index: 0,
            delta: summary,
          },
          {
            type: "response.reasoning_summary_text.done",
            item_id: "rs_family",
            output_index: 0,
            summary_index: 0,
            text: summary,
          },
          {
            type: "response.reasoning_summary_part.done",
            item_id: "rs_family",
            output_index: 0,
            summary_index: 0,
            part,
          },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
        ]),
    { type: "response.output_item.added", output_index: at, item: { ...message, content: [] } },
    {
      type: "response.content_part.added",
      output_index: at,
      content_index: 0,
      part: { ...content, text: "" },
    },
    { type: "response.output_text.delta", output_index: at, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: at, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_family",
        status: "completed",
        output: [...(summary === undefined ? [] : [reasoning]), message],
        ...(usage ? { usage } : {}),
      },
    },
  ]);
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

void test("protected responses use neutral service wording", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-copy-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const origin = "https://client.example";
  const expiresAt = Date.now() + 120_000;
  const app = createProtectedHttp({
    origin,
    stateDir,
    accessIssuer: "https://identity.example",
    directory: { issuer: "https://identity.example", allowedSubjects: ["synthetic-copy-user"] },
    usersRoot: await root(stateDir),
    verifyIdentity: async () => ({
      issuer: "https://identity.example",
      subject: "synthetic-copy-user",
      kind: "human",
      sessionId: "synthetic-copy-session",
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 1,
    maxFileBytes: 1024,
    turns: {
      models: [],
      async run() {},
      async steer() {
        assert.fail("Steering is not used by this fixture.");
      },
    },
  });
  t.after(() => app.shutdown());
  const response = await app.fetch(
    new Request(`${origin}/api/protected/v1/me`, {
      headers: { "x-alcove-capabilities": "profile-v1" },
    }),
  );
  assert.equal(response.status, 200);
  const { user, disclosure } = await response.json();
  assert.equal(user.displayName, "");
  assert.equal(user.setupRequired, true);
  assert.equal(
    disclosure,
    "Encrypted on Grogu's server. The server admin can read your chats. Your chats and generated files are stored on the server until you delete them, with no backups, so a disk failure can lose your history. The server records your last app activity, including automatic refreshes, and keeps daily message counts, token totals, model names, and error counts for up to 90 days. The server uses personal provider credentials only for the current request. Agents can search the public web through DuckDuckGo, which receives the search words, and can fetch public URLs.",
  );
  const memoryCapability = await app.fetch(
    new Request(`${origin}/api/protected/v1/me`, {
      headers: { "x-alcove-capabilities": "profile-v1,memory-v1" },
    }),
  );
  assert.deepEqual((await memoryCapability.json()).capabilities.memory, { review: false });
  const unavailableMemory = await app.fetch(
    new Request(`${origin}/api/protected/v1/memory`, {
      headers: { "x-grogu-profile": user.id },
    }),
  );
  assert.equal(unavailableMemory.status, 503);
  for (const route of ["/providers/github-copilot/connect", "/providers/openai/renew"]) {
    const result = await app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        method: "POST",
        headers: { origin, "x-grogu-profile": user.id },
      }),
    );
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.message, "This provider connection is not enabled.");
  }
  const failures = [
    new FailoverError("synthetic", { reason: "auth", provider: "sparky" }),
    Object.assign(new Error("synthetic"), { code: "ENOSPC" }),
    Object.assign(new Error("synthetic"), { code: "too-large" }),
  ];
  assert.deepEqual(
    failures.map((failure) => publicError(failure).message),
    [
      "Sparky did not accept the service key. Choose another model, or ask the server operator to check Sparky.",
      "The service could not save because storage is full.",
      "A file exceeds the file size limit.",
    ],
  );
});

void test("member memory review reads only the current member's encrypted notes", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-memory-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const memberMemory = createProtectedMemberMemory();
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://identity.example",
    stateDir,
    usersRoot,
    encryption,
    memoryReview: createProtectedMemoryReview(),
    memberMemory,
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    verifyIdentity: async (request) => ({
      issuer: "https://identity.example",
      subject: request.headers.get("cookie")!,
      kind: "human",
      sessionId: createHash("sha256").update(request.headers.get("cookie")!).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    storageLimits: { userBytes: 1_000_000, globalBytes: 2_000_000, freeFloorBytes: 1 },
    turns: {
      models: [],
      async run() {},
      async steer() {
        assert.fail("This fixture does not steer turns.");
      },
    },
  });
  t.after(() => app.shutdown());
  const call = (
    user: string,
    route: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) =>
    app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        method,
        headers: { origin, cookie: user, ...headers },
      }),
    );
  const legacyMe = await (await call("alice", "/me")).json();
  assert.equal(legacyMe.capabilities.memory, undefined);
  const meResponse = await call("alice", "/me", {
    "x-alcove-capabilities": "profile-v1,memory-v1",
  });
  assert.equal(meResponse.status, 200, await meResponse.clone().text());
  const me = await meResponse.json();
  assert.deepEqual(me.capabilities.memory, { review: true });
  const bob = (await (await call("bob", "/me")).json()).user;
  const owned = await createAuthorizedUserFiles({
    usersRoot,
    profileId: me.user.id,
    assertCurrent() {},
    maxBytes: 64_000,
    encryption,
  });
  t.after(() => owned.dispose());
  const bobOwned = await createAuthorizedUserFiles({
    usersRoot,
    profileId: bob.id,
    assertCurrent() {},
    maxBytes: 64_000,
    encryption,
  });
  t.after(() => bobOwned.dispose());
  await bobOwned.write("member-memory/memory/bob.md", "Bob's synthetic memory.");
  const content = `Synthetic private memory: ${"x".repeat(13_000)}`;
  await owned.write("member-memory/memory/2026-01-01.md", content);
  const aliceHeaders = { "x-grogu-profile": me.user.id };
  const list = await (await call("alice", "/memory", aliceHeaders)).json();
  assert.ok(Value.Check(ProtectedMemoryListResponseSchema, list));
  assert.equal(list.notes.length, 1);
  const note = list.notes[0];
  assert.ok(note);
  const read = await (await call("alice", `/memory/${note.id}`, aliceHeaders)).json();
  assert.ok(Value.Check(ProtectedMemoryReadResponseSchema, read));
  assert.equal(read.text, content);
  const bobHeaders = { "x-grogu-profile": bob.id };
  assert.equal((await (await call("bob", "/memory", bobHeaders)).json()).notes.length, 1);
  assert.equal((await call("bob", `/memory/${note.id}`, bobHeaders)).status, 404);
  assert.equal((await call("bob", "/memory", aliceHeaders)).status, 403);

  await owned.write("member-memory/memory/other.md", "A different synthetic memory.");
  await owned.write("chats/synthetic/keep.txt", "Keep this chat file.");
  const v2Headers = { ...aliceHeaders, "x-alcove-capabilities": "memory-v2" };
  const v2Me = await (await call("alice", "/me", v2Headers)).json();
  assert.deepEqual(v2Me.capabilities.memory, { review: true, delete: true });
  const v2Read = await (await call("alice", `/memory/${note.id}`, v2Headers)).json();
  assert.match(v2Read.revision, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await call("alice", `/memory/${note.id}`, v2Headers, "DELETE")).status, 428);
  assert.equal(
    (
      await call(
        "alice",
        `/memory/${note.id}`,
        { ...v2Headers, origin: "https://untrusted.example", "if-match": v2Read.revision },
        "DELETE",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "bob",
        `/memory/${note.id}`,
        {
          ...bobHeaders,
          "x-alcove-capabilities": "memory-v2",
          "if-match": v2Read.revision,
        },
        "DELETE",
      )
    ).status,
    404,
  );
  await owned.write("member-memory/memory/2026-01-01.md", `${content}\nNewer memory.`);
  const stale = await call(
    "alice",
    `/memory/${note.id}`,
    { ...v2Headers, "if-match": v2Read.revision },
    "DELETE",
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "memory_changed");
  const fresh = await (await call("alice", `/memory/${note.id}`, v2Headers)).json();
  assert.equal(
    (
      await call(
        "alice",
        `/memory/${note.id}`,
        { ...v2Headers, "if-match": fresh.revision },
        "DELETE",
      )
    ).status,
    204,
  );
  assert.equal(
    await owned.readText("member-memory/memory/other.md"),
    "A different synthetic memory.",
  );
  assert.equal(await owned.readText("chats/synthetic/keep.txt"), "Keep this chat file.");
  assert.equal(await bobOwned.readText("member-memory/memory/bob.md"), "Bob's synthetic memory.");
  assert.equal((await call("alice", `/memory/${note.id}`, v2Headers)).status, 404);
  await owned.write("member-memory/memory/legacy.md", Buffer.from([0xff]));
  const updatedList = await (await call("alice", "/memory", v2Headers)).json();
  const legacy = updatedList.notes.find(
    (entry: { name: string }) => entry.name === "memory/legacy.md",
  );
  assert.ok(legacy);
  const legacyRead = await (await call("alice", `/memory/${legacy.id}`, v2Headers)).json();
  await owned.write("member-memory/memory/legacy.md", Buffer.from([0xfe]));
  const changedBytes = await call(
    "alice",
    `/memory/${legacy.id}`,
    { ...v2Headers, "if-match": legacyRead.revision },
    "DELETE",
  );
  assert.equal(changedBytes.status, 409);
});

void test("member memory follows the authenticated member across protected chats", async (t) => {
  await exerciseMemberMemoryBoundary(t, "cross-chat");
});

void test("a failed member memory flush stops overflow compaction", async (t) => {
  await exerciseMemberMemoryBoundary(t, "overflow-failure");
});

void test("in-turn compaction flushes member memory before summarizing", async (t) => {
  await exerciseMemberMemoryBoundary(t, "threshold");
});

async function exerciseMemberMemoryBoundary(
  t: TestContext,
  scenario: "cross-chat" | "overflow-failure" | "threshold",
) {
  const stateRoot = process.env.OPENCLAW_STATE_DIR;
  assert.ok(
    stateRoot &&
      path.relative(path.resolve(".artifacts"), stateRoot).startsWith("protected-proof-"),
  );
  const stateDir = path.join(stateRoot, scenario);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    process.env.OPENCLAW_STATE_DIR = stateRoot;
  });
  protectedTestStateDirs.add(stateDir);
  const usersDir = path.join(stateDir, "users");
  const workspaceDir = path.join(stateDir, "workspace");
  const agentDir = path.join(stateDir, "agents", "protected", "agent");
  await Promise.all(
    [usersDir, workspaceDir, agentDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  await prepareProtectedSharedState(stateDir, () => {});
  await writeFile(path.join(workspaceDir, "MEMORY.md"), "Synthetic forbidden workspace memory.");
  const requests: Array<{
    messages: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function: { name: string } }>;
    authorization?: string;
  }> = [];
  let failFlush = false;
  let failOverflowFlush = false;
  let failThresholdFlush = false;
  let overflowThresholdFlush = false;
  let overflowPending = false;
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ ...body, authorization: request.headers.authorization });
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const last = messages.at(-1);
      const prompt = messages.toReversed().find((message) => message.role === "user")?.content;
      const command = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      const isFlush = command.includes("Pre-compaction memory flush");
      const isSummary = messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("context summarization assistant"),
      );
      if (
        overflowThresholdFlush &&
        isFlush &&
        JSON.stringify(messages).includes("Trigger threshold flush overflow")
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 32000 tokens. However, your messages resulted in 33000 tokens.",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
        );
        return;
      }
      if (overflowPending && command.includes("Trigger overflow") && !isFlush && !isSummary) {
        overflowPending = false;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 32000 tokens. However, your messages resulted in 33000 tokens.",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
        );
        return;
      }
      const tool = isFlush
        ? {
            name: "memory_store",
            arguments: JSON.stringify({
              content:
                failFlush ||
                (failOverflowFlush &&
                  JSON.stringify(messages).includes("Trigger overflow failure")) ||
                (failThresholdFlush &&
                  JSON.stringify(messages).includes("Trigger threshold failure"))
                  ? " "
                  : JSON.stringify(messages).includes("Trigger overflow")
                    ? "Synthetic in-turn compaction memory"
                    : "Synthetic flush preserved memory",
            }),
          }
        : command.includes("Remember")
          ? {
              name: "memory_store",
              arguments: JSON.stringify({ content: "Synthetic blue lighthouse preference" }),
            }
          : command.includes("Read")
            ? {
                name: "memory_get",
                arguments: JSON.stringify({
                  path: command.slice(command.indexOf("Read ") + 5).split(/\s/u)[0],
                }),
              }
            : {
                name: "memory_search",
                arguments: JSON.stringify({
                  query: command.includes("forbidden") ? "forbidden workspace" : "lighthouse",
                }),
              };
      const delta = isSummary
        ? { role: "assistant", content: "Synthetic conversation summary." }
        : last?.role === "tool"
          ? { role: "assistant", content: isFlush ? "NO_REPLY" : JSON.stringify(last.content) }
          : {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "memory-call", type: "function", function: tool },
                ...(command.includes("Remember and inspect my automations")
                  ? [
                      {
                        index: 1,
                        id: "automation-call",
                        type: "function",
                        function: { name: "automations_list", arguments: "{}" },
                      },
                    ]
                  : []),
                ...(command.includes("Recall in authoring")
                  ? [
                      {
                        index: 1,
                        id: "authoring-call",
                        type: "function",
                        function: { name: "automation_draft_read", arguments: "{}" },
                      },
                    ]
                  : []),
              ],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: isSummary || last?.role === "tool" ? "stop" : "tool_calls",
            },
          ],
          ...(command.includes("Trigger threshold") && last?.role === "tool" && !isFlush
            ? { usage: { prompt_tokens: 31_999, completion_tokens: 1, total_tokens: 32_000 } }
            : {}),
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch(() => response.destroy());
  });
  const providerOrigin = await listen(provider);
  t.after(() => close(provider));
  const serviceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const base = protectedOpenClawConfig(stateDir, serviceRoot);
  const config: OpenClawConfig = {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        compaction: { keepRecentTokens: 128, memoryFlush: { forceFlushTranscriptBytes: 1 } },
      },
      entries: {
        protected: { workspace: workspaceDir, agentDir, memory: { search: { enabled: false } } },
      },
    },
    models: {
      mode: "replace",
      providers: {
        sparky: {
          baseUrl: `${providerOrigin}/v1`,
          api: "openai-completions",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "synthetic",
              name: "Synthetic",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 300_000;
  const memory = createProtectedMemberMemory();
  const { publishConfiguredModelRuntimeSnapshots } =
    await import("../../src/gateway/server-startup-model-runtime.js");
  await publishConfiguredModelRuntimeSnapshots({ cfg: config, workspaceDir });
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://synthetic.example",
    stateDir,
    usersRoot: await root(usersDir),
    encryption,
    memberMemory: memory,
    memoryReview: createProtectedMemoryReview(),
    maxChatsPerUser: 4,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 16_000_000, userBytes: 8_000_000, freeFloorBytes: 1 },
    directory: { issuer: "https://synthetic.example", allowedSubjects: ["alice", "bob"] },
    verifyIdentity: async (request) => {
      const subject = request.headers.get("cookie")!;
      return {
        issuer: "https://synthetic.example",
        subject,
        kind: "human",
        expiresAt,
        sessionId: createHash("sha256").update(subject).digest("hex"),
        assertCurrent() {},
        async revalidate() {},
      };
    },
    turns: createCanonicalProtectedTurns({
      config,
      workspaceDir,
      agentDir,
      memberMemory: memory,
      models: [
        {
          provider: "sparky",
          id: "synthetic",
          label: "Synthetic",
          thinking: { levels: ["low", "medium", "ultra"], default: "ultra" },
        },
      ],
      resolveSparkyKey: async () => "synthetic-request-only-key",
    }),
  });
  const server = createProtectedServer(origin, app.fetch);
  const url = await listen(server);
  t.after(() => closeProtectedServer(server, app, stateDir));
  const call = (user: string, route: string, init?: RequestInit) =>
    fetch(`${url}/api/protected/v1${route}`, {
      ...init,
      headers: { origin, cookie: user, "content-type": "application/json", ...init?.headers },
    });
  const alice = (await (await call("alice", "/me")).json()).user;
  const chat = async (user: string, selectedAgentId: string) => {
    const response = await call(user, "/chats", {
      method: "POST",
      body: JSON.stringify({ selectedAgentId }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).chat.id as string;
  };
  const turn = async (
    user: string,
    profileId: string,
    id: string,
    text: string,
    expectFailure = false,
    automationsChat = false,
  ) => {
    const response = await call(user, `/chats/${id}/turns`, {
      method: "POST",
      headers: {
        "x-grogu-profile": profileId,
        ...(automationsChat ? { "x-alcove-capabilities": "automations-chat-v1" } : {}),
      },
      body: JSON.stringify({ provider: "sparky", text }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const events = await response.text();
    assert.match(
      events,
      expectFailure ? /"type":"error".*"code":"unavailable"/u : /"type":"done"/u,
      events,
    );
    return events;
  };
  const aliceGrogu = await chat("alice", "grogu");
  if (scenario === "overflow-failure") {
    await turn("alice", alice.id, aliceGrogu, "Remember my lighthouse preference");
    const beforeFailedOverflow = requests.length;
    failOverflowFlush = true;
    overflowPending = true;
    await turn("alice", alice.id, aliceGrogu, "Trigger overflow failure", true);
    const failedRequests = requests.slice(beforeFailedOverflow);
    assert.ok(
      failedRequests.some((request) => {
        const messages = JSON.stringify(request.messages);
        return (
          messages.includes("Pre-compaction memory flush") &&
          messages.includes("Trigger overflow failure")
        );
      }),
      "the failed overflow must attempt to save the current conversation",
    );
    assert.ok(
      failedRequests.every(
        (request) => !JSON.stringify(request.messages).includes("context summarization assistant"),
      ),
      "a failed member flush must prevent compaction",
    );
    return;
  }
  if (scenario === "threshold") {
    await turn("alice", alice.id, aliceGrogu, "Remember my lighthouse preference");
    const beforeThreshold = requests.length;
    await turn("alice", alice.id, aliceGrogu, "Trigger threshold");
    const thresholdRequests = requests.slice(beforeThreshold);
    const summaryIndex = thresholdRequests.findIndex((request) =>
      JSON.stringify(request.messages).includes("context summarization assistant"),
    );
    assert.notEqual(summaryIndex, -1, "the turn must reach in-turn compaction");
    assert.equal(
      thresholdRequests[summaryIndex].authorization,
      "Bearer synthetic-request-only-key",
    );
    assert.ok(
      thresholdRequests.slice(0, summaryIndex).some((request) => {
        const messages = JSON.stringify(request.messages);
        return (
          messages.includes("Pre-compaction memory flush") && messages.includes("Trigger threshold")
        );
      }),
      "in-turn compaction must flush the current conversation first",
    );
    failThresholdFlush = true;
    const beforeFailure = requests.length;
    await turn("alice", alice.id, aliceGrogu, "Trigger threshold failure");
    const failureRequests = requests.slice(beforeFailure);
    assert.ok(
      failureRequests.some((request) => {
        const messages = JSON.stringify(request.messages);
        return (
          messages.includes("Pre-compaction memory flush") &&
          messages.includes("Trigger threshold failure")
        );
      }),
    );
    assert.ok(
      failureRequests.every(
        (request) => !JSON.stringify(request.messages).includes("context summarization assistant"),
      ),
      "a failed in-turn flush must prevent compaction",
    );
    failThresholdFlush = false;
    overflowThresholdFlush = true;
    const beforeFlushOverflow = requests.length;
    await turn("alice", alice.id, aliceGrogu, "Trigger threshold flush overflow");
    const flushOverflowRequests = requests.slice(beforeFlushOverflow);
    const failedFlushIndex = flushOverflowRequests.findIndex((request) => {
      const messages = JSON.stringify(request.messages);
      return (
        messages.includes("Pre-compaction memory flush") &&
        messages.includes("Trigger threshold flush overflow")
      );
    });
    assert.notEqual(
      failedFlushIndex,
      -1,
      "the current conversation must reach the overflowing flush",
    );
    assert.ok(
      flushOverflowRequests
        .slice(failedFlushIndex)
        .every(
          (request) =>
            !JSON.stringify(request.messages).includes("context summarization assistant"),
        ),
      "an overflowing member flush must not compact its detached snapshot",
    );
    assert.doesNotMatch(JSON.stringify(requests), /Synthetic forbidden workspace memory/u);
    return;
  }
  const bob = (await (await call("bob", "/me")).json()).user;
  const aliceTravel = await chat("alice", "travel");
  const bobGrogu = await chat("bob", "grogu");
  const bobTravel = await chat("bob", "travel");
  const automationCatalogResponse = await call("alice", "/automations/catalog", {
    headers: {
      "x-grogu-profile": alice.id,
      "x-alcove-capabilities": "automations-chat-v1",
    },
  });
  assert.equal(
    automationCatalogResponse.status,
    200,
    await automationCatalogResponse.clone().text(),
  );
  const automationCatalog = await automationCatalogResponse.json();
  assert.equal(automationCatalog.capabilities.automations.chat?.list, true);
  const beforeCombined = requests.length;
  await turn("alice", alice.id, aliceGrogu, "Remember and inspect my automations", false, true);
  const combinedRequests = requests.slice(beforeCombined);
  const toolSets = combinedRequests.map((request) =>
    (request.tools ?? []).map((tool) => tool.function.name),
  );
  assert.ok(
    toolSets.some((names) => names.includes("memory_store") && names.includes("automations_list")),
    JSON.stringify(toolSets),
  );
  const toolOutputs = combinedRequests.flatMap((request) =>
    request.messages.flatMap((message) =>
      message.role === "tool" && typeof message.content === "string"
        ? [JSON.parse(message.content)]
        : [],
    ),
  );
  assert.ok(toolOutputs.some((output) => output.writeApplied === false));
  const authoringCapabilities = "automations-chat-v1, automations-authoring-v1";
  const authoringResponse = await call("alice", "/automations/authoring", {
    method: "POST",
    headers: {
      "x-grogu-profile": alice.id,
      "x-alcove-capabilities": authoringCapabilities,
    },
  });
  assert.equal(authoringResponse.status, 201, await authoringResponse.clone().text());
  const authoringChat = (await authoringResponse.json()).chat;
  const beforeAuthoring = requests.length;
  const authoringTurn = await call("alice", `/chats/${authoringChat.id}/turns`, {
    method: "POST",
    headers: {
      "x-grogu-profile": alice.id,
      "x-alcove-capabilities": authoringCapabilities,
    },
    body: JSON.stringify({
      provider: "sparky",
      text: "Recall in authoring",
      authoring: {
        draftRevision: "1",
        draft: {
          name: "Synthetic authoring draft",
          instructions: "Summarize public project updates.",
          whenToNotify: "Only when there is a meaningful update.",
          agentId: "travel",
          model: { provider: "sparky", id: "synthetic" },
          thinking: "low",
          schedule: { kind: "every", everyMs: 60_000 },
        },
      },
    }),
  });
  assert.equal(authoringTurn.status, 200, await authoringTurn.clone().text());
  assert.match(await authoringTurn.text(), /"type":"done"/u);
  const authoringRequests = requests.slice(beforeAuthoring);
  assert.ok(
    authoringRequests.some((request) => {
      const names = new Set((request.tools ?? []).map((tool) => tool.function.name));
      return names.has("memory_search") && names.has("automation_draft_read");
    }),
    "authoring must offer both member memory and draft tools",
  );
  const authoringOutputs = authoringRequests.flatMap((request) =>
    request.messages
      .filter((message) => message.role === "tool" && typeof message.content === "string")
      .map((message) => message.content),
  );
  assert.match(JSON.stringify(authoringOutputs), /Synthetic blue lighthouse preference/u);
  assert.match(JSON.stringify(authoringOutputs), /Synthetic authoring draft/u);
  await turn("alice", alice.id, aliceGrogu, "Recall lighthouse");
  const list = await (
    await call("alice", "/memory", { headers: { "x-grogu-profile": alice.id } })
  ).json();
  assert.equal(list.notes.length, 1);
  assert.match(
    await turn("alice", alice.id, aliceTravel, "Recall lighthouse"),
    /Synthetic blue lighthouse preference/u,
  );
  const bobSearch = await turn("bob", bob.id, bobGrogu, "Recall lighthouse");
  assert.match(bobSearch, /results/u);
  assert.doesNotMatch(bobSearch, /Synthetic blue lighthouse preference/u);
  const bobRead = await turn("bob", bob.id, bobTravel, `Read ${list.notes[0].name}`);
  assert.match(bobRead, /not_found/u);
  assert.doesNotMatch(bobRead, /Synthetic blue lighthouse preference/u);
  const note = await (
    await call("alice", `/memory/${list.notes[0].id}`, { headers: { "x-grogu-profile": alice.id } })
  ).json();
  assert.match(note.text, /Synthetic blue lighthouse preference/u);
  assert.match(note.text, /Synthetic flush preserved memory/u);
  const ciphertext = await readFile(
    path.join(
      usersDir,
      authorizedUserFilesDirectory(alice.id),
      "member-memory",
      list.notes[0].name,
    ),
  );
  assert.equal(isStorageValueEncrypted(ciphertext), true);
  assert.equal(ciphertext.includes("Synthetic blue lighthouse preference"), false);
  assert.deepEqual(
    (await (await call("bob", "/memory", { headers: { "x-grogu-profile": bob.id } })).json()).notes,
    [],
  );
  assert.equal(
    (await call("bob", `/memory/${list.notes[0].id}`, { headers: { "x-grogu-profile": bob.id } }))
      .status,
    404,
  );
  assert.doesNotMatch(
    await turn("bob", bob.id, bobTravel, "Recall forbidden workspace"),
    /Synthetic forbidden workspace memory/u,
  );
  assert.equal(
    (
      await call("bob", `/chats/${aliceGrogu}/turns`, {
        method: "POST",
        headers: { "x-grogu-profile": alice.id },
        body: JSON.stringify({ provider: "sparky", text: "Recall lighthouse" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("bob", "/memory", { headers: { "x-grogu-profile": alice.id } })).status,
    403,
  );
  const beforeOverflow = requests.length;
  overflowPending = true;
  await turn("alice", alice.id, aliceGrogu, "Trigger overflow");
  const overflowRequests = requests.slice(beforeOverflow);
  const summaryIndex = overflowRequests.findIndex((request) =>
    JSON.stringify(request.messages).includes("context summarization assistant"),
  );
  assert.notEqual(summaryIndex, -1, "the overflow must reach native compaction");
  assert.equal(overflowRequests[summaryIndex].authorization, "Bearer synthetic-request-only-key");
  assert.ok(
    overflowRequests.slice(0, summaryIndex).some((request) => {
      const messages = JSON.stringify(request.messages);
      return (
        messages.includes("Pre-compaction memory flush") && messages.includes("Trigger overflow")
      );
    }),
    "native compaction must flush the current member conversation first",
  );
  assert.ok(
    requests.some((request) =>
      request.tools?.some((tool) => tool.function.name === "memory_store"),
    ),
  );
  const failureChat = await chat("alice", "grogu");
  await turn("alice", alice.id, failureChat, "Recall lighthouse");
  failFlush = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    await turn("alice", alice.id, failureChat, "Recall lighthouse", true);
  }
  failFlush = false;
  await turn("alice", alice.id, failureChat, "Recall lighthouse");
  const notePath = path.join(
    usersDir,
    authorizedUserFilesDirectory(alice.id),
    "member-memory",
    list.notes[0].name,
  );
  const beforeRevocation = await readFile(notePath);
  assert.equal(await app.revokeProfile(alice.id), true);
  assert.notEqual(
    (await call("alice", "/memory", { headers: { "x-grogu-profile": alice.id } })).status,
    200,
  );
  assert.deepEqual(await readFile(notePath), beforeRevocation);
  assert.doesNotMatch(JSON.stringify(requests), /Synthetic forbidden workspace memory/u);
}

void test("deleting another member's chat frees quota for a running turn", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-quota-http-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  t.after(() => proceed.resolve());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://identity.example",
    stateDir,
    usersRoot: await root(stateDir),
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    verifyIdentity: async (request) => ({
      issuer: "https://identity.example",
      subject: request.headers.get("cookie")!,
      kind: "human",
      sessionId: createHash("sha256").update(request.headers.get("cookie")!).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 60_000,
    storageLimits: { globalBytes: 130_000, userBytes: 130_000, freeFloorBytes: 1 },
    turns: {
      models: [{ provider: "anthropic", id: "synthetic", label: "Synthetic only" }],
      async run(turn) {
        started.resolve();
        await proceed.promise;
        try {
          await turn.files.write(`chats/${turn.id}/output.txt`, "x".repeat(55_000));
          written.resolve();
        } catch (error) {
          written.reject(error);
          throw error;
        }
      },
      async steer() {
        assert.fail("Steering is not used by this fixture.");
      },
    },
  });
  t.after(() => app.shutdown());
  const call = (user: string, route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", user);
    headers.set("content-type", "application/json");
    return app.fetch(new Request(`${origin}/api/protected/v1${route}`, { ...init, headers }));
  };
  const alice = (await (await call("alice", "/me")).json()).user;
  const createChat = async (user: string) => {
    const response = await call(user, "/chats", { method: "POST", body: "{}" });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.chat;
  };
  const aliceChat = await createChat("alice");
  const bobChat = await createChat("bob");
  const running = await call("alice", `/chats/${aliceChat.id}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": alice.id },
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  });
  assert.equal(running.status, 200);
  await started.promise;
  const deleted = await call("bob", `/chats/${bobChat.id}`, {
    method: "DELETE",
    headers: { "if-match": bobChat.version },
  });
  assert.equal(deleted.status, 204);
  proceed.resolve();
  await written.promise;
  await running.text();
});

void test("side chats fork their parent, stay hidden without negotiation, and are deleted with it", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-side-chats-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  // Sending a reply to the main chat writes through the process-wide state directory.
  const ambientStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    process.env.OPENCLAW_STATE_DIR = ambientStateDir;
  });
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  t.after(() => proceed.resolve());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const usersRoot = await root(stateDir);
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://identity.example",
    stateDir,
    usersRoot,
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    verifyIdentity: async (request) => ({
      issuer: "https://identity.example",
      subject: request.headers.get("cookie")!,
      kind: "human",
      sessionId: createHash("sha256").update(request.headers.get("cookie")!).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 60_000,
    storageLimits: { globalBytes: 400_000, userBytes: 200_000, freeFloorBytes: 1 },
    turns: {
      models: [{ provider: "anthropic", id: "synthetic", label: "Synthetic only" }],
      async run(turn) {
        started.resolve();
        await proceed.promise;
        await turn.delta("Done.");
      },
      async steer() {
        assert.fail("Steering is not used by this fixture.");
      },
    },
  });
  t.after(() => app.shutdown());
  const negotiated = "side-chats-v1";
  const call = (user: string, route: string, init?: RequestInit, capabilities = negotiated) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", user);
    headers.set("content-type", "application/json");
    if (capabilities) {
      headers.set("x-alcove-capabilities", capabilities);
    }
    return app.fetch(new Request(`${origin}/api/protected/v1${route}`, { ...init, headers }));
  };
  // The fixture turns write no transcript, so history is seeded through the same chat store.
  const seeder = createProtectedChats({
    stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([protectedResearchAgent]),
    usersRoot,
    maxFileBytes: 60_000,
  });
  const seed = (profileId: string, chatId: string, question: string) =>
    appendTranscriptMessages(
      { ...seeder.scope({ profileId, assertCurrent() {} }, chatId), sessionId: chatId },
      {
        messages: [
          { role: "user", content: question, timestamp: Date.now() },
          {
            role: "assistant",
            content: [{ type: "text", text: `Answer to ${question}` }],
            api: "openai-completions",
            provider: "sparky",
            model: "synthetic",
            usage: makeZeroUsageSnapshot(),
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ].map((message) => ({ message })),
      },
    );
  const profileOf = async (user: string) => (await (await call(user, "/me")).json()).user.id;
  const aliceId = await profileOf("alice");
  const bobId = await profileOf("bob");
  assert.equal((await (await call("alice", "/me")).json()).capabilities.sideChats, true);
  assert.equal(
    (await (await call("alice", "/me", {}, "")).json()).capabilities.sideChats,
    undefined,
  );

  const createChat = async (user: string) => {
    const response = await call(user, "/chats", { method: "POST", body: "{}" });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).chat as { id: string; version: string };
  };
  const startSide = (
    user: string,
    profileId: string,
    chatId: string,
    body: Record<string, unknown>,
    capabilities = negotiated,
  ) =>
    call(
      user,
      `/chats/${chatId}/side`,
      { method: "POST", headers: { "x-grogu-profile": profileId }, body: JSON.stringify(body) },
      capabilities,
    );
  const readChat = async (user: string, chatId: string, capabilities = negotiated) => {
    const response = await call(user, `/chats/${chatId}`, {}, capabilities);
    return { status: response.status, chat: (await response.json()).chat };
  };
  const listed = async (user: string, capabilities = negotiated) =>
    (await (await call(user, "/chats", {}, capabilities)).json()).chats as {
      id: string;
      side?: unknown;
    }[];

  const parent = await createChat("alice");
  const requestId = randomUUID();
  const empty = await startSide("alice", aliceId, parent.id, { requestId });
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).error.code, "side_unavailable");

  await seed(aliceId, parent.id, "Plan the trip");
  assert.equal((await startSide("alice", aliceId, parent.id, { requestId }, "")).status, 404);
  assert.equal((await startSide("alice", aliceId, parent.id, {})).status, 400);
  assert.equal((await startSide("alice", bobId, parent.id, { requestId })).status, 403);
  assert.equal((await startSide("bob", bobId, parent.id, { requestId })).status, 404);

  const created = await startSide("alice", aliceId, parent.id, { requestId, title: "Detour" });
  assert.equal(created.status, 201);
  const sideChat = (await created.json()).chat;
  assert.equal(sideChat.title, "Detour");
  assert.equal(sideChat.side.parentId, parent.id);
  assert.equal(sideChat.side.forkedAt.messageCount, 2);
  const replayed = await startSide("alice", aliceId, parent.id, { requestId, title: "Detour" });
  assert.equal(replayed.status, 201);
  assert.equal((await replayed.json()).chat.id, sideChat.id);

  const read = await readChat("alice", sideChat.id);
  assert.equal(read.chat.side.parentId, parent.id);
  assert.deepEqual(read.chat.messages, []);
  assert.equal((await readChat("alice", sideChat.id, "")).chat.side, undefined);
  assert.deepEqual(
    (await listed("alice")).map(({ id }) => id).toSorted(),
    [parent.id, sideChat.id].toSorted(),
  );
  const legacyList = await listed("alice", "");
  assert.deepEqual(
    legacyList.map(({ id }) => id),
    [parent.id],
  );
  assert.equal(legacyList[0]?.side, undefined);
  const artifactsOf = (chatId: string, capabilities = negotiated) =>
    call(
      "alice",
      `/chats/${chatId}/artifacts`,
      { headers: { "x-grogu-profile": aliceId } },
      capabilities,
    );
  assert.equal((await artifactsOf(sideChat.id)).status, 200);
  assert.equal((await artifactsOf(sideChat.id, "")).status, 404);
  assert.equal((await artifactsOf(parent.id, "")).status, 200);

  // Sending a side reply to the main chat needs the negotiation, a profile and a finished side reply.
  await seed(aliceId, sideChat.id, "Side question");
  const sideReply = (await readChat("alice", sideChat.id)).chat.messages.find(
    (message: { role: string }) => message.role === "assistant",
  );
  const sendBack = (
    user: string,
    profileId: string,
    chatId: string,
    body: Record<string, unknown>,
    capabilities = negotiated,
  ) =>
    call(
      user,
      `/chats/${chatId}/side/return`,
      { method: "POST", headers: { "x-grogu-profile": profileId }, body: JSON.stringify(body) },
      capabilities,
    );
  const sendRequest = { requestId: randomUUID(), messageIds: [sideReply.id], note: "Use this" };
  assert.equal((await sendBack("alice", aliceId, sideChat.id, sendRequest, "")).status, 404);
  assert.equal((await sendBack("alice", bobId, sideChat.id, sendRequest)).status, 403);
  assert.equal((await sendBack("bob", bobId, sideChat.id, sendRequest)).status, 404);
  assert.equal(
    (await sendBack("alice", aliceId, sideChat.id, { requestId: sendRequest.requestId })).status,
    400,
  );
  assert.equal(
    (
      await sendBack("alice", aliceId, sideChat.id, {
        ...sendRequest,
        messageIds: [sideReply.id, randomUUID(), randomUUID(), randomUUID()],
      })
    ).status,
    400,
  );
  const notSide = await sendBack("alice", aliceId, parent.id, sendRequest);
  assert.equal(notSide.status, 422);
  assert.equal((await notSide.json()).error.code, "side_unavailable");
  const sent = await sendBack("alice", aliceId, sideChat.id, sendRequest);
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.equal(sentBody.parent.id, parent.id);
  assert.deepEqual(sentBody.message.sideNote, { chatId: sideChat.id, title: "Detour" });
  assert.equal(sentBody.message.text, "Use this\n\nAnswer to Side question");
  const returned = (await readChat("alice", parent.id)).chat;
  assert.equal(returned.version, sentBody.parent.version);
  assert.deepEqual(returned.messages.at(-1), sentBody.message);
  assert.equal((await readChat("alice", parent.id, "")).chat.messages.at(-1).sideNote, undefined);
  const resent = await sendBack("alice", aliceId, sideChat.id, sendRequest);
  assert.equal(resent.status, 200);
  assert.deepEqual((await resent.json()).message, sentBody.message);
  assert.equal((await readChat("alice", parent.id)).chat.messages.length, returned.messages.length);

  // A side chat's own side chat branches from the same parent; the third chat fills the budget.
  const second = await startSide("alice", aliceId, sideChat.id, { requestId: randomUUID() });
  assert.equal(second.status, 201);
  const secondChat = (await second.json()).chat;
  assert.equal(secondChat.side.parentId, parent.id);
  const full = await startSide("alice", aliceId, parent.id, { requestId: randomUUID() });
  assert.equal(full.status, 413);
  assert.equal((await full.json()).error.code, "quota_exceeded");

  // Deleting the parent waits while any of its side chats is running.
  const running = await call("alice", `/chats/${secondChat.id}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": aliceId },
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  });
  assert.equal(running.status, 200);
  await started.promise;
  const busy = await call("alice", `/chats/${parent.id}`, {
    method: "DELETE",
    headers: { "if-match": (await readChat("alice", parent.id)).chat.version },
  });
  assert.equal(busy.status, 409);
  assert.equal((await readChat("alice", sideChat.id)).status, 200);

  // The main chat takes no new reply while it is running.
  const parentRun = await call("alice", `/chats/${parent.id}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": aliceId },
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  });
  assert.equal(parentRun.status, 200);
  const busySend = await sendBack("alice", aliceId, sideChat.id, {
    requestId: randomUUID(),
    messageIds: [sideReply.id],
  });
  assert.equal(busySend.status, 409);
  assert.equal((await busySend.json()).error.code, "busy");
  proceed.resolve();
  await running.text();
  await parentRun.text();

  // Every new send is charged to the member. A full account refuses it, but a retry still answers.
  await seed(aliceId, sideChat.id, "x".repeat(10_000));
  const longReply = (await readChat("alice", sideChat.id)).chat.messages.findLast(
    (message: { role: string }) => message.role === "assistant",
  );
  const beforeSends = (await readChat("alice", parent.id)).chat.messages.length;
  let accepted = 0;
  let refused: Response | undefined;
  while (!refused && accepted < 60) {
    const next = await sendBack("alice", aliceId, sideChat.id, {
      requestId: randomUUID(),
      messageIds: [longReply.id],
    });
    if (next.status === 413) {
      refused = next;
    } else {
      assert.equal(next.status, 200);
      accepted++;
    }
  }
  assert.ok(refused, "the account never reached its storage limit");
  assert.equal((await refused.json()).error.code, "quota_exceeded");
  assert.equal((await readChat("alice", parent.id)).chat.messages.length, beforeSends + accepted);
  assert.equal((await sendBack("alice", aliceId, sideChat.id, sendRequest)).status, 200);

  const deleted = await call("alice", `/chats/${parent.id}`, {
    method: "DELETE",
    headers: { "if-match": (await readChat("alice", parent.id)).chat.version },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (await deleted.json()).deletedSideChats.toSorted(),
    [sideChat.id, secondChat.id].toSorted(),
  );
  for (const id of [parent.id, sideChat.id, secondChat.id]) {
    assert.equal((await readChat("alice", id)).status, 404);
  }

  // Clients that did not negotiate side chats keep the empty delete response; the cascade still runs.
  const legacyParent = await createChat("alice");
  await seed(aliceId, legacyParent.id, "Another plan");
  const legacySide = (
    await (await startSide("alice", aliceId, legacyParent.id, { requestId: randomUUID() })).json()
  ).chat;
  const legacyDelete = await call(
    "alice",
    `/chats/${legacyParent.id}`,
    {
      method: "DELETE",
      headers: { "if-match": (await readChat("alice", legacyParent.id)).chat.version },
    },
    "",
  );
  assert.equal(legacyDelete.status, 204);
  assert.equal((await readChat("alice", legacySide.id)).status, 404);
});

void test("the widget stream event names the earlier widget of the same title in its chat", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-widget-chain-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const usersRoot = await root(stateDir);
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://identity.example",
    stateDir,
    usersRoot,
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice"] },
    verifyIdentity: async (request) => ({
      issuer: "https://identity.example",
      subject: request.headers.get("cookie")!,
      kind: "human",
      sessionId: createHash("sha256").update(request.headers.get("cookie")!).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 60_000,
    storageLimits: { globalBytes: 400_000, userBytes: 200_000, freeFloorBytes: 1 },
    turns: {
      models: [{ provider: "anthropic", id: "synthetic", label: "Synthetic only" }],
      // Each turn saves two widgets titled with its own text, as two show_widget calls would.
      async run(turn) {
        for (let copy = 0; copy < 2; copy++) {
          const title = turn.input.text;
          const document = await createCanvasDocument(
            { title, html: "<p>x</p>" },
            { storage: { files: turn.files, directory: `chats/${turn.id}/widgets` } },
          );
          await turn.widget({ id: document.id, title });
        }
        await turn.delta("Done.");
      },
      async steer() {
        assert.fail("Steering is not used by this fixture.");
      },
    },
  });
  t.after(() => app.shutdown());
  const call = (route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", "alice");
    headers.set("content-type", "application/json");
    return app.fetch(new Request(`${origin}/api/protected/v1${route}`, { ...init, headers }));
  };
  const aliceId = (await (await call("/me")).json()).user.id;
  const { chat } = await (await call("/chats", { method: "POST", body: "{}" })).json();
  const seeder = createProtectedChats({
    stateDir,
    maxChatsPerUser: 3,
    agentCatalog: createProtectedAgentCatalog([protectedResearchAgent]),
    usersRoot,
    maxFileBytes: 60_000,
  });
  const earlier = `cv_${"a".repeat(32)}`;
  const timestamp = Date.now();
  await appendTranscriptMessages(
    { ...seeder.scope({ profileId: aliceId, assertCurrent() {} }, chat.id), sessionId: chat.id },
    {
      messages: [
        { role: "user", content: "Earlier", timestamp },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call", name: "show_widget", arguments: {} }],
          api: "openai-completions",
          provider: "sparky",
          model: "synthetic",
          usage: makeZeroUsageSnapshot(),
          stopReason: "toolUse",
          timestamp,
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "show_widget",
          content: [{ type: "text", text: "Saved" }],
          details: { kind: "canvas", view: { id: earlier }, presentation: { title: "Plan" } },
          isError: false,
          timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Shown" }],
          api: "openai-completions",
          provider: "sparky",
          model: "synthetic",
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp,
        },
      ].map((message) => ({ message })),
    },
  );
  const streamedWidgets = async (text: string) => {
    const response = await call(`/chats/${chat.id}/turns`, {
      method: "POST",
      headers: { "x-grogu-profile": aliceId },
      body: JSON.stringify({
        provider: "anthropic",
        text,
        credential: { accessToken: "synthetic-only" },
      }),
    });
    return (await response.text())
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "widget")
      .map(({ id, title, replaces }) => ({ id, title, replaces }));
  };
  const plan = await streamedWidgets("Plan");
  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.replaces, earlier, "a later turn replaces the chat's saved widget");
  assert.equal(plan[1]?.replaces, plan[0]?.id, "a widget replaces the one before it in the turn");
  const fresh = await streamedWidgets("Fresh");
  assert.equal(fresh[0]?.replaces, undefined);
  assert.equal(fresh[1]?.replaces, fresh[0]?.id);
});

void test("artifact pages expose only owned saved content through guarded reads", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-artifacts-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://identity.example",
    stateDir,
    usersRoot,
    encryption,
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    verifyIdentity: async (request) => ({
      issuer: "https://identity.example",
      subject: request.headers.get("cookie")!,
      kind: "human",
      sessionId: createHash("sha256").update(request.headers.get("cookie")!).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    turns: {
      models: [],
      async run() {},
      async steer() {
        assert.fail("This fixture does not steer turns.");
      },
    },
  });
  t.after(() => app.shutdown());
  const call = (user: string, route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", user);
    headers.set("content-type", "application/json");
    return app.fetch(new Request(`${origin}/api/protected/v1${route}`, { ...init, headers }));
  };
  const alice = (await (await call("alice", "/me")).json()).user;
  const bob = (await (await call("bob", "/me")).json()).user;
  const chatResponse = await call("alice", "/chats", {
    method: "POST",
    body: '{"title":"Synthetic chat"}',
  });
  assert.equal(chatResponse.status, 200, await chatResponse.clone().text());
  const { chat } = await chatResponse.json();
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: alice.id,
    assertCurrent() {},
    maxBytes: 64_000,
    encryption,
  });
  t.after(() => files.dispose());
  const widget = await createCanvasDocument(
    { title: "Synthetic widget", html: "<p>widget content</p>" },
    { storage: { files, directory: `chats/${chat.id}/widgets` } },
  );
  await files.write(`chats/${chat.id}/widgets/cv_${"a".repeat(32)}/index.html`, "draft");
  const generatedName = `artifact-${randomUUID()}-portugal-itinerary.html`;
  await files.write(`chats/${chat.id}/artifacts/${generatedName}`, "<p>generated content</p>");
  for (let index = 0; index < 100; index++) {
    await files.write(`chats/${chat.id}/web-fetch/file-${String(index).padStart(3, "0")}.txt`, "x");
  }
  const profile = { "x-grogu-profile": alice.id };
  assert.equal((await call("alice", "/artifacts")).status, 403);
  assert.equal((await call("bob", "/artifacts", { headers: profile })).status, 403);
  assert.equal(
    (await call("alice", "/artifacts?cursor=invalid", { headers: profile })).status,
    400,
  );
  const first = await (await call("alice", "/artifacts", { headers: profile })).json();
  assert.equal(first.artifacts.length, 100);
  assert.ok(first.nextCursor);
  const second = await (
    await call("alice", `/artifacts?cursor=${first.nextCursor}`, { headers: profile })
  ).json();
  const all = [...first.artifacts, ...second.artifacts];
  assert.equal(all.length, 102);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set(all.map((item: { id: string }) => item.id)).size, 102);
  assert.ok(
    all.every(
      (item: { chatId: string; chatTitle: string; updatedAt: number }) =>
        item.chatId === chat.id &&
        item.chatTitle === chat.title &&
        item.updatedAt === chat.updatedAt,
    ),
  );
  assert.ok(
    all.some(
      (item: { kind: string; id: string; title?: string }) =>
        item.kind === "widget" && item.id === widget.id && item.title === "Synthetic widget",
    ),
  );
  const generatedId = `generated~${chat.id}~${generatedName}`;
  assert.ok(
    all.some(
      (item: { kind: string; id: string; name?: string }) =>
        item.kind === "file" && item.id === generatedId && item.name === "portugal itinerary.html",
    ),
  );
  assert.deepEqual(
    (
      await (
        await call("bob", "/artifacts", {
          headers: { "x-grogu-profile": bob.id },
        })
      ).json()
    ).artifacts,
    [],
  );
  const versioned = (items: Array<{ id: string; version?: string }>, id: string) =>
    items.find((item) => item.id === id)?.version;
  assert.equal(versioned(all, widget.id), widget.id);
  assert.match(versioned(all, generatedId) ?? "", /^[a-f0-9]{64}$/);
  const otherChat = (
    await (
      await call("alice", "/chats", { method: "POST", body: '{"title":"Per-chat artifacts"}' })
    ).json()
  ).chat;
  const otherName = `artifact-${randomUUID()}-notes.html`;
  await files.write(`chats/${otherChat.id}/artifacts/${otherName}`, "<p>first</p>");
  const otherRoute = `/chats/${otherChat.id}/artifacts`;
  assert.equal((await call("alice", otherRoute)).status, 403);
  assert.equal(
    (await call("bob", otherRoute, { headers: { "x-grogu-profile": bob.id } })).status,
    404,
  );
  assert.equal((await call("alice", "/chats/missing/artifacts", { headers: profile })).status, 404);
  const firstVersion = await (await call("alice", otherRoute, { headers: profile })).json();
  assert.deepEqual(
    firstVersion.artifacts.map((item: { chatId: string }) => item.chatId),
    [otherChat.id],
  );
  const repeatVersion = await (await call("alice", otherRoute, { headers: profile })).json();
  assert.equal(repeatVersion.artifacts[0].version, firstVersion.artifacts[0].version);
  await files.write(`chats/${otherChat.id}/artifacts/${otherName}`, "<p>second</p>");
  const changedVersion = await (await call("alice", otherRoute, { headers: profile })).json();
  assert.notEqual(changedVersion.artifacts[0].version, firstVersion.artifacts[0].version);
  assert.equal((await call("bob", `/files/${generatedId}`)).status, 404);
  assert.equal((await call("bob", `/chats/${chat.id}/widgets/${widget.id}`)).status, 404);
  assert.equal(
    (
      await call("alice", `/files/${generatedId}`, {
        headers: { "x-grogu-profile": bob.id },
      })
    ).status,
    403,
  );
  const download = await call("alice", `/files/${generatedId}`, { headers: profile });
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.equal(await download.text(), "<p>generated content</p>");
  assert.match(
    (
      await (
        await call("alice", `/chats/${chat.id}/widgets/${widget.id}`, {
          headers: profile,
        })
      ).json()
    ).html,
    /widget content/,
  );
});

void test("fixture blocks egress from work that outlives its test", () => {
  const script = `
    import { test } from "node:test";
    import { installFixtureFetch } from "./grogu/protected/test-fetch-guard.ts";
    globalThis.fetch = async () => new Response("escaped");
    const controller = new AbortController();
    test("cancelled fixture", { signal: controller.signal }, async (child) => {
      const release = Promise.withResolvers();
      installFixtureFetch(child, async () => new Response("blocked"), async () => {}, () => false);
      child.after(() => release.resolve());
      setImmediate(() => controller.abort());
      await release.promise;
      await new Promise((resolve) => setImmediate(resolve));
      const result = await fetch("https://outside.invalid");
      process.stdout.write("late fetch: " + await result.text() + "\\n");
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /late fetch: blocked/);
  assert.doesNotMatch(child.stdout, /late fetch: escaped/);
});

void test("Family HTTP isolates chats, relays device authorization, and durably revokes sessions", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-test-${randomUUID()}`);
  protectedTestStateDirs.add(stateDir);
  const usersDir = path.join(stateDir, "users");
  const bundleDir = path.join(stateDir, "bundle");
  await Promise.all([
    mkdir(usersDir, { recursive: true, mode: 0o700 }),
    mkdir(path.join(bundleDir, "assets"), { recursive: true, mode: 0o700 }),
  ]);
  await prepareProtectedSharedState(stateDir, () => {});
  await Promise.all([
    writeFile(path.join(bundleDir, "index.html"), "<h1>Family notebook</h1>"),
    writeFile(path.join(bundleDir, "assets/index-Family.js"), "export {};"),
    writeFile(path.join(bundleDir, "assets/notebook-Ab12_cd.woff2"), "wOF2"),
    symlink("../index.html", path.join(bundleDir, "assets/index-Symlink.js")),
  ]);
  const release = Promise.withResolvers<void>();
  const renameStarted = Promise.withResolvers<void>();
  const releaseRename = Promise.withResolvers<void>();
  const shutdownApps: Array<() => Promise<void>> = [];
  t.after(async () => {
    release.resolve();
    releaseRename.resolve();
    await Promise.all(shutdownApps.map((shutdown) => shutdown()));
  });
  const staticClient = await createProtectedStaticClient(await root(bundleDir));
  const usersRoot = await root(usersDir);
  const expiresAt = Date.now() + 120_000;
  const verifyIdentity: ProtectedIdentityVerifier = async (request) => {
    const subject = request.headers.get("cookie")?.slice("synthetic=".length);
    if (subject !== "alice" && subject !== "bob" && subject !== "carol") {
      throw new ProtectedError(401, "unauthorized", "Sign in.");
    }
    let revalidations = 0;
    return {
      issuer: "https://synthetic.example",
      subject,
      kind: "human",
      expiresAt,
      sessionId: createHash("sha256").update(subject).digest("hex"),
      assertCurrent() {},
      async revalidate() {
        if (request.headers.has("x-synthetic-hold-rename") && ++revalidations === 2) {
          renameStarted.resolve();
          await releaseRename.promise;
        }
      },
    };
  };
  const submitted = Promise.withResolvers<void>();
  const origin = "https://family.example";
  const catalogExtensions = [protectedResearchAgent];
  const open = async (
    freeFloorBytes = 1,
    agentExtensions: ProtectedAgentExtension[] = [],
    models: ProtectedModel[] = [
      { provider: "anthropic", id: "synthetic", label: "Synthetic only" },
    ],
  ) => {
    const observedAgents: Array<{
      id: string;
      name: string;
      description: string;
      instructions: string;
      tools: readonly string[];
      systemPrompt: string;
    }> = [];
    const app = createProtectedHttp({
      origin,
      accessIssuer: "https://synthetic.example",
      stateDir,
      usersRoot,
      verifyIdentity,
      directory: {
        issuer: "https://synthetic.example",
        allowedSubjects: ["alice", "bob", "carol"],
      },
      answerAccessProof: async (request) => Response.json({ answered: request.url }),
      agentExtensions,
      maxChatsPerUser: 3,
      maxFileBytes: 64_000,
      storageLimits: { globalBytes: 95_000, userBytes: 58_000, freeFloorBytes },
      providerRelay: createProviderRelay(),
      turns: {
        models,
        async run(turn) {
          observedAgents.push(turn.agent);
          if (turn.input.text === "Write an oversized file") {
            await turn.files.write(`chats/${turn.id}/oversized.txt`, "x".repeat(64_001));
            return;
          }
          submitted.resolve();
          await release.promise;
          await turn.delta("Synthetic reply without any committed transcript.");
        },
        async steer() {
          assert.fail("No steering should reach the runtime in this fixture.");
        },
      },
    });
    const server = createProtectedServer(origin, app.fetch, staticClient);
    const url = await listen(server);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => (shutdownPromise ??= closeProtectedServer(server, app, stateDir));
    shutdownApps.push(shutdown);
    const call = (user: string, route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", headers.get("origin") ?? origin);
      headers.set("cookie", headers.get("cookie") ?? `synthetic=${user}`);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      return fetch(`${url}/api/protected/v1${route}`, { ...init, headers });
    };
    return {
      url,
      call,
      shutdown,
      observedAgents,
      revokeProfile: (id: string) => app.revokeProfile(id),
    };
  };
  const first = await open(1, catalogExtensions, [
    { provider: "anthropic", id: "synthetic", label: "Synthetic only" },
    {
      provider: "sparky",
      id: "synthetic-sparky",
      label: "Synthetic Sparky",
      thinking: { levels: ["low", "medium", "ultra"], default: "ultra" },
    },
  ]);
  t.after(() => first.shutdown());
  // The proof route answers from its own assertion; entering the verifier here would recurse.
  const proof = await fetch(`${first.url}/api/protected/v1/access-proof?challenge=c`);
  assert.deepEqual(await proof.json(), {
    answered: `${origin}/api/protected/v1/access-proof?challenge=c`,
  });
  const shell = await fetch(first.url);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.match(shell.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(shell.headers.get("content-security-policy") ?? "", /font-src 'self'/);
  assert.equal(await shell.text(), "<h1>Family notebook</h1>");
  const font = await fetch(`${first.url}/assets/notebook-Ab12_cd.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  const assetUrl = `${first.url}/assets/index-Family.js`;
  const asset = await fetch(assetUrl, { method: "HEAD" });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(await asset.text(), "");
  assert.equal((await fetch(assetUrl, { method: "POST" })).status, 405);
  const publicSubmit = await fetch(`${first.url}/request-access/api`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: "requester@example.invalid",
      name: "Synthetic requester",
      note: "Synthetic access request",
    }),
  });
  const publicSubmitBody = await publicSubmit.text();
  assert.equal(publicSubmit.status, 201, publicSubmitBody);
  const receiptCookie = publicSubmit.headers.get("set-cookie");
  assert.match(receiptCookie ?? "", /^protected_access_receipt=[A-Za-z0-9_-]+;/u);
  const statusWithoutReceipt = await fetch(`${first.url}/request-access/api/status`, {
    headers: { origin },
  });
  assert.equal(statusWithoutReceipt.status, 200);
  const receipt = (receiptCookie ?? "").split(";", 1)[0]!;
  const statusWithReceipt = await fetch(`${first.url}/request-access/api/status`, {
    headers: { origin, cookie: receipt },
  });
  assert.equal(statusWithReceipt.status, 200);
  for (const route of [
    "/assets/index-Symlink.js",
    "/assets/notebook.Ab12.woff2",
    "/cdn-cgi/access/logout",
    "/api/unknown",
    "/no-spa",
  ]) {
    assert.equal((await fetch(`${first.url}${route}`)).status, 404);
  }
  const widgetHost = await first.call("alice", "/widget-sandbox");
  assert.equal(widgetHost.status, 200);
  assert.doesNotMatch(
    widgetHost.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  const measurement = await first.call("alice", "/widget-measurement");
  assert.equal(measurement.status, 200);
  for (const response of [widgetHost, measurement]) {
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.match(measurement.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  assert.equal(measurement.headers.get("set-cookie"), null);
  assert.match(await measurement.text(), /<style data-widget-base>/);
  const me = await first.call("alice", "/me");
  assert.equal(me.status, 200);
  const meResponse = await me.json();
  assert.equal(Value.Check(ProtectedMeSchema, meResponse), false);
  const { user, capabilities } = meResponse;
  assert.deepEqual(capabilities, {
    copilotConnect: true,
    openaiConnect: true,
    admin: false,
  });
  const negotiatedMe = await first.call("alice", "/me", {
    headers: { "X-Alcove-Capabilities": "profile-v1, agents-v1" },
  });
  assert.equal(negotiatedMe.status, 200);
  const negotiatedMeResponse = await negotiatedMe.json();
  assert.equal(Value.Check(ProtectedMeSchema, negotiatedMeResponse), true);
  assert.deepEqual(negotiatedMeResponse.capabilities, capabilities);
  const automationCatalogResponse = await first.call("alice", "/automations/catalog");
  assert.equal(automationCatalogResponse.status, 200);
  const automationCatalog = await automationCatalogResponse.json();
  assert.equal(Value.Check(ProtectedAutomationCatalogSchema, automationCatalog), true);
  assert.deepEqual(automationCatalog.capabilities.automations, {
    catalog: true,
    draftValidation: true,
    list: true,
    create: true,
    scheduleControl: false,
    run: false,
    sharing: false,
    notifications: false,
  });
  assert.equal(automationCatalog.defaultAgentId, "grogu");
  assert.deepEqual(
    automationCatalog.agents.map((agent: { id: string }) => agent.id),
    ["grogu", "travel"],
  );
  assert.equal(automationCatalogResponse.headers.get("vary"), "X-Alcove-Capabilities");
  const automationCatalogV1 = await (
    await first.call("alice", "/automations/catalog", {
      headers: { "x-alcove-capabilities": "profile-v1, agents-v1" },
    })
  ).json();
  assert.equal(Value.Check(ProtectedAutomationCatalogV1Schema, automationCatalogV1), true);
  assert.equal(Value.Check(ProtectedAutomationCatalogSchema, automationCatalogV1), false);
  assert.deepEqual({ ...automationCatalogV1, agents: automationCatalog.agents }, automationCatalog);
  assert.equal(automationCatalog.capabilities.automations.chat, undefined);
  const negotiatedAutomationCatalogResponse = await first.call("alice", "/automations/catalog", {
    headers: { "X-Alcove-Capabilities": "profile-v1, automations-chat-v1" },
  });
  assert.equal(negotiatedAutomationCatalogResponse.status, 200);
  const negotiatedAutomationCatalog = await negotiatedAutomationCatalogResponse.json();
  assert.equal(Value.Check(ProtectedAutomationCatalogSchema, negotiatedAutomationCatalog), true);
  assert.deepEqual(negotiatedAutomationCatalog.capabilities.automations.chat, {
    list: true,
    read: true,
    proposeCreate: true,
    proposePatch: true,
  });
  const combinedAutomationCatalog = await (
    await first.call("alice", "/automations/catalog", {
      headers: { "X-Alcove-Capabilities": "agents-v1, automations-chat-v1" },
    })
  ).json();
  assert.equal(Value.Check(ProtectedAutomationCatalogV1Schema, combinedAutomationCatalog), true);
  assert.deepEqual(combinedAutomationCatalog.agents, automationCatalogV1.agents);
  assert.deepEqual(
    combinedAutomationCatalog.capabilities.automations.chat,
    negotiatedAutomationCatalog.capabilities.automations.chat,
  );
  assert.deepEqual(automationCatalog.schedule.everyMs, {
    minimum: 1,
    maximum: 8_640_000_000_000_000,
  });
  assert.deepEqual(automationCatalog.schedule.kinds, ["every", "cron"]);
  assert.deepEqual(automationCatalog.schedule.cron, {
    format: "5-field",
    repeats: ["daily", "weekdays", "saturday"],
    timeZones: ["America/Los_Angeles"],
    timePrecision: "minute",
    staggerMs: 0,
    daylightSaving: {
      nonexistentLocalTime: "skip",
      repeatedLocalTime: "first",
    },
  });
  assert.equal(automationCatalog.models.length, 1);
  assert.equal(automationCatalog.models[0].provider, "sparky");
  assert.deepEqual(automationCatalog.models[0].thinking.levels, ["low", "medium", "ultra"]);
  assert.equal(automationCatalog.models[0].thinking.default, "ultra");
  const automationDraft: ProtectedAutomationDraft = {
    name: "Synthetic morning summary",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    doneWhen: "The summary is complete.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const validationResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify(automationDraft),
  });
  assert.equal(validationResponse.status, 200);
  const validation = await validationResponse.json();
  assert.equal(Value.Check(ProtectedAutomationDraftValidationSchema, validation), true);
  assert.deepEqual(validation, {
    valid: true,
    draft: { ...automationDraft, thinking: "ultra" },
  });
  for (const subject of ["alice", "bob"]) {
    assert.equal(
      await addProtectedSubject(stateDir, { issuer: "https://synthetic.example", subject }),
      "added",
    );
  }
  const invalidEnabledCreate = await first.call("alice", "/automations", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, enabled: true }),
  });
  assert.equal(invalidEnabledCreate.status, 422);
  const createdAutomationResponse = await first.call("alice", "/automations", {
    method: "POST",
    body: JSON.stringify(automationDraft),
  });
  assert.equal(createdAutomationResponse.status, 201);
  const createdAutomationBody = await createdAutomationResponse.json();
  assert.equal(Value.Check(ProtectedAutomationResponseSchema, createdAutomationBody), true);
  const createdAutomation = createdAutomationBody.automation;
  assert.equal(createdAutomation.enabled, false);
  assert.equal(createdAutomation.state, "paused");
  assert.equal(createdAutomation.version, "1");
  assert.equal(createdAutomation.nextCheckAt, null);
  const automationListResponse = await first.call("alice", "/automations");
  assert.equal(automationListResponse.status, 200);
  const automationList = await automationListResponse.json();
  assert.equal(Value.Check(ProtectedAutomationListResponseSchema, automationList), true);
  assert.deepEqual(
    automationList.automations.map((automation: { id: string }) => automation.id),
    [createdAutomation.id],
  );
  const updatedAutomationResponse = await first.call(
    "alice",
    `/automations/${createdAutomation.id}`,
    {
      method: "PATCH",
      headers: { "if-match": createdAutomation.version },
      body: JSON.stringify({ enabled: false, name: "Updated synthetic morning summary" }),
    },
  );
  assert.equal(updatedAutomationResponse.status, 200);
  const updatedAutomationBody = await updatedAutomationResponse.json();
  assert.equal(Value.Check(ProtectedAutomationResponseSchema, updatedAutomationBody), true);
  assert.equal(updatedAutomationBody.automation.name, "Updated synthetic morning summary");
  assert.equal(updatedAutomationBody.automation.enabled, false);
  assert.equal(updatedAutomationBody.automation.state, "paused");
  assert.equal(updatedAutomationBody.automation.version, "2");
  const staleAutomationPatch = await first.call("alice", `/automations/${createdAutomation.id}`, {
    method: "PATCH",
    headers: { "if-match": createdAutomation.version },
    body: JSON.stringify({ name: "Stale update" }),
  });
  assert.equal(staleAutomationPatch.status, 412);
  const unavailableAutomationStart = await first.call(
    "alice",
    `/automations/${createdAutomation.id}`,
    {
      method: "PATCH",
      headers: { "if-match": updatedAutomationBody.automation.version },
      body: JSON.stringify({ enabled: true }),
    },
  );
  assert.equal(unavailableAutomationStart.status, 503);
  assert.equal((await unavailableAutomationStart.json()).error.code, "scheduler_unavailable");
  const bobAutomationRead = await first.call("bob", `/automations/${createdAutomation.id}`);
  assert.equal(bobAutomationRead.status, 404);
  const bobAutomationPatch = await first.call("bob", `/automations/${createdAutomation.id}`, {
    method: "PATCH",
    headers: { "if-match": updatedAutomationBody.automation.version },
    body: JSON.stringify({ name: "Bob's update" }),
  });
  assert.equal(bobAutomationPatch.status, 404);
  const unchangedAfterRejectedStart = await first.call(
    "alice",
    `/automations/${createdAutomation.id}`,
  );
  const unchangedAutomation = await unchangedAfterRejectedStart.json();
  assert.equal(unchangedAutomation.automation.version, "2");
  assert.equal(unchangedAutomation.automation.enabled, false);
  const maximumName = "😀".repeat(40);
  const maximumNameResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, name: maximumName }),
  });
  assert.equal((await maximumNameResponse.json()).valid, true);
  const longNameResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, name: "😀".repeat(41) }),
  });
  const longName = await longNameResponse.json();
  assert.equal(longName.valid, false);
  assert.ok(
    longName.errors.some(
      (entry: { field: string; code: string }) =>
        entry.field === "name" && entry.code === "too_long",
    ),
  );
  const longInstructionsResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, instructions: "😀".repeat(4_097) }),
  });
  const longInstructions = await longInstructionsResponse.json();
  assert.equal(longInstructions.valid, false);
  assert.ok(
    longInstructions.errors.some(
      (entry: { field: string; code: string }) =>
        entry.field === "instructions" && entry.code === "too_long",
    ),
  );
  const longNotificationRuleResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, whenToNotify: "😀".repeat(1_025) }),
  });
  const longNotificationRule = await longNotificationRuleResponse.json();
  assert.equal(longNotificationRule.valid, false);
  assert.ok(
    longNotificationRule.errors.some(
      (entry: { field: string; code: string }) =>
        entry.field === "whenToNotify" && entry.code === "too_long",
    ),
  );
  const longDoneWhenResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, doneWhen: " ".repeat(2_001) }),
  });
  const longDoneWhen = await longDoneWhenResponse.json();
  assert.equal(longDoneWhen.valid, false);
  assert.ok(
    longDoneWhen.errors.some(
      (entry: { field: string; code: string }) =>
        entry.field === "doneWhen" && entry.code === "too_long",
    ),
  );
  const oversizedDefinitionResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, instructions: "\u0000".repeat(6_000) }),
  });
  const oversizedDefinition = await oversizedDefinitionResponse.json();
  assert.equal(oversizedDefinition.valid, false);
  assert.ok(oversizedDefinition.errors.some((entry: { field: string }) => entry.field === "draft"));
  const unsupportedAgentResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, agentId: "unlisted-agent" }),
  });
  assert.equal(unsupportedAgentResponse.status, 200);
  const unsupportedAgent = await unsupportedAgentResponse.json();
  assert.equal(unsupportedAgent.valid, false);
  assert.ok(unsupportedAgent.errors.some((entry: { field: string }) => entry.field === "agentId"));
  const unsupportedThinkingResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({ ...automationDraft, thinking: "high" }),
  });
  const unsupportedThinking = await unsupportedThinkingResponse.json();
  assert.equal(unsupportedThinking.valid, false);
  assert.ok(
    unsupportedThinking.errors.some((entry: { field: string }) => entry.field === "thinking"),
  );
  const invalidIntervalResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify({
      ...automationDraft,
      schedule: { kind: "every", everyMs: 8_640_000_000_000_001 },
    }),
  });
  assert.equal(invalidIntervalResponse.status, 200);
  assert.equal((await invalidIntervalResponse.json()).valid, false);
  const calendarDraft = {
    ...automationDraft,
    schedule: { kind: "cron", expr: "0 7 * * 1-5", tz: "America/Los_Angeles" },
  };
  const calendarValidationResponse = await first.call("alice", "/automations/drafts/validate", {
    method: "POST",
    body: JSON.stringify(calendarDraft),
  });
  assert.deepEqual(await calendarValidationResponse.json(), {
    valid: true,
    draft: { ...calendarDraft, thinking: "ultra" },
  });
  assert.equal(first.observedAgents.length, 0);
  const automationStorage = await (await first.call("alice", "/storage/chats")).json();
  assert.ok(automationStorage.usedBytes > 0);
  assert.deepEqual(automationStorage.chats, []);
  const catalogResponse = await first.call("alice", "/agents");
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.headers.get("vary"), "X-Alcove-Capabilities");
  const catalog = await catalogResponse.json();
  assert.equal(Value.Check(ProtectedAgentCatalogSchema, catalog), true);
  assert.equal(catalog.defaultAgentId, "grogu");
  // Shipped strict clients get only new-chat choices, without metadata or tool names they reject.
  assert.deepEqual(
    catalog.agents.map((agent: { id: string }) => agent.id),
    ["grogu", "travel"],
  );
  assert.deepEqual(catalog.agents.find((agent: { id: string }) => agent.id === "travel")?.tools, [
    "web_fetch",
    "show_widget",
    "sessions_list",
    "sessions_history",
    "sessions_send",
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /Use concise, evidence-based summaries/);
  const catalogV1Response = await first.call("alice", "/agents", {
    headers: { "x-alcove-capabilities": "agents-v1" },
  });
  assert.equal(catalogV1Response.headers.get("vary"), "X-Alcove-Capabilities");
  const catalogV1 = await catalogV1Response.json();
  assert.equal(Value.Check(ProtectedAgentCatalogV1Schema, catalogV1), true);
  assert.deepEqual(
    catalogV1.agents.map((agent: { id: string; selectable: boolean }) => [
      agent.id,
      agent.selectable,
    ]),
    [
      ["grogu", true],
      ["travel", true],
      ["general", false],
      ["research", false],
    ],
  );
  const [groguV1, travelV1] = catalogV1.agents;
  assert.deepEqual(groguV1.presentation, {
    icon: "grogu",
    reasoningIndicator: "grogu-eater",
    widgetWidth: "standard",
  });
  assert.deepEqual(travelV1.presentation, {
    icon: "plane",
    reasoningIndicator: "standard",
    widgetWidth: "wide",
  });
  assert.deepEqual(
    travelV1.skills.map((skill: { id: string }) => skill.id),
    ["travel-dashboard"],
  );
  assert.equal(groguV1.examplePrompts.length, 4);
  assert.ok(groguV1.tools.includes("web_search"));
  assert.ok(groguV1.tools.includes("sessions_search"));
  for (const agent of catalogV1.agents) {
    assert.deepEqual(agent.tools, groguV1.tools, "every agent shares one tool surface");
  }
  // Instructions and skill guidance stay server-side.
  assert.doesNotMatch(
    JSON.stringify(catalogV1),
    /evidence-based summaries|careful travel planner|trip-head/i,
  );
  const created = await first.call("alice", "/chats", {
    method: "POST",
    body: '{"title":"Alice private"}',
  });
  assert.equal(created.status, 200, await created.clone().text());
  let { chat } = await created.json();
  assert.equal(chat.selectedAgentId, "grogu");
  const route = `/chats/${chat.id}`;
  await t.test(
    "renames only an owned idle chat at its current version and persists on reload",
    async () => {
      const rename = (
        subject: string,
        title: unknown,
        version: string | undefined = chat.version,
      ) =>
        first.call(subject, `${route}/title`, {
          method: "PATCH",
          headers: version === undefined ? {} : { "if-match": version },
          body: JSON.stringify({ title }),
        });
      assert.equal(
        (await first.call("alice", `${route}/title`, { method: "PATCH", body: '{"title":"New"}' }))
          .status,
        428,
      );
      for (const title of ["", " \n ", "x".repeat(161), 42, null, undefined]) {
        const result = await rename("alice", title);
        assert.equal(result.status, 422);
        assert.equal((await result.json()).error.code, "invalid_title");
      }
      assert.equal((await rename("bob", "Not yours")).status, 404);
      assert.equal((await rename("unadmitted", "Not admitted")).status, 401);
      const stale = await rename("alice", "Stale", "stale");
      assert.equal(stale.status, 412);
      assert.equal((await stale.json()).error.code, "version_conflict");
      const maximumTitle = await rename("alice", "x".repeat(160));
      assert.equal(maximumTitle.status, 200);
      chat = (await maximumTitle.json()).chat;
      assert.equal(chat.title, "x".repeat(160));

      const renaming = first.call("alice", `${route}/title`, {
        method: "PATCH",
        headers: { "if-match": chat.version, "x-synthetic-hold-rename": "1" },
        body: '{"title":"  Alice renamed  "}',
      });
      await renameStarted.promise;
      try {
        const busy = await rename("alice", "Concurrent");
        assert.equal(busy.status, 409);
        assert.equal((await busy.json()).error.code, "busy");
        assert.equal(
          (
            await first.call("alice", route, {
              method: "DELETE",
              headers: { "if-match": chat.version },
            })
          ).status,
          409,
        );
      } finally {
        releaseRename.resolve();
      }
      const renamed = await renaming;
      assert.equal(renamed.status, 200, await renamed.clone().text());
      const updated = (await renamed.json()).chat;
      assert.equal(updated.title, "Alice renamed");
      assert.ok(Number(updated.version) > Number(chat.version));
      assert.deepEqual(updated.messages, chat.messages);
      assert.equal(updated.selectedAgentId, chat.selectedAgentId);
      assert.equal((await rename("alice", "Old version")).status, 412);
      chat = updated;
      const reload = await open(1, catalogExtensions);
      try {
        assert.deepEqual((await (await reload.call("alice", route)).json()).chat, chat);
        assert.equal(
          (await (await reload.call("alice", "/chats")).json()).chats[0].title,
          chat.title,
        );
      } finally {
        await reload.shutdown();
      }
    },
  );
  const retiredSelection = await first.call("alice", `${route}/agent`, {
    method: "PATCH",
    headers: { "if-match": chat.version },
    body: '{"selectedAgentId":"general"}',
  });
  assert.equal(retiredSelection.status, 422);
  assert.equal((await retiredSelection.json()).error.code, "agent_unavailable");
  // A chat saved while Research was selectable keeps it after Research leaves the new-chat choices.
  const earlierRuntime = await open(1, [{ ...protectedResearchAgent, selectable: true }]);
  t.after(() => earlierRuntime.shutdown());
  const selected = await earlierRuntime.call("alice", `${route}/agent`, {
    method: "PATCH",
    headers: { "if-match": chat.version },
    body: '{"selectedAgentId":"research"}',
  });
  assert.equal(selected.status, 200);
  const selectedChat = (await selected.json()).chat;
  assert.equal(selectedChat.selectedAgentId, "research");
  const reloadedRuntime = await open(1, catalogExtensions);
  t.after(() => reloadedRuntime.shutdown());
  assert.equal((await reloadedRuntime.call("alice", "/automations/catalog")).status, 404);
  const reloadedChat = await reloadedRuntime.call("alice", route);
  assert.equal(reloadedChat.status, 200);
  assert.equal((await reloadedChat.json()).chat.selectedAgentId, "research");
  assert.equal(
    (
      await first.call("alice", `${route}/agent`, {
        method: "PATCH",
        headers: { "if-match": selectedChat.version },
        body: '{"selectedAgentId":"research"}',
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await first.call("alice", `${route}/agent`, {
        method: "PATCH",
        headers: { "if-match": chat.version },
        body: '{"selectedAgentId":"travel"}',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await first.call("alice", `${route}/agent`, {
        method: "PATCH",
        headers: { "if-match": selectedChat.version },
        body: '{"selectedAgentId":"missing"}',
      })
    ).status,
    422,
  );
  const secondAlice = await first.call("alice", "/chats", { method: "POST", body: "{}" });
  assert.equal(secondAlice.status, 413);
  assert.equal((await secondAlice.json()).error.code, "quota_exceeded");
  assert.equal((await first.call("bob", route)).status, 404);
  assert.deepEqual(await (await first.call("bob", "/export")).json(), { chats: [] });
  const storage = await (await first.call("alice", "/storage/chats")).json();
  assert.equal(storage.limitBytes, 58_000);
  assert.ok(storage.usedBytes > 0);
  assert.deepEqual(storage.chats, [
    {
      id: chat.id,
      title: "Alice renamed",
      version: selectedChat.version,
      updatedAt: selectedChat.updatedAt,
      approximateBytes: storage.usedBytes - automationStorage.usedBytes,
    },
  ]);
  assert.deepEqual(await (await first.call("bob", "/storage/chats")).json(), {
    limitBytes: 58_000,
    usedBytes: 0,
    chats: [],
  });
  assert.equal(
    (await first.call("alice", route, { method: "DELETE", headers: { "if-match": "stale" } }))
      .status,
    409,
  );

  const turn = {
    method: "POST",
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  };
  assert.equal(
    (
      await first.call("alice", `${route}/turns`, {
        method: "POST",
        headers: { "x-grogu-profile": user.id },
        body: '{"provider":"anthropic","text":"@missing Hello","credential":{"accessToken":"synthetic-only"},"mentions":[{"agentId":"missing"}]}',
      })
    ).status,
    422,
  );
  const retiredMention = await first.call("alice", `${route}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": user.id },
    body: '{"provider":"anthropic","text":"@research Hello","credential":{"accessToken":"synthetic-only"},"mentions":[{"agentId":"research"}]}',
  });
  assert.equal(retiredMention.status, 422);
  assert.equal((await retiredMention.json()).error.code, "agent_unavailable");
  assert.equal((await first.call("alice", `${route}/turns`, turn)).status, 403);
  const running = await first.call("alice", `${route}/turns`, {
    ...turn,
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(running.status, 200);
  await submitted.promise;
  const busyRename = await first.call("alice", `${route}/title`, {
    method: "PATCH",
    headers: { "if-match": selectedChat.version },
    body: '{"title":"Busy rename"}',
  });
  assert.equal(busyRename.status, 409);
  assert.equal((await busyRename.json()).error.code, "busy");
  assert.equal(first.observedAgents[0]?.id, "research");
  assert.match(first.observedAgents[0]?.instructions ?? "", /evidence-based summaries/);
  assert.match(
    first.observedAgents[0]?.systemPrompt ?? "",
    /^# Alcove\n[\s\S]*\n## Current agent: Research \(research\)\n\nUse concise/u,
  );
  assert.equal(
    (
      await first.call("alice", `${route}/agent`, {
        method: "PATCH",
        headers: { "if-match": selectedChat.version },
        body: '{"selectedAgentId":"travel"}',
      })
    ).status,
    409,
  );
  const reader = running.body!.getReader();
  const start = await reader.read();
  const { runId } = JSON.parse(new TextDecoder().decode(start.value));
  assert.equal(
    (await first.call("bob", `${route}/runs/${runId}/stop`, { method: "POST" })).status,
    404,
  );
  assert.equal(await first.revokeProfile(user.id), true);
  release.resolve();
  const tail = await new Response(
    new ReadableStream({
      async pull(controller) {
        const read = await reader.read();
        if (read.done) {
          controller.close();
        } else {
          controller.enqueue(read.value);
        }
      },
    }),
  ).text();
  assert.match(tail, /"code":"interrupted"/);
  assert.doesNotMatch(tail, /Synthetic reply|"type":"done"/);
  const bobMe = await (await first.call("bob", "/me")).json();
  const originalFetch = globalThis.fetch;
  const openaiPoll = Promise.withResolvers<void>();
  const githubExchange = Promise.withResolvers<void>();
  const openaiExchange = Promise.withResolvers<void>();
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
  ).toString("base64url");
  const openaiAccess = `e30.${payload}.synthetic`;
  const providerCalls: string[] = [];
  const patch = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }
      const endpoint = `${url.origin}${url.pathname}`;
      providerCalls.push(endpoint);
      const form = init?.body;
      switch (endpoint) {
        case "https://github.com/login/device/code":
          assert.ok(form instanceof URLSearchParams);
          assert.equal(form.get("client_id"), "Iv1.b507a08c87ecfe98");
          return Response.json({
            device_code: "synthetic-device-github",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 60,
            interval: 1,
          });
        case "https://github.com/login/oauth/access_token":
          assert.ok(form instanceof URLSearchParams);
          assert.equal(form.get("device_code"), "synthetic-device-github");
          githubExchange.resolve();
          return Response.json({ access_token: "synthetic-github", token_type: "bearer" });
        case "https://auth.openai.com/api/accounts/deviceauth/usercode":
          assert.equal(form, '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}');
          return Response.json({
            device_auth_id: "synthetic-device-openai",
            user_code: "WXYZ-9876",
            interval: 1,
          });
        case "https://auth.openai.com/api/accounts/deviceauth/token":
          await openaiPoll.promise;
          return Response.json({
            authorization_code: "synthetic-code",
            code_verifier: "synthetic-verifier",
          });
        case "https://auth.openai.com/oauth/token": {
          assert.ok(typeof form === "string" || form instanceof URLSearchParams);
          const fields = new URLSearchParams(form);
          assert.equal(fields.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
          const renewing = fields.get("grant_type") === "refresh_token";
          assert.equal(
            fields.get(renewing ? "refresh_token" : "code"),
            renewing ? "synthetic-refresh" : "synthetic-code",
          );
          if (!renewing) {
            openaiExchange.resolve();
          }
          return Response.json({
            access_token: openaiAccess,
            refresh_token: renewing ? "synthetic-rotated" : "synthetic-refresh",
            expires_in: 60,
          });
        }
        default:
          return assert.fail(`Unexpected provider endpoint: ${endpoint}`);
      }
    },
  );
  try {
    const providerPost = (endpoint: string, credential?: object) =>
      first.call("bob", endpoint, {
        method: "POST",
        headers: { "x-grogu-profile": bobMe.user.id },
        ...(credential && { body: JSON.stringify({ credential }) }),
      });
    assert.equal(
      (await first.call("bob", "/providers/openai/connect", { method: "POST" })).status,
      403,
    );
    assert.deepEqual(providerCalls, []);
    for (const [provider, verificationUrl, accessToken] of [
      [
        "github-copilot",
        "https://github.com/login/device",
        bindGithubCopilotToken("synthetic-github", "github.com"),
      ],
      ["openai", "https://auth.openai.com/codex/device", openaiAccess],
    ]) {
      const connect = `/providers/${provider}/connect`;
      const begin = await providerPost(connect);
      assert.equal(begin.status, 200);
      const challenge = await begin.json();
      assert.equal(challenge.verificationUrl, verificationUrl);
      const poll = `${connect}/${challenge.id}/poll`;
      if (provider === "openai") {
        assert.deepEqual(await (await providerPost(poll)).json(), { status: "pending" });
        openaiPoll.resolve();
      }
      await (provider === "openai" ? openaiExchange.promise : githubExchange.promise);
      const response = await providerPost(poll);
      assert.equal(response.status, 200, `${provider} calls: ${providerCalls.join(", ")}`);
      const result = await response.json();
      assert.equal(result.status, "authorized");
      assert.equal(result.credential.accessToken, accessToken);
      assert.equal((await providerPost(poll)).status, 404);
      if (provider === "openai") {
        const renewal = await providerPost("/providers/openai/renew", result.credential);
        assert.equal(renewal.status, 200);
        const { credential } = await renewal.json();
        assert.equal(credential.refreshToken, "synthetic-rotated");
        assert.equal(credential.generation, 2);
        assert.equal(credential.accountId, "synthetic-account");
      }
    }
  } finally {
    openaiPoll.resolve();
    patch.mock.restore();
  }
  const bobChat = await (await first.call("bob", "/chats", { method: "POST", body: "{}" })).json();
  const uncommitted = await first.call("bob", `/chats/${bobChat.chat.id}/turns`, {
    ...turn,
    headers: { "x-grogu-profile": bobMe.user.id },
  });
  const uncommittedStream = await uncommitted.text();
  assert.match(uncommittedStream, /"code":"save_failed"/);
  assert.doesNotMatch(uncommittedStream, /"type":"done"/);
  const oversized = await first.call("bob", `/chats/${bobChat.chat.id}/turns`, {
    ...turn,
    body: '{"provider":"anthropic","text":"Write an oversized file","credential":{"accessToken":"synthetic-only"}}',
    headers: { "x-grogu-profile": bobMe.user.id },
  });
  assert.match(await oversized.text(), /"code":"file_too_large"/);
  const full = await first.call("carol", "/chats", { method: "POST", body: "{}" });
  assert.equal(full.status, 413);
  assert.equal((await full.json()).error.code, "quota_exceeded");
  assert.equal(
    (
      await first.call("bob", `/chats/${bobChat.chat.id}`, {
        method: "DELETE",
        headers: { "if-match": bobChat.chat.version },
      })
    ).status,
    204,
  );
  assert.equal((await first.call("carol", "/chats", { method: "POST", body: "{}" })).status, 200);
  const bobStorageAfterDelete = await (await first.call("bob", "/storage/chats")).json();
  assert.equal(bobStorageAfterDelete.chats.length, 0);
  assert.ok(bobStorageAfterDelete.usedBytes > 0, "90-day run telemetry remains stored");
  assert.equal((await first.call("bob", "/logout", { method: "POST" })).status, 204);
  await first.shutdown();

  const reopened = await open(Number.MAX_SAFE_INTEGER);
  assert.equal((await reopened.call("alice", "/me")).status, 401);
  assert.equal((await reopened.call("bob", "/me")).status, 401);
  const lowDisk = await reopened.call("carol", "/chats", { method: "POST", body: "{}" });
  assert.equal(lowDisk.status, 507);
  assert.equal((await lowDisk.json()).error.code, "storage_full");
});

void test("Family directory lists admitted people and isolates the development identity", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(usersDir);
  const origin = "https://family.example";
  const issuer = "https://synthetic.example";
  const subjects = {
    alice: "11111111-1111-1111-1111-111111111111",
    bob: "22222222-2222-2222-2222-222222222222",
    development: `service-token:${"b".repeat(32)}.access`,
  };
  const allowedSubjects = [subjects.alice, subjects.bob, subjects.development];
  const expiresAt = Date.now() + 120_000;
  const verifyIdentity: ProtectedIdentityVerifier = async (request) => {
    const name = request.headers.get("cookie")?.slice("synthetic=".length);
    if (name !== "alice" && name !== "bob" && name !== "development") {
      throw new ProtectedError(401, "unauthorized", "Sign in.");
    }
    const subject = subjects[name];
    return {
      issuer,
      subject,
      kind: name === "development" ? "development" : "human",
      expiresAt,
      sessionId: createHash("sha256").update(subject).digest("hex"),
      assertCurrent() {},
      async revalidate() {},
    };
  };
  const open = async () => {
    const app = createProtectedHttp({
      origin,
      accessIssuer: issuer,
      stateDir,
      usersRoot,
      verifyIdentity,
      directory: { issuer, allowedSubjects },
      maxChatsPerUser: 3,
      maxFileBytes: 64_000,
      turns: {
        models: [],
        async run() {},
        async steer() {
          assert.fail("This fixture does not run turns.");
        },
      },
    });
    const server = createProtectedServer(origin, app.fetch);
    const url = await listen(server);
    const call = (
      user: keyof typeof subjects,
      route: string,
      init?: RequestInit,
      profileCapability = true,
    ) =>
      fetch(`${url}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: `synthetic=${user}`,
          "content-type": "application/json",
          ...(profileCapability ? { "x-alcove-capabilities": "profile-v1" } : {}),
          ...init?.headers,
        },
      });
    return { server, call, revokeProfile: (id: string) => app.revokeProfile(id) };
  };
  const first = await open();
  t.after(() => close(first.server));
  const alice = (await (await first.call("alice", "/me")).json()).user;
  const bob = (await (await first.call("bob", "/me")).json()).user;
  const development = (await (await first.call("development", "/me")).json()).user;
  for (const capabilities of [undefined, "", "profile-v10, unknown-v1"]) {
    const headers: Record<string, string> =
      capabilities === undefined ? {} : { "x-alcove-capabilities": capabilities };
    const legacyMe = await first.call("alice", "/me", { headers }, false);
    assert.deepEqual((await legacyMe.json()).user, { id: alice.id, displayName: "User" });
    const legacyAccount = await first.call("alice", "/account", { headers }, false);
    assert.deepEqual((await legacyAccount.json()).user, {
      id: alice.id,
      displayName: "Family member",
    });
    const legacyPeople = await first.call("alice", "/people", { headers }, false);
    assert.ok(
      (await legacyPeople.json()).people.every(
        (person: Record<string, unknown>) => !Object.hasOwn(person, "icon"),
      ),
    );
    assert.equal(legacyMe.headers.get("vary"), "X-Alcove-Capabilities");
    assert.equal(legacyAccount.headers.get("vary"), "X-Alcove-Capabilities");
    assert.equal(legacyPeople.headers.get("vary"), "X-Alcove-Capabilities");
  }
  assert.deepEqual(alice, { id: alice.id, displayName: "", setupRequired: true, icon: null });
  const combined = await first.call("alice", "/me", {
    headers: { "x-alcove-capabilities": "agents-v1, profile-v1 ,unknown-v2" },
  });
  assert.deepEqual((await combined.json()).user, alice);
  assert.equal(combined.headers.get("vary"), "X-Alcove-Capabilities");
  assert.deepEqual(await (await first.call("alice", "/account")).json(), {
    user: { id: alice.id, displayName: "", setupRequired: true, icon: null },
    directory: { description: "", hidden: false },
  });
  assert.equal((await (await first.call("development", "/account")).json()).directory.hidden, true);
  const put = (user: keyof typeof subjects, route: string, value: unknown) =>
    first.call(user, route, { method: "PUT", body: JSON.stringify(value) });

  // Setup saves About and icon before the name; only the name completes setup.
  assert.equal(
    (await put("alice", "/account/directory-settings", { description: "", hidden: false })).status,
    200,
  );
  const emoji = await put("alice", "/account/icon", { icon: { kind: "emoji", emoji: "🦊" } });
  assert.equal(emoji.status, 200);
  assert.deepEqual(await emoji.json(), { icon: { kind: "emoji", emoji: "🦊" } });
  assert.equal((await (await first.call("alice", "/me")).json()).user.setupRequired, true);
  const named = await put("alice", "/account/name", { displayName: " Alice " });
  assert.equal(named.status, 200);
  assert.deepEqual((await named.json()).user, {
    id: alice.id,
    displayName: "Alice",
    setupRequired: false,
    icon: { kind: "emoji", emoji: "🦊" },
  });
  assert.equal((await (await first.call("alice", "/me")).json()).user.setupRequired, false);
  const legacyNamed = await first.call(
    "alice",
    "/account/name",
    { method: "PUT", body: JSON.stringify({ displayName: "Alice" }) },
    false,
  );
  assert.deepEqual((await legacyNamed.json()).user, { id: alice.id, displayName: "Alice" });
  assert.equal(legacyNamed.headers.get("vary"), "X-Alcove-Capabilities");
  for (const icon of [
    { kind: "emoji", emoji: "ab" },
    { kind: "emoji", emoji: "🦊🦊" },
    { kind: "image", url: `/api/protected/v1/people/${alice.id}/icon?v=x` },
  ]) {
    assert.equal((await put("alice", "/account/icon", { icon })).status, 400);
  }
  const family = await put("alice", "/account/icon", {
    icon: { kind: "emoji", emoji: "👨‍👩‍👧" },
  });
  assert.deepEqual(await family.json(), { icon: { kind: "emoji", emoji: "👨‍👩‍👧" } });
  assert.deepEqual(await (await put("alice", "/account/icon", { icon: null })).json(), {
    icon: null,
  });
  assert.equal((await (await first.call("alice", "/account")).json()).user.icon, null);

  assert.equal((await put("bob", "/account/name", { displayName: "Bob" })).status, 200);
  assert.equal(
    (
      await put("bob", "/account/directory-settings", {
        description: "Enjoys books",
        hidden: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await put("development", "/account/directory-settings", { description: "", hidden: false }))
      .status,
    403,
  );
  const list = async (user: keyof typeof subjects): Promise<ProtectedPeople["people"]> =>
    (await (await first.call(user, "/people")).json()).people;
  assert.deepEqual(
    (await list("alice")).toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
    [
      { id: alice.id, displayName: "Alice", description: "", icon: null },
      { id: bob.id, displayName: "Bob", description: "Enjoys books", icon: null },
    ],
  );
  assert.deepEqual(await list("development"), []);
  assert.notEqual(development.id, alice.id);
  assert.notEqual(development.id, bob.id);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const upload = (user: keyof typeof subjects, bytes: Buffer, type: string) =>
    first.call(user, "/account/icon/image", {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: { "content-type": type },
    });
  const rejected = async (response: Response) => [
    response.status,
    (await response.json()).error.code,
  ];
  assert.deepEqual(await rejected(await upload("bob", png, "image/gif")), [
    415,
    "icon_unsupported_type",
  ]);
  assert.deepEqual(await rejected(await upload("bob", png, "image/jpeg")), [
    415,
    "icon_unsupported_type",
  ]);
  // Declare an oversized body without sending it; the server must refuse from the header.
  const oversized = await new Promise<number | undefined>((resolve, reject) => {
    const address = first.server.address();
    assert.ok(address && typeof address !== "string");
    const pending = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "PUT",
        path: "/api/protected/v1/account/icon/image",
        headers: {
          origin,
          cookie: "synthetic=bob",
          "content-type": "image/png",
          "content-length": String(512 * 1024 + 1),
        },
      },
      (response) => {
        response.resume();
        pending.destroy();
        resolve(response.statusCode);
      },
    );
    pending.on("error", reject);
    pending.flushHeaders();
  });
  assert.equal(oversized, 413);
  const uploaded = await upload("bob", png, "image/png");
  assert.equal(uploaded.status, 200);
  const bobIcon = (await uploaded.json()).icon;
  const revision = createHash("sha256").update(png).digest("hex");
  assert.deepEqual(bobIcon, {
    kind: "image",
    url: `/api/protected/v1/people/${bob.id}/icon?v=${revision}-png`,
  });
  assert.deepEqual((await list("alice")).find((person) => person.id === bob.id)?.icon, bobIcon);
  const legacyPeople = (await (await first.call("alice", "/people", undefined, false)).json()) as {
    people: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    legacyPeople.people.find((person) => person.id === bob.id),
    { id: bob.id, displayName: "Bob", description: "Enjoys books" },
  );
  const iconRoute = bobIcon.url.slice("/api/protected/v1".length);
  for (const user of ["bob", "alice"] as const) {
    const served = await first.call(user, iconRoute);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "private, no-cache");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    const cached = await first.call(user, iconRoute, {
      headers: { "if-none-match": served.headers.get("etag")! },
    });
    assert.equal(cached.status, 304);
  }
  assert.equal((await first.call("development", iconRoute)).status, 404);
  assert.equal((await first.call("alice", `/people/${randomUUID()}/icon`)).status, 404);
  assert.equal((await first.call("alice", `/people/${alice.id}/icon`)).status, 404);
  assert.equal(
    (await put("bob", "/account/icon", { icon: { kind: "emoji", emoji: "📚" } })).status,
    200,
  );
  assert.equal((await first.call("bob", iconRoute)).status, 404);
  assert.equal((await upload("development", png, "image/png")).status, 200);
  assert.equal((await first.call("development", `/people/${development.id}/icon`)).status, 200);
  assert.equal((await first.call("alice", `/people/${development.id}/icon`)).status, 404);
  assert.equal((await put("bob", "/account/icon", { icon: null })).status, 200);

  const hide = await put("bob", "/account/directory-settings", {
    description: "Not published",
    hidden: true,
  });
  assert.equal(hide.status, 400);
  assert.equal((await hide.json()).error.code, "directory_visibility_required");
  assert.equal(
    (await list("alice")).find((person) => person.id === bob.id)?.description,
    "Enjoys books",
  );
  assert.equal((await put("alice", "/account/name", { displayName: "a".repeat(41) })).status, 400);
  assert.equal(
    (
      await put("alice", "/account/directory-settings", {
        description: "a".repeat(141),
        hidden: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (await put("alice", "/account/name", { id: bob.id, displayName: "Not Bob" })).status,
    400,
  );
  const stateOptions = { env: { OPENCLAW_STATE_DIR: stateDir } };
  assert.equal(
    (
      await setCanonicalUserPreferences(
        bob.id,
        { "grogu.protected.directory": { description: "Invalid visibility" } },
        stateOptions,
      )
    )?.ok,
    true,
  );
  assert.deepEqual(
    (await list("alice")).find((person) => person.id === bob.id),
    {
      id: bob.id,
      displayName: "Bob",
      description: "",
      icon: null,
    },
  );
  assert.equal(
    (
      await setCanonicalUserPreferences(
        bob.id,
        { "grogu.protected.directory": { description: "Previously private", hidden: true } },
        stateOptions,
      )
    )?.ok,
    true,
  );
  await close(first.server);

  const reopened = await open();
  t.after(() => close(reopened.server));
  const afterRestart = await (await reopened.call("alice", "/people")).json();
  assert.deepEqual(
    afterRestart.people.toSorted((a: { displayName: string }, b: { displayName: string }) =>
      a.displayName.localeCompare(b.displayName),
    ),
    [
      { id: alice.id, displayName: "Alice", description: "", icon: null },
      { id: bob.id, displayName: "Bob", description: "", icon: null },
    ],
  );
  assert.deepEqual((await (await reopened.call("bob", "/account")).json()).directory, {
    description: "",
    hidden: false,
  });
  assert.equal(
    (
      await reopened.call("bob", "/account/directory-settings", {
        method: "PUT",
        body: JSON.stringify({ description: "Enjoys books", hidden: false }),
      })
    ).status,
    200,
  );
  assert.equal((await (await reopened.call("alice", "/people")).json()).people.length, 2);
  await ensureCanonicalUserProfileForVerifiedIdentity(
    { issuer: "https://other.example", subject: subjects.alice },
    stateOptions,
  );
  const expectedIds = new Set([alice.id, bob.id]);
  for (let index = 0; index < 101; index++) {
    const subject = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    allowedSubjects.push(subject);
    const created = await ensureCanonicalUserProfileForVerifiedIdentity(
      { issuer, subject },
      stateOptions,
    );
    expectedIds.add(created.id);
  }
  const page = await (await reopened.call("alice", "/people")).json();
  assert.equal(page.people.length, 100);
  assert.ok(page.nextCursor);
  const lastPage = await (
    await reopened.call("alice", `/people?cursor=${encodeURIComponent(page.nextCursor)}`)
  ).json();
  assert.equal(lastPage.nextCursor, null);
  assert.deepEqual(
    new Set([...page.people, ...lastPage.people].map((person: { id: string }) => person.id)),
    expectedIds,
  );
  assert.equal(await reopened.revokeProfile(bob.id), true);
  const afterRevoke = await (await reopened.call("alice", "/people")).json();
  const remainingPage = await (
    await reopened.call("alice", `/people?cursor=${encodeURIComponent(afterRevoke.nextCursor)}`)
  ).json();
  assert.ok(
    ![...afterRevoke.people, ...remainingPage.people].some(
      (person: { id: string }) => person.id === bob.id,
    ),
  );

  await mergeCanonicalUserProfiles(alice.id, bob.id, stateOptions);
  await assert.rejects(
    setCanonicalUserProfileDisplayName(alice.id, "Not Bob", {
      ...stateOptions,
      requireExactProfile: true,
    }),
  );
  assert.equal(
    await setCanonicalUserPreferences(
      alice.id,
      { "grogu.protected.directory": { description: "Not Bob", hidden: false } },
      { ...stateOptions, requireExactProfile: true },
    ),
    undefined,
  );
  assert.equal(
    await getCanonicalUserPreferences(alice.id, ["grogu.protected.directory"], {
      ...stateOptions,
      requireExactProfile: true,
    }),
    undefined,
  );
  assert.deepEqual(
    (await getCanonicalUserPreferences(bob.id, ["grogu.protected.directory"], stateOptions))
      ?.entries["grogu.protected.directory"],
    { description: "Enjoys books", hidden: false },
  );
});

void test("Family canonical turns save sources, widgets, and offline replies, then drain on shutdown", async (t) => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(
    stateDir && path.relative(path.resolve(".artifacts"), stateDir).startsWith("protected-proof-"),
    "Set an isolated OPENCLAW_STATE_DIR under .artifacts/protected-proof-*.",
  );
  protectedTestStateDirs.add(stateDir);
  const usersDir = path.join(stateDir, "users");
  const workspaceDir = path.join(stateDir, "workspace");
  const agentDir = path.join(stateDir, "agents", "protected", "agent");
  await Promise.all(
    [usersDir, workspaceDir, agentDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  const seen: Array<{
    auth: string | undefined;
    body: {
      model?: string;
      reasoning_effort?: string;
      messages?: unknown[];
      tools?: Array<{
        function: {
          name: string;
          parameters?: {
            properties?: Record<string, { properties?: Record<string, unknown> }>;
          };
        };
      }>;
    };
  }> = [];
  const activeProvider = Promise.withResolvers<void>();
  const providerDisconnected = Promise.withResolvers<void>();
  const offlineProvider = Promise.withResolvers<void>();
  const offlineRelease = Promise.withResolvers<void>();
  const routedChildRelease = Promise.withResolvers<void>();
  const offlineSettled = Promise.withResolvers<void>();
  const offlineDisconnected = Promise.withResolvers<void>();
  const offlinePrompt = "Finish this reply after the connection closes";
  const failedOfflinePrompt = "Fail this reply after the connection closes";
  const failedOfflineProvider = Promise.withResolvers<void>();
  const failedOfflineRelease = Promise.withResolvers<void>();
  const failedOfflineSettled = Promise.withResolvers<void>();
  const failedOfflineDisconnected = Promise.withResolvers<void>();
  t.after(() => offlineRelease.resolve());
  t.after(() => routedChildRelease.resolve());
  t.after(() => failedOfflineRelease.resolve());
  const sourceUrl = "https://example.com/family-source";
  const routePrompt = "Hand this trip to the right agent.";
  const routeBrief = "Plan a relaxed weekend in Lisbon for two adults.";
  const failedRoutePrompt = "Hand this unsuccessful request to travel.";
  const failedRouteBrief = "Simulate a specialist provider failure.";
  const selfRoutePrompt = "Hand this request back to yourself.";
  const rejectedKeyPrompt = "Use a revoked service key";
  const suffix = randomUUID();
  const rawGithubToken = `gho_family_${suffix}`;
  // Clients hold the relay producer's github.com-bound credential.
  const githubToken = bindGithubCopilotToken(rawGithubToken, "github.com");
  const hostTenant = "host-tenant.ghe.com";
  const anthropicKey = `sk-ant-family-${suffix}`;
  const openaiRefresh = `family-refresh-${suffix}`;
  const accountId = "family-synthetic-account";
  const openaiToken = `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url")}.family-${suffix}`;
  const fallback = `host-fallback-${suffix}`;
  const ambient = [
    "COPILOT_GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "COPILOT_GITHUB_DOMAIN",
  ];
  const prior = ambient.map((key) => process.env[key]);
  for (const key of ambient) {
    process.env[key] = key === "COPILOT_GITHUB_DOMAIN" ? hostTenant : fallback;
  }
  t.after(() =>
    ambient.forEach((key, index) => {
      const value = prior[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }),
  );
  const providerRequests: Array<{
    endpoint: string;
    authorization: string | null;
    account: string | null;
    key: string | null;
  }> = [];
  const copilotBodies: Array<{
    model?: string;
    input?: unknown;
    reasoning?: { effort?: string; summary?: string };
  }> = [];
  let copilotOverflow = false;
  let copilotSummary: string | undefined;
  let foreignAutomationId = "";
  let ownedAutomationId = "";
  let ownedAutomationVersion = "";
  let proposedAutomationDraft: Record<string, unknown> = {};
  let copilotUsage: Parameters<typeof responsesReply>[1] = {
    input_tokens: 3,
    output_tokens: 1,
    total_tokens: 4,
  };
  const originalFetch = globalThis.fetch;
  let fixtureCompleted = false;
  const opened: Array<() => Promise<void>> = [];
  installFixtureFetch(
    t,
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "127.0.0.1") {
        return originalFetch(input, init);
      }
      if (url.href !== sourceUrl) {
        const endpoint = `${url.origin}${url.pathname}`;
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        providerRequests.push({
          endpoint,
          authorization: headers.get("authorization"),
          account: headers.get("chatgpt-account-id"),
          key: headers.get("x-api-key"),
        });
        switch (endpoint) {
          case `https://api.${hostTenant}/copilot_internal/user`:
            return new Response(null, { status: 401 });
          case "https://api.github.com/copilot_internal/user":
            if (headers.get("authorization") === "Bearer denied-synthetic") {
              return new Response(null, { status: 401 });
            }
            return Response.json({ endpoints: { api: "https://api.business.githubcopilot.com" } });
          case "https://api.business.githubcopilot.com/models":
            return Response.json({
              data: [
                {
                  id: "gpt-5.3-codex",
                  name: "Default",
                  object: "model",
                  vendor: "OpenAI",
                  model_picker_enabled: true,
                  capabilities: { type: "chat", supports: { reasoning_effort: ["low", "high"] } },
                },
                {
                  id: "gpt-5.4",
                  name: "Second model",
                  object: "model",
                  vendor: " OpenAI ",
                  model_picker_enabled: true,
                  billing: {
                    token_prices: {
                      default: { input_price: 1, output_price: 1, max_prompt_tokens: 200_000 },
                      long_context: {
                        input_price: 2,
                        output_price: 2,
                        max_prompt_tokens: 1_000_000,
                      },
                    },
                  },
                  capabilities: {
                    type: "chat",
                    limits: { max_context_window_tokens: 1_000_000 },
                    supports: { reasoning_effort: ["low", "high"] },
                  },
                },
                {
                  id: "no-reasoning",
                  name: "No reasoning",
                  object: "model",
                  vendor: "   ",
                  model_picker_enabled: true,
                  capabilities: { type: "chat", supports: { reasoning_effort: [] } },
                },
                {
                  id: "hidden",
                  object: "model",
                  model_picker_enabled: false,
                  capabilities: { type: "chat" },
                },
              ],
            });
          case "https://api.business.githubcopilot.com/responses": {
            const body = await new Request(input, init).json();
            copilotBodies.push(body);
            if (
              !copilotOverflow &&
              JSON.stringify(body.input).includes("Trigger Copilot overflow")
            ) {
              copilotOverflow = true;
              return Response.json(
                {
                  error: {
                    message:
                      "This model's maximum context length is 200000 tokens. However, your messages resulted in 201000 tokens.",
                    code: "context_length_exceeded",
                  },
                },
                { status: 400 },
              );
            }
            return responsesReply("Canonical Copilot reply.", copilotUsage, copilotSummary);
          }
          case "https://chatgpt.com/backend-api/codex/responses":
            return responsesReply("Canonical OpenAI reply.");
          case "https://api.anthropic.com/v1/messages":
            return providerSse(
              [
                {
                  type: "message_start",
                  message: {
                    id: "msg_family",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-6",
                    content: [],
                    usage: { input_tokens: 3, output_tokens: 0 },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Canonical Anthropic reply." },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: 1 },
                },
                { type: "message_stop" },
              ],
              true,
            );
          default:
            return new Response(null, { status: 404 });
        }
      }
      return new Response(
        "<html><title>Synthetic source</title><p>Family source evidence.</p></html>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
    async () => {
      offlineRelease.resolve();
      await Promise.all(opened.map((shutdown) => shutdown()));
    },
    () => fixtureCompleted,
  );
  const provider = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (JSON.stringify(body.messages).includes(failedOfflinePrompt)) {
        failedOfflineProvider.resolve();
        await failedOfflineRelease.promise;
        response
          .writeHead(401, { "content-type": "application/json" })
          .end(
            '{"error":{"message":"Invalid API key synthetic-private-error","code":"invalid_api_key"}}',
          );
        return;
      }
      if (JSON.stringify(body.messages).includes(rejectedKeyPrompt)) {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":{"message":"Invalid API key","code":"invalid_api_key"}}');
        return;
      }
      if (JSON.stringify(body.messages).includes(failedRouteBrief)) {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":{"message":"Synthetic provider failure","code":"invalid_api_key"}}');
        return;
      }
      seen.push({ auth: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (JSON.stringify(body.messages).includes("Hold the provider response open")) {
        response.once("close", () => providerDisconnected.resolve());
        response.flushHeaders();
        activeProvider.resolve();
        return;
      }
      if (JSON.stringify(body.messages).includes(offlinePrompt)) {
        response.flushHeaders();
        offlineProvider.resolve();
        await offlineRelease.promise;
      }
      const finalWidgetTurn = JSON.stringify(body.messages).includes(
        "Finish this answer with only a widget.",
      );
      const widgetArguments = JSON.stringify({
        title: "Synthetic widget",
        widget_code: "<p>Scoped widget body</p>",
        ...(finalWidgetTurn ? { final: true } : {}),
      });
      const researchTurn = JSON.stringify(body.messages).includes(
        "Use concise, evidence-based summaries.",
      );
      // Selectable agents' intents are in the shared header, so match the current-agent section.
      const cleanupTurn = JSON.stringify(body.messages).includes(
        "## Current agent: Cleanup proof (cleanup)",
      );
      const groguTurn = JSON.stringify(body.messages).includes("## Current agent: Grogu (grogu)");
      const routedTravelTurn =
        JSON.stringify(body.messages).includes("## Current agent: Travel (travel)") &&
        JSON.stringify(body.messages).includes(routeBrief);
      const routeArguments = JSON.stringify(body.messages).includes(routePrompt)
        ? { agentId: "travel", brief: routeBrief }
        : JSON.stringify(body.messages).includes(failedRoutePrompt)
          ? { agentId: "travel", brief: failedRouteBrief }
          : JSON.stringify(body.messages).includes(selfRoutePrompt)
            ? { agentId: "grogu", brief: "Answer it yourself." }
            : undefined;
      const hasToolResponse = body.messages.some(
        (message: { role?: string }) => message.role === "tool",
      );
      if (routedTravelTurn && hasToolResponse) {
        response.flushHeaders();
        await routedChildRelease.promise;
      }
      const sessionListTurn = JSON.stringify(body.messages).includes(
        "Inspect my permitted sessions.",
      );
      const automationChatTurn = JSON.stringify(body.messages).includes(
        "Use private automation chat tools.",
      );
      const frames =
        groguTurn && routeArguments && !hasToolResponse
          ? [
              [{ role: "assistant", content: "Travel will help with this." }, null],
              [
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_route",
                      type: "function",
                      function: {
                        name: "route_to_agent",
                        arguments: JSON.stringify(routeArguments),
                      },
                    },
                  ],
                },
                null,
              ],
              [{}, "tool_calls"],
            ]
          : automationChatTurn && !hasToolResponse
            ? [
                [
                  {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_automations_list",
                        type: "function",
                        function: {
                          name: "automations_list",
                          arguments: JSON.stringify({ limit: 10 }),
                        },
                      },
                      {
                        index: 1,
                        id: "call_automations_read_foreign",
                        type: "function",
                        function: {
                          name: "automations_read",
                          arguments: JSON.stringify({ automationId: foreignAutomationId }),
                        },
                      },
                      {
                        index: 2,
                        id: "call_automations_propose_create",
                        type: "function",
                        function: {
                          name: "automations_propose_create",
                          arguments: JSON.stringify({ draft: proposedAutomationDraft }),
                        },
                      },
                      {
                        index: 3,
                        id: "call_automations_propose_patch",
                        type: "function",
                        function: {
                          name: "automations_propose_patch",
                          arguments: JSON.stringify({
                            automationId: ownedAutomationId,
                            expectedVersion: ownedAutomationVersion,
                            patch: { name: "Alice proposed automation update" },
                          }),
                        },
                      },
                      {
                        index: 4,
                        id: "call_sessions_list",
                        type: "function",
                        function: {
                          name: "sessions_list",
                          arguments: JSON.stringify({ limit: 25 }),
                        },
                      },
                      {
                        index: 5,
                        id: "call_sessions_history_owned",
                        type: "function",
                        function: {
                          name: "sessions_history",
                          arguments: JSON.stringify({
                            sessionKey: sessionHistoryTargets.permitted,
                          }),
                        },
                      },
                      {
                        index: 6,
                        id: "call_sessions_history_foreign",
                        type: "function",
                        function: {
                          name: "sessions_history",
                          arguments: JSON.stringify({
                            sessionKey: sessionHistoryTargets.foreign,
                          }),
                        },
                      },
                      {
                        index: 7,
                        id: "callsessionssearch",
                        type: "function",
                        function: {
                          name: "sessions_search",
                          arguments: JSON.stringify({ query: "transcript marker" }),
                        },
                      },
                    ],
                  },
                  null,
                ],
                [{}, "tool_calls"],
              ]
            : (cleanupTurn || finalWidgetTurn || routedTravelTurn) && !hasToolResponse
              ? [
                  [
                    {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_widget_cleanup",
                          type: "function",
                          function: { name: "show_widget", arguments: widgetArguments },
                        },
                      ],
                    },
                    null,
                  ],
                  [{}, "tool_calls"],
                ]
              : sessionListTurn && !hasToolResponse && sessionHistoryTargets
                ? [
                    [
                      {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_sessions_list",
                            type: "function",
                            function: {
                              name: "sessions_list",
                              arguments: JSON.stringify({ limit: 25 }),
                            },
                          },
                          {
                            index: 1,
                            id: "call_sessions_history_owned",
                            type: "function",
                            function: {
                              name: "sessions_history",
                              arguments: JSON.stringify({
                                sessionKey: sessionHistoryTargets.permitted,
                              }),
                            },
                          },
                          {
                            index: 2,
                            id: "call_sessions_history_foreign",
                            type: "function",
                            function: {
                              name: "sessions_history",
                              arguments: JSON.stringify({
                                sessionKey: sessionHistoryTargets.foreign,
                              }),
                            },
                          },
                          {
                            index: 3,
                            id: "callsessionssearch",
                            type: "function",
                            function: {
                              name: "sessions_search",
                              arguments: JSON.stringify({ query: "transcript marker" }),
                            },
                          },
                        ],
                      },
                      null,
                    ],
                    [{}, "tool_calls"],
                  ]
                : researchTurn && !hasToolResponse
                  ? [
                      [
                        {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_fetch_research",
                              type: "function",
                              function: {
                                name: "web_fetch",
                                arguments: JSON.stringify({ url: sourceUrl }),
                              },
                            },
                          ],
                        },
                        null,
                      ],
                      [{}, "tool_calls"],
                    ]
                  : !researchTurn && seen.length === 1
                    ? [
                        [{ role: "assistant", reasoning_content: "Check the source. " }, null],
                        [{ reasoning_content: "Prepare the widget." }, null],
                        [
                          {
                            role: "assistant",
                            tool_calls: [
                              {
                                index: 0,
                                id: "call_widget_1",
                                type: "function",
                                function: { name: "show_widget", arguments: widgetArguments },
                              },
                              {
                                index: 1,
                                id: "call_fetch_1",
                                type: "function",
                                function: {
                                  name: "web_fetch",
                                  arguments: JSON.stringify({ url: sourceUrl }),
                                },
                              },
                            ],
                          },
                          null,
                        ],
                        [{}, "tool_calls"],
                      ]
                    : [
                        [
                          {
                            role: "assistant",
                            content:
                              automationChatTurn && hasToolResponse
                                ? "Proposed only; nothing was saved."
                                : "Committed synthetic answer.",
                          },
                          null,
                        ],
                        [{}, "stop"],
                      ];
      for (const [delta, finish_reason] of frames) {
        response.write(
          `data: ${JSON.stringify({
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: "synthetic",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch(() => response.destroy());
  });
  const providerOrigin = await listen(provider);
  t.after(() => close(provider));
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const serviceConfig = protectedOpenClawConfig(
    stateDir,
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const protectedConfig: OpenClawConfig = {
    ...serviceConfig,
    agents: {
      ...serviceConfig.agents,
      defaults: {
        ...serviceConfig.agents?.defaults,
        models: { "openai/gpt-5.6-luna": { params: { transport: "sse" } } },
      },
      entries: { protected: { workspace: workspaceDir, agentDir } },
    },
    models: {
      mode: "replace" as const,
      providers: {
        // Conflicting ambient tenant config; bound relay credentials must ignore it.
        "github-copilot": {
          baseUrl: `https://copilot-api.${hostTenant}`,
          params: { githubDomain: hostTenant },
          models: [],
        },
        sparky: {
          baseUrl: `${providerOrigin}/v1`,
          api: "openai-completions",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "synthetic",
              name: "Synthetic",
              reasoning: true,
              compat: { supportsReasoningEffort: true },
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
  const { publishConfiguredModelRuntimeSnapshots } =
    await import("../../src/gateway/server-startup-model-runtime.js");
  const identityFor =
    (subject: string, session: string): ProtectedIdentityVerifier =>
    async () => ({
      issuer: "https://synthetic.example",
      subject,
      kind: "human",
      expiresAt,
      sessionId: createHash("sha256").update(session).digest("hex"),
      assertCurrent() {},
      async revalidate() {},
    });
  const options = {
    origin,
    accessIssuer: "https://synthetic.example",
    ownerSubject: "synthetic-sparky",
    stateDir,
    usersRoot: await root(usersDir),
    encryption,
    agentExtensions: [protectedResearchAgent, protectedCleanupAgent],
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 16_000_000, userBytes: 8_000_000, freeFloorBytes: 1 },
    directory: { issuer: "https://synthetic.example", allowedSubjects: ["synthetic-sparky"] },
    verifyIdentity: identityFor("synthetic-sparky", "synthetic-session"),
    turns: createCanonicalProtectedTurns({
      config: protectedConfig,
      workspaceDir,
      agentDir,
      models: [
        withThinking(
          { provider: "sparky", id: "synthetic", label: "Synthetic" },
          { provider: "sparky", id: "synthetic", reasoning: true },
        ),
        { provider: "github-copilot", id: "gpt-5.3-codex", label: "Copilot" },
        { provider: "openai", id: "gpt-5.6-luna", label: "OpenAI" },
        withThinking(
          { provider: "anthropic", id: "claude-sonnet-4-6", label: "Anthropic" },
          {
            provider: "anthropic",
            id: "claude-sonnet-4-6",
            api: "anthropic-messages",
            reasoning: true,
          },
        ),
      ],
      resolveSparkyKey: async () => "synthetic-request-only-key",
    }),
  };
  const generatedFileName = `artifact-${randomUUID()}-overview.html`;
  const generatedFileHtml = "<p>Private generated artifact content.</p>";
  const runWithGeneratedArtifact = options.turns.run.bind(options.turns);
  options.turns.run = async (turn) => {
    await runWithGeneratedArtifact(turn);
    if (turn.input.text === "Reply briefly") {
      await turn.files.write(`chats/${turn.id}/artifacts/${generatedFileName}`, generatedFileHtml);
    }
  };
  const sendNotification = mock.fn(
    async (..._args: Parameters<typeof import("web-push").sendNotification>) => ({
      statusCode: 201,
    }),
  );
  const webPushMock = mock.module("web-push", {
    defaultExport: {
      generateVAPIDKeys: () => ({ publicKey: "synthetic-public", privateKey: "synthetic-private" }),
      setVapidDetails() {},
      sendNotification,
    },
  });
  t.after(() => webPushMock.restore());
  assert.equal(
    await addProtectedSubject(stateDir, {
      issuer: "https://synthetic.example",
      subject: "synthetic-sparky",
    }),
    "added",
  );
  const open = async () => {
    await publishConfiguredModelRuntimeSnapshots({ cfg: protectedConfig, workspaceDir });
    const app = createProtectedHttp(options);
    const server = createProtectedServer(origin, app.fetch);
    server.on("request", (incoming, outgoing) => {
      if (incoming.headers["x-proof-disconnect"] === "yes") {
        outgoing.once("close", () => offlineDisconnected.resolve());
      }
      if (incoming.headers["x-proof-disconnect"] === "failure") {
        outgoing.once("close", () => failedOfflineDisconnected.resolve());
      }
    });
    const url = await listen(server);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => (shutdownPromise ??= closeProtectedServer(server, app, stateDir));
    opened.push(shutdown);
    const call = (route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", headers.get("origin") ?? origin);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      return fetch(`${url}/api/protected/v1${route}`, { ...init, headers });
    };
    return { call, shutdown };
  };
  const { call, shutdown } = await open();
  const me = await call("/me");
  assert.equal(me.status, 200, await me.clone().text());
  const meBody = await me.json();
  const { user, models: fixedModels } = meBody;
  await t.test("offers provider-backed context sizes only to capable clients", async () => {
    const listing = (capability?: string) =>
      call("/providers/github-copilot/models", {
        method: "POST",
        headers: {
          "x-grogu-profile": user.id,
          ...(capability ? { "x-alcove-capabilities": capability } : {}),
        },
        body: JSON.stringify({ credential: { accessToken: githubToken } }),
      });
    const { models } = await (await listing("model-context-v1")).json();
    assert.deepEqual(models[1].contextSizes, {
      options: [200_000, 1_000_000],
      default: 200_000,
      longContextSurcharge: true,
    });
    assert.equal(models[0].contextSizes, undefined);
    assert.equal((await (await listing()).json()).models[1].contextSizes, undefined);
  });
  await t.test("uses and restores the selected Copilot context budget", async () => {
    const created = await call("/chats", { method: "POST", body: "{}" });
    const { chat } = await created.json();
    const route = `/chats/${chat.id}`;
    const headers = { "x-grogu-profile": user.id, "x-alcove-capabilities": "model-context-v1" };
    const turn = (contextSize: number, text = "Test selected context") =>
      call(`${route}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "github-copilot",
          model: "gpt-5.4",
          text,
          thinking: "high",
          contextSize,
          credential: { accessToken: githubToken },
        }),
      });
    const invalid = await turn(300_000);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "context_size_unavailable");
    for (const contextSize of [200_000, 1_000_000]) {
      const response = await turn(contextSize);
      assert.equal(response.status, 200);
      const events = (await response.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.find((event) => event.type === "usage")?.contextSize, contextSize);
      const saved = await (await call(route, { headers })).json();
      assert.equal(saved.usage?.contextSize, contextSize);
      const legacy = await (await call(route)).json();
      assert.equal(legacy.usage?.contextSize, undefined);
    }
    const priorCompaction = protectedConfig.agents?.defaults?.compaction;
    assert.ok(protectedConfig.agents?.defaults);
    protectedConfig.agents.defaults.compaction = {
      mode: "default",
      keepRecentTokens: 1,
      postIndexSync: "off",
    };
    const bodyStart = copilotBodies.length;
    const requestStart = providerRequests.length;
    try {
      const recovered = await turn(200_000, "Trigger Copilot overflow");
      const events = (await recovered.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(copilotOverflow, true);
      assert.ok(
        copilotBodies
          .slice(bodyStart)
          .some((body) => JSON.stringify(body.input).includes("context summarization assistant")),
      );
      assert.ok(
        providerRequests
          .slice(requestStart)
          .filter(({ endpoint }) => endpoint.endsWith("/responses"))
          .every(({ authorization }) => authorization === `Bearer ${rawGithubToken}`),
      );
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.find((event) => event.type === "usage")?.contextSize, 200_000);
    } finally {
      protectedConfig.agents.defaults.compaction = priorCompaction;
    }
    const current = await (await call(route)).json();
    assert.equal(
      (await call(route, { method: "DELETE", headers: { "if-match": current.chat.version } }))
        .status,
      204,
    );
  });
  await t.test(
    "compacts the same retained context only at the smaller selected budget",
    async () => {
      assert.ok(protectedConfig.agents?.defaults);
      const priorCompaction = protectedConfig.agents.defaults.compaction;
      const priorUsage = copilotUsage;
      protectedConfig.agents.defaults.compaction = {
        mode: "default",
        keepRecentTokens: 1,
        postIndexSync: "off",
      };
      const headers = { "x-grogu-profile": user.id, "x-alcove-capabilities": "model-context-v1" };
      try {
        for (const contextSize of [1_000_000, 200_000]) {
          const { chat } = await (await call("/chats", { method: "POST", body: "{}" })).json();
          const route = `/chats/${chat.id}`;
          const send = async (size: number, text: string) => {
            const response = await call(`${route}/turns`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                provider: "github-copilot",
                model: "gpt-5.4",
                text,
                thinking: "high",
                contextSize: size,
                credential: { accessToken: githubToken },
              }),
            });
            assert.equal(response.status, 200);
            const trace = await response.text();
            assert.match(trace, /"type":"done"/u);
          };
          copilotUsage = { input_tokens: 210_000, output_tokens: 1, total_tokens: 210_001 };
          await send(1_000_000, "Retain the same synthetic context");
          copilotUsage = priorUsage;
          const bodyStart = copilotBodies.length;
          await send(contextSize, "Continue this conversation");
          const summarized = copilotBodies
            .slice(bodyStart)
            .some((body) => JSON.stringify(body.input).includes("context summarization assistant"));
          assert.equal(summarized, contextSize === 200_000);
          const current = await (await call(route)).json();
          assert.equal(
            (await call(route, { method: "DELETE", headers: { "if-match": current.chat.version } }))
              .status,
            204,
          );
        }
      } finally {
        protectedConfig.agents.defaults.compaction = priorCompaction;
        copilotUsage = priorUsage;
      }
    },
  );
  const contextProofUsage = await listProtectedUsage(stateDir, user.id, Date.now());
  const contextProofTokens = contextProofUsage.reduce((total, day) => total + day.tokens, 0);
  assert.equal("feedback" in meBody.capabilities, false);
  assert.equal("telemetry" in meBody.capabilities, false);
  const sparkyModel = fixedModels.find(
    (model: { provider: string }) => model.provider === "sparky",
  );
  assert.equal(sparkyModel.thinking.default, "ultra");
  assert.deepEqual(sparkyModel.thinking.orchestrationLevels, ["ultra"]);
  assert.equal(sparkyModel.thinking.nativeChoices, undefined);
  const claudeModel = fixedModels.find(
    (model: { provider: string }) => model.provider === "anthropic",
  );
  assert.equal(claudeModel.thinking.default, "adaptive");
  assert.deepEqual(
    claudeModel.thinking.nativeChoices.find((choice: { level: string }) => choice.level === "low")
      .aliases,
    ["minimal"],
  );
  assert.deepEqual(
    claudeModel.thinking.nativeChoices.find((choice: { level: string }) => choice.level === "high")
      .aliases,
    ["adaptive"],
  );
  const created = await call("/chats", { method: "POST", body: "{}" });
  assert.equal(created.status, 200, await created.clone().text());
  const { chat } = await created.json();
  const priorGeneratedFileName = `artifact-${randomUUID()}-overview.html`;
  const seedFiles = await createAuthorizedUserFiles({
    usersRoot: await root(usersDir),
    profileId: user.id,
    assertCurrent() {},
    maxBytes: 64_000,
    encryption,
  });
  try {
    await seedFiles.write(
      `chats/${chat.id}/artifacts/${priorGeneratedFileName}`,
      "<p>Prior reply artifact.</p>",
    );
    await seedFiles.write(`chats/${chat.id}/web-fetch/overview.html`, "<p>Prior download.</p>");
  } finally {
    seedFiles.dispose();
  }
  const response = await call(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Reply briefly"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /"type":"done"/);
  const events = stream
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(
    events
      .filter((event) => event.type === "reasoning")
      .map((event) => event.text)
      .join(""),
    "Check the source. Prepare the widget.",
  );
  for (const [id, kind] of [
    ["call_widget_1", "widget"],
    ["call_fetch_1", "fetch"],
  ]) {
    const activity = events.filter((event) => event.type === "activity" && event.id === id);
    assert.deepEqual(
      activity.map((event) => [event.kind, event.status]),
      [
        [kind, "running"],
        [kind, "done"],
      ],
    );
    assert.ok(activity.every((event) => !JSON.stringify(event).includes("widget_code")));
  }
  assert.ok(
    events.some(
      (event) => event.type === "widget-draft" && event.html?.includes("Scoped widget body"),
    ),
  );
  const widget = events.find((event) => event.type === "widget");
  assert.ok(widget, "the scoped canvas result reaches the HTTP stream");
  assert.ok(
    events.some(
      (event) =>
        event.type === "sources" &&
        event.sources.some((source: { url: string }) => source.url === sourceUrl),
    ),
    "the canonical web_fetch result reaches the HTTP stream",
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(events.at(-2), {
    type: "usage",
    contextTokens: 3,
    inputTokens: 6,
    outputTokens: 4,
  });
  assert.equal(seen[0]?.auth, "Bearer synthetic-request-only-key");
  const sharedTools = [
    "sessions_history",
    "sessions_list",
    "sessions_search",
    "sessions_send",
    "show_widget",
    "web_fetch",
    "web_search",
  ];
  const mainRunTools = ["route_to_agent", ...sharedTools];
  // Core subagent policy withholds sessions_send from native children; they answer through the announce chain.
  const childTools = sharedTools.filter((name) => name !== "sessions_send");
  const toolNames = (request: (typeof seen)[number] | undefined) =>
    request?.body.tools?.map((tool) => tool.function.name).toSorted();
  const systemText = (request: (typeof seen)[number] | undefined) => {
    const content = (request?.body.messages?.[0] as { content?: unknown } | undefined)?.content;
    assert.equal(typeof content, "string", "the system prompt is the first request message");
    return content as string;
  };
  const sharedPrefix = (request: (typeof seen)[number] | undefined) => {
    const text = systemText(request);
    const start = text.indexOf("\n# Alcove\n");
    const end = text.indexOf("\n## Current agent: ");
    assert.ok(start >= 0 && end > start, "the request contains the shared Alcove section");
    return text.slice(start, end);
  };
  assert.deepEqual(toolNames(seen[0]), mainRunTools);
  assert.match(systemText(seen[0]), /\n# Alcove\n/);
  const { call: reopened, shutdown: reopenedShutdown } = await open();
  const read = await (await reopened(`/chats/${chat.id}`)).json();
  assert.deepEqual(read.usage, {
    contextTokens: 3,
    inputTokens: 6,
    outputTokens: 4,
    provider: "sparky",
    model: "synthetic",
  });
  assert.match(JSON.stringify(read), /Committed synthetic answer\./);
  assert.equal(read.chat.messages.at(-1).reasoning, "Check the source. Prepare the widget.");
  assert.deepEqual(
    read.chat.messages
      .at(-1)
      .activity.map((item: { id: string; kind: string; status: string }) => [
        item.id,
        item.kind,
        item.status,
      ]),
    [
      ["call_widget_1", "widget", "done"],
      ["call_fetch_1", "fetch", "done"],
    ],
  );
  assert.ok(Number.isInteger(read.chat.messages.at(-1).durationMs));
  assert.doesNotMatch(JSON.stringify(read), /synthetic-request-only-key|Scoped widget body/);
  assert.notEqual(read.chat.version, chat.version);
  assert.deepEqual(read.chat.messages.at(-1).widgets, [
    { id: widget.id, title: "Synthetic widget" },
  ]);
  const widgetResponse = await reopened(`/chats/${chat.id}/widgets/${widget.id}`);
  assert.equal(widgetResponse.status, 200);
  assert.match((await widgetResponse.json()).html, /Scoped widget body/);
  const exported = await reopened("/export", {
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(exported.status, 200, await exported.clone().text());
  const exportedChats = await exported.json();
  assert.ok(exportedChats.chats.some((item: { id: string }) => item.id === chat.id));
  assert.match(JSON.stringify(exportedChats), /Committed synthetic answer\./);
  const profileDirectory = path.join(usersDir, createHash("sha256").update(user.id).digest("hex"));
  const storedFiles = (
    await readdir(profileDirectory, { recursive: true, withFileTypes: true })
  ).filter((entry) => entry.isFile());
  assert.ok(storedFiles.length > 0);
  for (const entry of storedFiles) {
    const bytes = await readFile(path.join(entry.parentPath, entry.name));
    assert.ok(!bytes.includes("Scoped widget body"));
    assert.ok(!bytes.includes("Synthetic widget"));
  }
  const feedbackHeaders = { "X-Alcove-Capabilities": "feedback-v1" };
  const reportChatHeaders = {
    "X-Alcove-Capabilities": "profile-v1,feedback-v1,report-chat-v1",
  };
  const feedbackMe = await reopened("/me", { headers: feedbackHeaders });
  assert.equal(feedbackMe.status, 200);
  assert.deepEqual((await feedbackMe.json()).capabilities, {
    copilotConnect: false,
    openaiConnect: false,
    admin: true,
    feedback: true,
    telemetry: true,
  });
  const responseId = read.chat.messages.at(-1).id;
  const ratingRoute = `/chats/${chat.id}/responses/${responseId}/feedback`;
  const ratingResponse = await reopened(ratingRoute, {
    method: "PUT",
    headers: feedbackHeaders,
    body: JSON.stringify({ rating: "up" }),
  });
  assert.equal(ratingResponse.status, 200, await ratingResponse.clone().text());
  assert.deepEqual(await ratingResponse.json(), {
    feedback: { responseId, rating: "up", reportId: null },
  });
  const clearedRating = await reopened(ratingRoute, {
    method: "PUT",
    headers: feedbackHeaders,
    body: JSON.stringify({ rating: null }),
  });
  assert.equal(clearedRating.status, 200);
  assert.deepEqual(await clearedRating.json(), {
    feedback: { responseId, rating: null, reportId: null },
  });
  const unknownFeedback = await reopened(`/chats/${chat.id}/responses/${randomUUID()}/feedback`, {
    method: "PUT",
    headers: feedbackHeaders,
    body: JSON.stringify({ rating: "up" }),
  });
  assert.equal(unknownFeedback.status, 404);
  assert.deepEqual(await unknownFeedback.json(), { error: "not_found" });
  const submissionId = randomUUID();
  const reportRoute = `/chats/${chat.id}/responses/${responseId}/reports`;
  const reportBody = {
    submissionId,
    category: "other",
    description: "password: synthetic-report-secret-123456",
    includeEvidence: true,
    includeChat: true,
  };
  const pushSubscription = await reopened("/admin/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: "https://push.example.invalid/device",
      keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
    }),
  });
  assert.equal(pushSubscription.status, 200, await pushSubscription.clone().text());
  const submittedReport = await reopened(reportRoute, {
    method: "POST",
    headers: reportChatHeaders,
    body: JSON.stringify(reportBody),
  });
  assert.equal(submittedReport.status, 201, await submittedReport.clone().text());
  const reportResult = await submittedReport.json();
  const replayedReport = await reopened(reportRoute, {
    method: "POST",
    headers: reportChatHeaders,
    body: JSON.stringify(reportBody),
  });
  assert.equal(replayedReport.status, 200);
  assert.deepEqual(await replayedReport.json(), reportResult);
  const duplicateReport = await reopened(reportRoute, {
    method: "POST",
    headers: reportChatHeaders,
    body: JSON.stringify({ ...reportBody, submissionId: randomUUID() }),
  });
  assert.equal(duplicateReport.status, 409);
  assert.deepEqual(await duplicateReport.json(), { error: "already_reported" });
  const feedbackList = await reopened(`/chats/${chat.id}/feedback`, {
    headers: feedbackHeaders,
  });
  assert.deepEqual(await feedbackList.json(), {
    feedback: [{ responseId, rating: "down", reportId: reportResult.report.id }],
  });
  const reportListResponse = await reopened("/admin/reports?status=open", {
    headers: feedbackHeaders,
  });
  assert.equal(reportListResponse.status, 200);
  const reportList = await reportListResponse.json();
  assert.equal(reportList.openCount, 1);
  assert.equal("reviewedAt" in reportList.reports[0], false);
  assert.equal(reportList.reports[0].excerpt.includes("synthetic-report-secret-123456"), false);
  const reportDetailResponse = await reopened(`/admin/reports/${reportResult.report.id}`, {
    headers: feedbackHeaders,
  });
  assert.equal(reportDetailResponse.status, 200, await reportDetailResponse.clone().text());
  const reportDetail = await reportDetailResponse.json();
  assert.equal(reportDetail.report.description.includes("synthetic-report-secret-123456"), false);
  assert.equal(reportDetail.report.evidence.state, "available");
  assert.match(reportDetail.report.evidence.prompt, /Reply briefly/u);
  assert.match(reportDetail.report.evidence.response, /Committed synthetic answer/u);
  assert.deepEqual(reportDetail.report.evidence.sources, [
    { title: "Synthetic source", url: sourceUrl },
  ]);
  assert.deepEqual(reportDetail.report.evidence.widgets, [
    { id: widget.id, title: "Synthetic widget" },
  ]);
  assert.deepEqual(reportDetail.report.evidence.files, [
    {
      id: `generated~${chat.id}~${generatedFileName}`,
      name: "overview.html",
      size: Buffer.byteLength(generatedFileHtml),
      origin: "produced",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(reportDetail),
    /Private generated artifact content|Scoped widget body/u,
  );
  assert.equal("chatReference" in reportDetail.report, false);
  assert.equal("chatIncluded" in reportDetail.report, false);
  const reportChatRoute = `/admin/reports/${reportResult.report.id}/chat`;
  assert.equal((await reopened(reportChatRoute, { headers: feedbackHeaders })).status, 404);
  const reportChatMe = await (await reopened("/me", { headers: reportChatHeaders })).json();
  assert.equal(Value.Check(ProtectedMeSchema, reportChatMe), true);
  const reportChatResponse = await reopened(reportChatRoute, { headers: reportChatHeaders });
  assert.equal(reportChatResponse.status, 200, await reportChatResponse.clone().text());
  const reportedChat = (await reportChatResponse.json()).chat;
  assert.equal(reportedChat.state, "available");
  assert.equal(reportedChat.nextCursor, null);
  assert.ok(
    reportedChat.items.some(
      (item: { kind: string; text?: string; reported: boolean }) =>
        item.kind === "message" && item.reported && item.text?.includes("Reply briefly"),
    ),
  );
  assert.ok(
    reportedChat.items.some(
      (item: { kind: string; name?: string }) =>
        item.kind === "tool" && item.name === "show_widget",
    ),
  );
  assert.ok(
    reportedChat.items.some(
      (item: { kind: string; fileId?: string; readable?: boolean }) =>
        item.kind === "file" &&
        item.fileId === `generated~${chat.id}~${generatedFileName}` &&
        item.readable === false,
    ),
  );
  assert.doesNotMatch(JSON.stringify(reportedChat), /synthetic-request-only-key/u);
  const reviewResponse = await reopened(`/admin/reports/${reportResult.report.id}`, {
    method: "PATCH",
    headers: feedbackHeaders,
    body: JSON.stringify({ status: "reviewed" }),
  });
  assert.equal(reviewResponse.status, 200);
  assert.equal((await reviewResponse.json()).report.status, "reviewed");
  const telemetryRoute = `/admin/telemetry?days=7&member=${encodeURIComponent(user.id)}`;
  const telemetryResponse = await reopened(telemetryRoute, {
    headers: feedbackHeaders,
  });
  assert.equal(telemetryResponse.status, 200);
  const telemetry = await telemetryResponse.json();
  assert.equal(
    telemetry.features.some((feature: { id: string }) => feature.id === "chat"),
    true,
  );
  assert.equal(telemetry.totals.reports, 1);
  assert.equal(telemetry.totals.ratingsDown, 1);
  assert.equal(telemetry.totals.runs, 8);
  const attributedRun = telemetry.runs.find(
    (run: { chatId: string | null; provider: string | null; model: string | null }) =>
      run.chatId === chat.id && run.provider === "sparky" && run.model === "synthetic",
  );
  assert.ok(attributedRun);
  assert.deepEqual(Object.keys(attributedRun).toSorted(), [
    "admissionMs",
    "agentId",
    "at",
    "cacheReadTokens",
    "cacheWriteTokens",
    "chatId",
    "completionMs",
    "errorCode",
    "feature",
    "firstOutputMs",
    "firstVisibleMs",
    "id",
    "inputTokens",
    "memberLabel",
    "model",
    "outputTokens",
    "personId",
    "provider",
    "providerStartMs",
    "reasoningSummaryChars",
    "responseId",
    "status",
    "totalTokens",
  ]);
  for (const timing of [
    attributedRun.admissionMs,
    attributedRun.providerStartMs,
    attributedRun.firstOutputMs,
    attributedRun.firstVisibleMs,
    attributedRun.completionMs,
  ]) {
    assert.equal(timing === null || (Number.isSafeInteger(timing) && timing >= 0), true);
  }
  assert.ok(
    attributedRun.providerStartMs === null ||
      attributedRun.firstOutputMs === null ||
      attributedRun.providerStartMs <= attributedRun.firstOutputMs,
  );
  assert.ok(
    attributedRun.firstOutputMs === null ||
      attributedRun.completionMs === null ||
      attributedRun.firstOutputMs <= attributedRun.completionMs,
  );
  const memberSubject = "synthetic-member";
  assert.equal(
    await addProtectedSubject(stateDir, {
      issuer: "https://synthetic.example",
      subject: memberSubject,
    }),
    "added",
  );
  const ordinaryApp = createProtectedHttp({
    ...options,
    directory: {
      issuer: "https://synthetic.example",
      allowedSubjects: ["synthetic-sparky", memberSubject],
    },
    verifyIdentity: identityFor(memberSubject, "synthetic-member-session"),
  });
  t.after(() => ordinaryApp.shutdown());
  const ordinaryHeaders = new Headers(reportChatHeaders);
  ordinaryHeaders.set("origin", origin);
  ordinaryHeaders.set("content-type", "application/json");
  const memberMeResponse = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/me`, { headers: ordinaryHeaders }),
  );
  const memberMe = await memberMeResponse.json();
  ordinaryHeaders.set("x-grogu-profile", memberMe.user.id);
  const ordinaryAdminRoutes = [
    { path: "/admin/reports?status=all", method: "GET" },
    { path: `/admin/reports/${reportResult.report.id}`, method: "GET" },
    { path: reportChatRoute, method: "GET" },
    {
      path: `/admin/reports/${reportResult.report.id}`,
      method: "PATCH",
      body: JSON.stringify({ status: "reviewed" }),
    },
    { path: "/admin/telemetry", method: "GET" },
  ];
  for (const route of ordinaryAdminRoutes) {
    const adminResponse = await ordinaryApp.fetch(
      new Request(`${origin}/api/protected/v1${route.path}`, {
        method: route.method,
        headers: ordinaryHeaders,
        ...(route.body ? { body: route.body } : {}),
      }),
    );
    assert.equal(adminResponse.status, 403, route.path);
    assert.deepEqual(await adminResponse.json(), { error: "owner_required" });
  }
  const ordinaryFeedbackRead = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/chats/${chat.id}/feedback`, {
      headers: ordinaryHeaders,
    }),
  );
  assert.equal(ordinaryFeedbackRead.status, 404);
  const ordinaryAssetRead = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/files/${chat.id}~private.txt`, {
      headers: ordinaryHeaders,
    }),
  );
  assert.equal(ordinaryAssetRead.status, 404);
  const memberChatResponse = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/chats`, {
      method: "POST",
      headers: ordinaryHeaders,
      body: "{}",
    }),
  );
  assert.equal(memberChatResponse.status, 200);
  const memberChat = (await memberChatResponse.json()).chat;
  const memberTurnResponse = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/chats/${memberChat.id}/turns`, {
      method: "POST",
      headers: ordinaryHeaders,
      body: JSON.stringify({ provider: "sparky", text: "Synthetic member report evidence." }),
    }),
  );
  const memberTurnBody = await memberTurnResponse.text();
  assert.equal(memberTurnResponse.status, 200, memberTurnBody);
  assert.ok(
    memberTurnBody
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .some((event) => event.type === "done"),
  );
  const memberHistoryResponse = await ordinaryApp.fetch(
    new Request(`${origin}/api/protected/v1/chats/${memberChat.id}`, {
      headers: ordinaryHeaders,
    }),
  );
  const memberHistory = (await memberHistoryResponse.json()).chat;
  const memberResponse = memberHistory.messages.findLast(
    (message: { role: string }) => message.role === "assistant",
  );
  assert.ok(memberResponse);
  const legacyMemberReportHeaders = new Headers(ordinaryHeaders);
  legacyMemberReportHeaders.set("X-Alcove-Capabilities", "feedback-v1");
  const memberReportResponse = await ordinaryApp.fetch(
    new Request(
      `${origin}/api/protected/v1/chats/${memberChat.id}/responses/${memberResponse.id}/reports`,
      {
        method: "POST",
        headers: legacyMemberReportHeaders,
        body: JSON.stringify({
          submissionId: randomUUID(),
          category: "other",
          description: "Synthetic member report",
          includeEvidence: true,
        }),
      },
    ),
  );
  assert.equal(memberReportResponse.status, 201);
  const memberReport = (await memberReportResponse.json()).report;
  const ownerPeopleResponse = await reopened("/admin/people");
  const ownerPeople = await ownerPeopleResponse.json();
  const admittedMember = ownerPeople.people.find(
    (person: { subject?: string }) => person.subject === memberSubject,
  );
  assert.ok(admittedMember);
  const memberReportBeforeRemoval = await (
    await reopened(`/admin/reports/${memberReport.id}`, { headers: feedbackHeaders })
  ).json();
  assert.equal(memberReportBeforeRemoval.report.evidence.state, "available");
  assert.deepEqual(
    await (
      await reopened(`/admin/reports/${memberReport.id}/chat`, {
        headers: reportChatHeaders,
      })
    ).json(),
    { chat: { state: "unavailable", reason: "not_included" } },
  );
  assert.equal(
    memberReportBeforeRemoval.report.evidence.prompt,
    "Synthetic member report evidence.",
  );
  const removeMemberResponse = await reopened(`/admin/people/${admittedMember.id}/remove`, {
    method: "POST",
  });
  assert.equal(removeMemberResponse.status, 200);
  const memberReportAfterRemoval = await (
    await reopened(`/admin/reports/${memberReport.id}`, { headers: feedbackHeaders })
  ).json();
  assert.equal(memberReportAfterRemoval.report.evidence.state, "member_removed");
  assert.deepEqual(
    await (
      await reopened(`/admin/reports/${memberReport.id}/chat`, {
        headers: reportChatHeaders,
      })
    ).json(),
    { chat: { state: "member_removed" } },
  );
  assert.equal("prompt" in memberReportAfterRemoval.report.evidence, false);
  const firstMentionedRequest = seen.length;
  const mentionedTurn = await reopened(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","thinking":"low","text":"Create an artifact.","mentions":[{"agentId":"cleanup"}]}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(mentionedTurn.status, 200);
  const mentionedEvents = (await mentionedTurn.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.ok(
    mentionedEvents.some((event) => event.type === "done"),
    JSON.stringify(mentionedEvents),
  );
  assert.ok(
    mentionedEvents.some(
      (event) =>
        event.type === "child-result" &&
        event.agentId === "cleanup" &&
        event.text === "Committed synthetic answer.",
    ),
    "the native child result is streamed with its protected agent attribution",
  );
  assert.ok(!mentionedEvents.some((event) => event.type === "child-start"));
  const mentionedRead = await (await reopened(`/chats/${chat.id}`)).json();
  const reportAfterLaterTurn = await (
    await reopened(reportChatRoute, { headers: reportChatHeaders })
  ).json();
  assert.equal(reportAfterLaterTurn.chat.state, "available");
  assert.equal(reportAfterLaterTurn.chat.capturedAt, reportedChat.capturedAt);
  assert.doesNotMatch(JSON.stringify(reportAfterLaterTurn), /Create an artifact\./u);
  assert.ok(
    mentionedRead.chat.messages.some(
      (message: { agentId?: string; text?: string }) =>
        message.agentId === "cleanup" && message.text === "Committed synthetic answer.",
    ),
    "the attributed result is committed to the parent transcript before cleanup",
  );
  const usage = await listProtectedUsage(stateDir, user.id, Date.now());
  assert.equal(
    usage.reduce((total, day) => total + day.tokens, 0),
    25 + contextProofTokens,
    "usage includes the context proof, both parent turns, and both native child provider requests",
  );
  assert.equal(
    usage.reduce((total, day) => total + day.missingUsage, 0),
    0,
  );
  assert.deepEqual(
    seen.slice(firstMentionedRequest).map(({ body }) => [body.model, body.reasoning_effort]),
    [
      ["synthetic", "low"],
      ["synthetic", "low"],
      ["synthetic", "low"],
    ],
    "the parent and native child serialize the selected model and reasoning",
  );
  const childRequests = seen
    .slice(firstMentionedRequest)
    .filter(({ body }) =>
      JSON.stringify(body.messages).includes("## Current agent: Cleanup proof (cleanup)"),
    );
  assert.equal(childRequests.length, 2, "the native child executes its own instructions");
  for (const request of childRequests) {
    assert.equal(request.auth, "Bearer synthetic-request-only-key");
    assert.deepEqual(
      toolNames(request),
      childTools,
      "the child receives the shared tool surface without routing or cross-chat sends",
    );
  }
  const { chat: finalWidgetChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const finalWidgetRoute = `/chats/${finalWidgetChat.id}`;
  const beforeFinalWidget = seen.length;
  const finalWidgetResponse = await reopened(`${finalWidgetRoute}/turns`, {
    method: "POST",
    body: JSON.stringify({
      provider: "sparky",
      text: "Finish this answer with only a widget.",
    }),
    headers: { "x-grogu-profile": user.id },
  });
  const finalWidgetStream = await finalWidgetResponse.text();
  assert.match(finalWidgetStream, /"type":"widget"/);
  assert.match(finalWidgetStream, /"type":"done"/, finalWidgetStream);
  assert.doesNotMatch(finalWidgetStream, /"type":"error"/);
  assert.match(finalWidgetStream, /"type":"usage"/);
  assert.equal(seen.length - beforeFinalWidget, 1, "a final widget needs no follow-up model call");
  const finalWidgetSaved = await (await reopened(finalWidgetRoute)).json();
  assert.equal(finalWidgetSaved.chat.messages.length, 2);
  assert.equal(finalWidgetSaved.chat.messages.at(-1).status, "complete");
  assert.equal(finalWidgetSaved.chat.messages.at(-1).widgets.length, 1);
  assert.equal(
    finalWidgetSaved.chat.messages.filter(
      (message: { status?: string }) => message.status === "failed",
    ).length,
    0,
  );
  const finalWidgetFollowup = await reopened(`${finalWidgetRoute}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: "Continue after the widget." }),
    headers: { "x-grogu-profile": user.id },
  });
  assert.match(await finalWidgetFollowup.text(), /"type":"done"/);
  const finalWidgetUpdated = await (await reopened(finalWidgetRoute)).json();
  assert.equal(
    (
      await reopened(finalWidgetRoute, {
        method: "DELETE",
        headers: { "if-match": finalWidgetUpdated.chat.version },
      })
    ).status,
    204,
  );
  const profileFiles = await createAuthorizedUserFiles({
    usersRoot: await root(usersDir),
    profileId: user.id,
    assertCurrent() {},
    maxBytes: 64_000,
  });
  try {
    assert.deepEqual(await profileFiles.list("chats"), [chat.id]);
  } finally {
    profileFiles.dispose();
  }
  const retiredSelection = await reopened(`/chats/${chat.id}/agent`, {
    method: "PATCH",
    headers: { "if-match": mentionedRead.chat.version },
    body: '{"selectedAgentId":"research"}',
  });
  assert.equal(retiredSelection.status, 422);
  // Research is retired from new selection; a chat saved while it was selectable keeps running it.
  const earlierApp = createProtectedHttp({
    ...options,
    agentExtensions: [{ ...protectedResearchAgent, selectable: true }, protectedCleanupAgent],
  });
  t.after(() => earlierApp.shutdown());
  const selected = await earlierApp.fetch(
    new Request(`${origin}/api/protected/v1/chats/${chat.id}/agent`, {
      method: "PATCH",
      headers: {
        origin,
        "content-type": "application/json",
        "if-match": mentionedRead.chat.version,
      },
      body: '{"selectedAgentId":"research"}',
    }),
  );
  assert.equal(selected.status, 200);
  const firstResearchRequest = seen.length;
  const researchTurn = await reopened(`/chats/${chat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Summarize this source"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(researchTurn.status, 200);
  assert.match(await researchTurn.text(), /"type":"done"/);
  const researchRequest = seen
    .slice(firstResearchRequest)
    .find(({ body }) =>
      JSON.stringify(body.messages).includes("Use concise, evidence-based summaries."),
    );
  assert.ok(researchRequest, "the selected research agent reaches the synthetic provider");
  assert.deepEqual(toolNames(researchRequest), mainRunTools);
  assert.match(systemText(researchRequest), /\n## Current agent: Research \(research\)\n/);
  const selectedRead = await (await reopened(`/chats/${chat.id}`)).json();
  assert.equal(selectedRead.chat.selectedAgentId, "research");
  const deleted = await reopened(`/chats/${chat.id}`, {
    method: "DELETE",
    headers: { "if-match": selectedRead.chat.version },
  });
  assert.equal(deleted.status, 204);
  const retriedDeletedReport = await reopened(reportRoute, {
    method: "POST",
    headers: reportChatHeaders,
    body: JSON.stringify(reportBody),
  });
  assert.equal(retriedDeletedReport.status, 200);
  assert.deepEqual(await retriedDeletedReport.json(), reportResult);
  const deletedReport = await reopened(`/admin/reports/${reportResult.report.id}`, {
    headers: feedbackHeaders,
  });
  assert.equal((await deletedReport.json()).report.evidence.state, "deleted");
  assert.deepEqual(await (await reopened(reportChatRoute, { headers: reportChatHeaders })).json(), {
    chat: { state: "deleted" },
  });
  assert.equal(
    (
      await reopened(`/chats/${chat.id}/feedback`, {
        headers: feedbackHeaders,
      })
    ).status,
    404,
  );
  const deletedTelemetry = await (
    await reopened("/admin/telemetry?days=7", { headers: feedbackHeaders })
  ).json();
  assert.equal(deletedTelemetry.totals.ratingsDown, 0);
  assert.equal(deletedTelemetry.totals.reports, 2);
  assert.equal((await reopened(`/chats/${chat.id}/widgets/${widget.id}`)).status, 404);

  const { chat: travelChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  assert.equal(travelChat.selectedAgentId, "grogu");
  const travelSelected = await reopened(`/chats/${travelChat.id}/agent`, {
    method: "PATCH",
    headers: { "if-match": travelChat.version },
    body: '{"selectedAgentId":"travel"}',
  });
  assert.equal(travelSelected.status, 200);
  const firstTravelRequest = seen.length;
  const travelTurn = await reopened(`/chats/${travelChat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Plan a weekend away."}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.match(await travelTurn.text(), /"type":"done"/);
  const travelRequest = seen[firstTravelRequest];
  assert.match(systemText(travelRequest), /\n## Current agent: Travel \(travel\)\n/);
  assert.match(systemText(travelRequest), /Travel dashboard: Plan a trip step by step/);
  assert.doesNotMatch(systemText(travelRequest), /Work like a careful travel planner/);
  assert.doesNotMatch(systemText(seen[0]), /## Available skills/);
  // Earlier child runs must not seed workspace onboarding into later member prompts.
  assert.doesNotMatch(systemText(travelRequest), /## Bootstrap Pending/);
  assert.deepEqual(toolNames(travelRequest), [...mainRunTools, "skills_read"].toSorted());
  assert.equal(sharedPrefix(travelRequest), sharedPrefix(seen[0]));

  const { chat: routedChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const firstRoutedRequest = seen.length;
  const routedTurn = await reopened(`/chats/${routedChat.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: routePrompt }),
    headers: {
      "x-grogu-profile": user.id,
      "X-Alcove-Capabilities": "specialist-stream-v1",
    },
  });
  assert.equal(routedTurn.status, 200);
  const routedReader = routedTurn.body!.getReader();
  const routedDecoder = new TextDecoder();
  let routedBody = "";
  try {
    while (!routedBody.includes('"type":"child-widget"')) {
      const part = await routedReader.read();
      assert.equal(part.done, false, "the child widget arrives before the provider finishes");
      routedBody += routedDecoder.decode(part.value, { stream: true });
    }
    assert.doesNotMatch(routedBody, /"type":"child-result"/u);
  } finally {
    routedChildRelease.resolve();
  }
  for (;;) {
    const part = await routedReader.read();
    if (part.done) {
      routedBody += routedDecoder.decode();
      break;
    }
    routedBody += routedDecoder.decode(part.value, { stream: true });
  }
  const routedEvents = routedBody
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(routedEvents.at(-1)?.type, "done", JSON.stringify(routedEvents));
  const childStart = routedEvents.find((event) => event.type === "child-start");
  assert.equal(childStart?.agentId, "travel");
  const childWidget = routedEvents.find((event) => event.type === "child-widget");
  assert.equal(childWidget?.runId, childStart.runId);
  assert.ok(
    routedEvents.findIndex((event) => event.type === "child-widget") <
      routedEvents.findIndex((event) => event.type === "child-result"),
    "the child widget is published before child completion",
  );
  assert.ok(
    routedEvents.some(
      (event) =>
        event.type === "child-delta" &&
        event.runId === childStart.runId &&
        event.text.includes("Committed synthetic answer."),
    ),
    "the child's own model output is streamed with its identity",
  );
  assert.ok(
    routedEvents.findIndex((event) => event.type === "child-delta") <
      routedEvents.findIndex((event) => event.type === "child-result"),
    "child text reaches the stream before completion",
  );
  assert.deepEqual(
    routedEvents
      .filter((event) => event.type === "child-result")
      .map((event) => [event.agentId, event.text]),
    [["travel", "Committed synthetic answer."]],
  );
  const routedRequests = seen.slice(firstRoutedRequest);
  assert.equal(routedRequests.length, 3, "Grogu routes once and Travel creates a widget");
  assert.match(systemText(routedRequests[0]), /\n## Current agent: Grogu \(grogu\)\n/);
  const routedChild = routedRequests[1];
  assert.match(systemText(routedChild), /\n## Current agent: Travel \(travel\)\n/);
  assert.match(systemText(routedChild), /Travel dashboard: Plan a trip step by step/);
  assert.deepEqual(
    toolNames(routedChild),
    [...childTools, "skills_read"].toSorted(),
    "a routed agent cannot route again",
  );
  assert.match(JSON.stringify(routedChild?.body.messages), new RegExp(routeBrief));
  const routedRead = await (
    await reopened(`/chats/${routedChat.id}`, {
      headers: { "X-Alcove-Capabilities": "specialist-stream-v1" },
    })
  ).json();
  assert.deepEqual(
    routedRead.chat.messages.map((message: { role: string; agentId?: string; text: string }) => [
      message.role,
      message.agentId,
      message.text,
    ]),
    [
      ["user", undefined, routePrompt],
      ["assistant", undefined, "Travel will help with this."],
      ["assistant", "travel", "Committed synthetic answer."],
    ],
  );
  assert.equal(routedRead.chat.messages[1]?.status, "complete", "a routing reply reloads complete");
  assert.equal(routedRead.chat.messages[2]?.runId, childStart.runId);
  assert.deepEqual(routedRead.chat.messages[2]?.widgets, [
    { id: childWidget.id, title: "Synthetic widget" },
  ]);
  const routedWidget = await reopened(`/chats/${routedChat.id}/widgets/${childWidget.id}`);
  assert.equal(routedWidget.status, 200);
  assert.match((await routedWidget.json()).html, /Scoped widget body/);
  const legacyRoutedRead = await (await reopened(`/chats/${routedChat.id}`)).json();
  assert.equal("runId" in legacyRoutedRead.chat.messages[2], false);
  const widgetMemberSubject = "synthetic-widget-member";
  assert.equal(
    await addProtectedSubject(stateDir, {
      issuer: "https://synthetic.example",
      subject: widgetMemberSubject,
    }),
    "added",
  );
  const widgetMemberApp = createProtectedHttp({
    ...options,
    directory: {
      issuer: "https://synthetic.example",
      allowedSubjects: ["synthetic-sparky", widgetMemberSubject],
    },
    verifyIdentity: identityFor(widgetMemberSubject, "synthetic-widget-member-session"),
  });
  t.after(() => widgetMemberApp.shutdown());
  const widgetMemberHeaders = new Headers(reportChatHeaders);
  widgetMemberHeaders.set("origin", origin);
  const widgetMemberMe = await (
    await widgetMemberApp.fetch(
      new Request(`${origin}/api/protected/v1/me`, { headers: widgetMemberHeaders }),
    )
  ).json();
  widgetMemberHeaders.set("x-grogu-profile", widgetMemberMe.user.id);
  assert.equal(
    (
      await widgetMemberApp.fetch(
        new Request(`${origin}/api/protected/v1/chats/${routedChat.id}/widgets/${childWidget.id}`, {
          headers: widgetMemberHeaders,
        }),
      )
    ).status,
    404,
  );
  const { chat: failedRoutedChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const failedRoutedTurn = await reopened(`/chats/${failedRoutedChat.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: failedRoutePrompt }),
    headers: {
      "x-grogu-profile": user.id,
      "X-Alcove-Capabilities": "specialist-stream-v1",
    },
  });
  const failedRoutedEvents = (await failedRoutedTurn.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const failedChild = failedRoutedEvents.find((event) => event.type === "child-error");
  assert.equal(failedChild?.agentId, "travel");
  assert.equal(failedChild.code, "agent_failed");
  assert.equal(failedRoutedEvents.at(-1)?.type, "error");
  assert.ok(!failedRoutedEvents.some((event) => event.type === "child-result"));
  const failedRoutedRead = await (
    await reopened(`/chats/${failedRoutedChat.id}`, {
      headers: { "X-Alcove-Capabilities": "specialist-stream-v1" },
    })
  ).json();
  assert.equal(failedRoutedRead.chat.messages.at(-1)?.runId, failedChild.runId);
  assert.equal(failedRoutedRead.chat.messages.at(-1)?.status, "failed");
  assert.equal(
    (
      await reopened(`/chats/${failedRoutedChat.id}`, {
        method: "DELETE",
        headers: { "if-match": failedRoutedRead.chat.version },
      })
    ).status,
    204,
  );
  const { chat: selfRoutedChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const selfRouted = await reopened(`/chats/${selfRoutedChat.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: selfRoutePrompt }),
    headers: { "x-grogu-profile": user.id },
  });
  const selfRoutedEvents = (await selfRouted.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    selfRoutedEvents
      .filter((event) => event.type === "error" || event.type === "child-result")
      .map((event) => [event.type, event.code]),
    [["error", "agent_failed"]],
  );
  for (const id of [travelChat.id, routedChat.id, selfRoutedChat.id]) {
    const current = await (await reopened(`/chats/${id}`)).json();
    const removed = await reopened(`/chats/${id}`, {
      method: "DELETE",
      headers: { "if-match": current.chat.version },
    });
    assert.equal(removed.status, 204, await removed.text());
  }

  const foreignApp = createProtectedHttp({
    ...options,
    verifyIdentity: identityFor("synthetic-foreign", "synthetic-foreign-session"),
  });
  t.after(() => foreignApp.shutdown());
  const foreignCall = (route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    return foreignApp.fetch(
      new Request(`${origin}/api/protected/v1${route}`, { ...init, headers }),
    );
  };
  const foreignMeResponse = await foreignCall("/me");
  assert.equal(foreignMeResponse.status, 200);
  const foreignMe = await foreignMeResponse.json();
  const foreignCreated = await foreignCall("/chats", {
    method: "POST",
    body: '{"title":"Foreign profile chat"}',
  });
  assert.equal(foreignCreated.status, 200);
  const foreignChat = (await foreignCreated.json()).chat;
  const foreignSeeded = await foreignCall(`/chats/${foreignChat.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Transcript marker private to the foreign profile"}',
    headers: { "x-grogu-profile": foreignMe.user.id },
  });
  assert.equal(foreignSeeded.status, 200);
  assert.match(await foreignSeeded.text(), /"type":"done"/);
  const foreignTranscript = await foreignCall(`/chats/${foreignChat.id}`);
  assert.match(
    JSON.stringify(await foreignTranscript.json()),
    /Transcript marker private to the foreign profile/,
  );
  const foreignRequest = seen.find(({ body }) =>
    JSON.stringify(body.messages?.slice(1)).includes(
      "Transcript marker private to the foreign profile",
    ),
  );
  assert.equal(
    sharedPrefix(foreignRequest),
    sharedPrefix(seen[0]),
    "members share the same header prefix",
  );
  assert.deepEqual(foreignRequest?.body.tools, seen[0]?.body.tools);
  const automationDraft: ProtectedAutomationDraft = {
    name: "Synthetic private automation",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic" },
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const foreignAutomationSubject = "synthetic-automation-other-member";
  assert.equal(
    await addProtectedSubject(stateDir, {
      issuer: "https://synthetic.example",
      subject: foreignAutomationSubject,
    }),
    "added",
  );
  const foreignAutomationProfile = await ensureCanonicalUserProfileForVerifiedIdentity(
    { issuer: "https://synthetic.example", subject: foreignAutomationSubject },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
  assert.equal(
    await bindProtectedProfile(stateDir, {
      issuer: "https://synthetic.example",
      subject: foreignAutomationSubject,
      profileId: foreignAutomationProfile.id,
    }),
    true,
  );
  const foreignAutomation = await createProtectedAutomationWithAdmission(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      profileId: foreignAutomationProfile.id,
      definition: { ...automationDraft, name: "Foreign member automation" },
      now: Date.now(),
    },
    { profileId: foreignAutomationProfile.id, assertCurrent() {} },
  );
  assert.equal(foreignAutomation.status, "created");
  if (foreignAutomation.status !== "created") {
    assert.fail("Could not seed the other member's automation.");
  }
  foreignAutomationId = foreignAutomation.automation.id;
  const { chat: permitted } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const { chat: coordinator } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const seeded = await reopened(`/chats/${permitted.id}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Transcript marker visible to this profile"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(seeded.status, 200);
  assert.match(await seeded.text(), /"type":"done"/);
  const sessionHistoryTargets = {
    permitted: `agent:protected:family:${user.id}:${permitted.id}`,
    foreign: `agent:protected:family:${foreignMe.user.id}:${foreignChat.id}`,
  };
  const ownedAutomationResponse = await reopened("/automations", {
    method: "POST",
    headers: { "x-grogu-profile": user.id },
    body: JSON.stringify({ ...automationDraft, name: "Alice private automation" }),
  });
  assert.equal(ownedAutomationResponse.status, 201, await ownedAutomationResponse.clone().text());
  const ownedAutomation = await ownedAutomationResponse.json();
  ownedAutomationId = ownedAutomation.automation.id;
  ownedAutomationVersion = ownedAutomation.automation.version;
  proposedAutomationDraft = {
    ...automationDraft,
    name: "Alice suggested automation",
  };
  const automationsBefore = await (
    await reopened("/automations", { headers: { "x-grogu-profile": user.id } })
  ).json();
  const legacyAutomationCatalogResponse = await reopened("/automations/catalog", {
    headers: { "x-grogu-profile": user.id },
  });
  const legacyAutomationCatalogBody = await legacyAutomationCatalogResponse.text();
  assert.equal(legacyAutomationCatalogResponse.status, 200);
  assert.equal(JSON.parse(legacyAutomationCatalogBody).capabilities.automations.chat, undefined);
  const negotiatedAutomationCatalogHeaders = {
    "x-grogu-profile": user.id,
    "X-Alcove-Capabilities": "automations-chat-v1",
  };
  const negotiatedAutomationCatalogResponse = await reopened("/automations/catalog", {
    headers: negotiatedAutomationCatalogHeaders,
  });
  const negotiatedAutomationCatalogBody = await negotiatedAutomationCatalogResponse.text();
  assert.equal(negotiatedAutomationCatalogResponse.status, 200);
  assert.deepEqual(JSON.parse(negotiatedAutomationCatalogBody).capabilities.automations.chat, {
    list: true,
    read: true,
    proposeCreate: true,
    proposePatch: true,
  });
  const sessionHistoryPrompt = "Inspect my permitted sessions.";
  const automationChatPrompt = "Use private automation chat tools.";
  const automationChatRequestBody = {
    provider: "sparky",
    text: `${sessionHistoryPrompt} ${automationChatPrompt}`,
  };
  const toolTurnRequestStart = seen.length;
  const automationChatRoute = `/chats/${coordinator.id}/turns`;
  const sessionHistoryTurn = await reopened(automationChatRoute, {
    method: "POST",
    body: JSON.stringify(automationChatRequestBody),
    headers: negotiatedAutomationCatalogHeaders,
  });
  assert.equal(sessionHistoryTurn.status, 200);
  const automationChatStream = await sessionHistoryTurn.text();
  assert.match(automationChatStream, /"type":"done"/);
  assert.match(automationChatStream, /Proposed only; nothing was saved\./);
  const sessionHistoryRequests = seen
    .slice(toolTurnRequestStart)
    .filter(({ body }) => JSON.stringify(body.messages).includes(sessionHistoryPrompt));
  assert.ok(
    sessionHistoryRequests.length >= 2,
    "native session-history results return to the model",
  );
  const sessionToolMessages = sessionHistoryRequests
    .at(-1)
    ?.body.messages?.filter(
      (message): message is { role: "tool" } =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool",
    );
  const sessionHistoryOutput = JSON.stringify(sessionToolMessages ?? []);
  assert.match(sessionHistoryOutput, /Transcript marker visible to this profile/);
  assert.doesNotMatch(sessionHistoryOutput, /Transcript marker private to the foreign profile/);
  assert.ok(
    sessionHistoryOutput.includes(permitted.id),
    "session list includes the permitted chat",
  );
  const automationChatRequests = seen
    .slice(toolTurnRequestStart)
    .filter(({ body }) => JSON.stringify(body.messages).includes(automationChatPrompt));
  assert.equal(automationChatRequests.length, 2);
  const automationTools = automationChatRequests[0]!.body.tools ?? [];
  assert.deepEqual(
    automationTools
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith("automations_"))
      .toSorted(),
    [
      "automations_list",
      "automations_propose_create",
      "automations_propose_patch",
      "automations_read",
    ],
  );
  const patchTool = automationTools.find(
    (tool) => tool.function.name === "automations_propose_patch",
  );
  assert.ok(patchTool);
  const patchSchema = patchTool.function.parameters?.properties?.patch;
  assert.ok(patchSchema?.properties);
  assert.equal(patchSchema.properties.enabled, undefined);
  assert.doesNotMatch(JSON.stringify(automationTools), /profileId/u);
  const automationToolMessages =
    automationChatRequests[1]!.body.messages?.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool",
    ) ?? [];
  const automationToolOutput = JSON.stringify(
    automationToolMessages.map((message) => {
      const content =
        typeof message === "object" && message !== null && "content" in message
          ? message.content
          : undefined;
      if (typeof content !== "string") {
        throw new Error("Expected automation tool result content to be JSON text");
      }
      return JSON.parse(content);
    }),
  );
  assert.match(automationToolOutput, /Alice private automation/u);
  assert.doesNotMatch(automationToolOutput, /Foreign member automation/u);
  assert.match(automationToolOutput, /"status":"not_found"/u);
  assert.match(automationToolOutput, /Alice suggested automation/u);
  assert.match(automationToolOutput, /Alice proposed automation update/u);
  assert.match(automationToolOutput, /"writeApplied":false/u);
  assert.deepEqual(
    await (await reopened("/automations", { headers: { "x-grogu-profile": user.id } })).json(),
    automationsBefore,
  );
  const capturePath = process.env.OPENCLAW_AUTOMATIONS_CHAT_CAPTURE_PATH;
  if (capturePath) {
    await writeFile(
      capturePath,
      [
        {
          name: "legacy-automation-catalog",
          request: {
            method: "GET",
            path: "/api/protected/v1/automations/catalog",
            headers: { "x-grogu-profile": user.id },
          },
          response: {
            status: legacyAutomationCatalogResponse.status,
            contentType: legacyAutomationCatalogResponse.headers.get("content-type"),
            body: legacyAutomationCatalogBody,
          },
        },
        {
          name: "negotiated-automation-catalog",
          request: {
            method: "GET",
            path: "/api/protected/v1/automations/catalog",
            headers: negotiatedAutomationCatalogHeaders,
          },
          response: {
            status: negotiatedAutomationCatalogResponse.status,
            contentType: negotiatedAutomationCatalogResponse.headers.get("content-type"),
            body: negotiatedAutomationCatalogBody,
          },
        },
        {
          name: "automation-chat-turn",
          request: {
            method: "POST",
            path: `/api/protected/v1${automationChatRoute}`,
            headers: {
              ...negotiatedAutomationCatalogHeaders,
              "content-type": "application/json",
            },
            body: automationChatRequestBody,
          },
          response: {
            status: sessionHistoryTurn.status,
            contentType: sessionHistoryTurn.headers.get("content-type"),
            body: automationChatStream,
          },
        },
      ]
        .map((capture) => JSON.stringify(capture))
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  assert.ok(!sessionHistoryOutput.includes(foreignChat.id), "session list omits the foreign chat");
  const searchMessage = sessionToolMessages?.find(
    (message) => "tool_call_id" in message && message.tool_call_id === "callsessionssearch",
  );
  assert.ok(searchMessage, "native encrypted search returns its result to the model");
  const searchOutput = JSON.stringify(searchMessage);
  assert.match(searchOutput, /Transcript marker visible to this profile/);
  assert.ok(searchOutput.includes(permitted.id), "search identifies the permitted chat");
  assert.doesNotMatch(searchOutput, /Transcript marker private to the foreign profile/);
  assert.ok(!searchOutput.includes(foreignChat.id), "search omits the foreign chat");
  for (const id of [permitted.id, coordinator.id]) {
    const current = await (await reopened(`/chats/${id}`)).json();
    const removed = await reopened(`/chats/${id}`, {
      method: "DELETE",
      headers: { "if-match": current.chat.version },
    });
    assert.equal(removed.status, 204, await removed.text());
  }
  const foreignCurrent = await (await foreignCall(`/chats/${foreignChat.id}`)).json();
  const foreignRemoved = await foreignCall(`/chats/${foreignChat.id}`, {
    method: "DELETE",
    headers: { "if-match": foreignCurrent.chat.version },
  });
  assert.equal(foreignRemoved.status, 204, await foreignRemoved.text());

  const { chat: interrupted } = await (await call("/chats", { method: "POST", body: "{}" })).json();
  const route = `/chats/${interrupted.id}`;
  const copilotModels = (capability?: string) =>
    call("/providers/github-copilot/models", {
      method: "POST",
      headers: {
        "x-grogu-profile": user.id,
        ...(capability ? { "x-alcove-capabilities": capability } : {}),
      },
      body: JSON.stringify({ credential: { accessToken: githubToken } }),
    });
  const copilotTurn = (thinking: string) =>
    call(`${route}/turns`, {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
      body: JSON.stringify({
        provider: "github-copilot",
        model: "gpt-5.4",
        text: "Test a different Copilot model",
        thinking,
        credential: { accessToken: githubToken },
      }),
    });
  await t.test("lists the account's visible Copilot models", async () => {
    const listing = await copilotModels("model-vendor-v1");
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get("vary"), "X-Alcove-Capabilities");
    const { models } = await listing.json();
    assert.deepEqual(
      models.map((model: { id: string }) => model.id),
      ["gpt-5.3-codex", "gpt-5.4", "no-reasoning"],
    );
    assert.equal(models[0].vendor, "OpenAI");
    assert.equal(models[1].vendor, "OpenAI");
    assert.equal(models[1].contextWindow, 1_000_000);
    assert.equal(models[2].vendor, undefined);
    assert.ok(models[1].thinking.levels.includes("high"));
    assert.ok(!models[1].thinking.levels.includes("max"));
    assert.deepEqual(models[1].thinking.nativeChoices, [
      { level: "low", aliases: ["minimal"] },
      { level: "high", aliases: [] },
    ]);
    assert.deepEqual(models[1].thinking.orchestrationLevels, ["ultra"]);
    assert.equal(models[1].thinking.default, "off");
    assert.deepEqual(models[2].thinking.nativeChoices, []);
    assert.deepEqual(models[2].thinking.orchestrationLevels, ["ultra"]);
    assert.equal(models[2].thinking.default, "off");
    const legacy = await copilotModels();
    assert.equal(legacy.headers.get("vary"), "X-Alcove-Capabilities");
    const legacyModels = (await legacy.json()).models;
    assert.ok(legacyModels.every((model: { vendor?: string }) => model.vendor === undefined));
    const unknownCapability = await copilotModels("model-vendor-v10");
    const unknownModels = (await unknownCapability.json()).models;
    assert.ok(unknownModels.every((model: { vendor?: string }) => model.vendor === undefined));
  });
  await t.test("unbound legacy credentials still follow the ambient tenant", async () => {
    const before = providerRequests.length;
    const legacy = await call("/providers/github-copilot/models", {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
      body: JSON.stringify({ credential: { accessToken: rawGithubToken } }),
    });
    assert.equal(legacy.status, 401);
    assert.equal((await legacy.json()).error.code, "provider_auth_failed");
    assert.deepEqual(
      providerRequests
        .slice(before)
        .map(({ endpoint, authorization }) => [endpoint, authorization]),
      [[`https://api.${hostTenant}/copilot_internal/user`, `Bearer ${rawGithubToken}`]],
    );
  });
  await t.test("rejects malformed bound credentials", async () => {
    const before = providerRequests.length;
    const malformed = await call("/providers/github-copilot/models", {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
      body: JSON.stringify({
        credential: { accessToken: "openclaw-github-copilot-token:v1:{" },
      }),
    });
    assert.equal(malformed.status, 401);
    assert.equal((await malformed.json()).error.code, "provider_auth_failed");
    assert.equal(providerRequests.length, before);
  });
  await t.test("rejects unavailable Copilot thinking levels", async () => {
    const rejected = await copilotTurn("max");
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "thinking_unavailable");
  });
  await t.test("rejects models unavailable to the account", async () => {
    const rejected = await call(`${route}/turns`, {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
      body: JSON.stringify({
        provider: "github-copilot",
        model: "hidden",
        text: "Use a hidden model",
        credential: { accessToken: githubToken },
      }),
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "model_unavailable");
  });
  await t.test("rejects expired Copilot credentials", async () => {
    const rejected = await call("/providers/github-copilot/models", {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
      body: JSON.stringify({ credential: { accessToken: githubToken, expiresAt: Date.now() - 1 } }),
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "provider_credential_expired");
  });
  await t.test("rejects denied credentials and requires the signed-in profile", async () => {
    const request = (profile?: string) =>
      call("/providers/github-copilot/models", {
        method: "POST",
        headers: profile ? { "x-grogu-profile": profile } : {},
        body: JSON.stringify({ credential: { accessToken: "denied-synthetic" } }),
      });
    const denied = await request(user.id);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, "provider_auth_failed");
    assert.equal((await request()).status, 403);
  });
  await t.test("runs a chosen Copilot model with the selected reasoning", async () => {
    copilotSummary = "A public Copilot reasoning summary.";
    let chosenTrace: string;
    try {
      const chosen = await copilotTurn("high");
      assert.equal(chosen.status, 200);
      // The provider fetch runs while the NDJSON body streams.
      chosenTrace = await chosen.text();
    } finally {
      copilotSummary = undefined;
    }
    const chosenEvents = chosenTrace
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(copilotBodies.at(-1)?.model, "gpt-5.4");
    assert.equal(copilotBodies.at(-1)?.reasoning?.effort, "high");
    assert.equal(copilotBodies.at(-1)?.reasoning?.summary, "auto");
    const reasoning = chosenEvents.findIndex((event) => event.type === "reasoning");
    assert.ok(reasoning > 0, JSON.stringify(chosenEvents.map(({ type }) => type)));
    assert.equal(chosenEvents[reasoning].text, "A public Copilot reasoning summary.");
    assert.ok(reasoning < chosenEvents.findIndex((event) => event.type === "delta"));
    assert.equal(chosenEvents.at(-1)?.type, "done");
  });
  providerRequests.length = 0;
  for (const [providerName, label, credential] of [
    ["github-copilot", "Copilot", { accessToken: githubToken }],
    [
      "openai",
      "OpenAI",
      {
        accessToken: openaiToken,
        refreshToken: openaiRefresh,
        accountId,
        expiresAt,
        generation: 2,
      },
    ],
    ["anthropic", "Anthropic", { accessToken: anthropicKey }],
  ] as const) {
    const turn = (personal?: object) =>
      call(`${route}/turns`, {
        method: "POST",
        body: JSON.stringify({
          provider: providerName,
          text: `Test ${label} transport`,
          credential: personal,
        }),
        headers: { "x-grogu-profile": user.id },
      });
    const requestsBeforeCredential = providerRequests.length;
    assert.match(await (await turn()).text(), /provider_credential_required/);
    assert.equal(providerRequests.length, requestsBeforeCredential);
    const result = await turn(credential);
    assert.equal(result.status, 200);
    const trace = await result.text();
    assert.match(
      trace,
      /"type":"done"/,
      `${providerName}: ${trace}; ${providerRequests.map(({ endpoint }) => endpoint).join(", ")}`,
    );
    const transcript = await (await call(route)).json();
    assert.ok(transcript.chat.messages.at(-1).text.includes(`Canonical ${label} reply.`));
    if (providerName === "anthropic") {
      const usageEvents = trace
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(usageEvents.at(-2), {
        type: "usage",
        contextTokens: 3,
        inputTokens: 3,
        outputTokens: 1,
      });
      assert.deepEqual(transcript.usage, {
        contextTokens: 3,
        inputTokens: 3,
        outputTokens: 1,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    }
  }
  assert.deepEqual(
    providerRequests.filter(({ endpoint }) => !endpoint.endsWith("/models")),
    [
      {
        endpoint: "https://api.github.com/copilot_internal/user",
        authorization: `Bearer ${rawGithubToken}`,
        account: null,
        key: null,
      },
      {
        endpoint: "https://api.github.com/copilot_internal/user",
        authorization: `Bearer ${rawGithubToken}`,
        account: null,
        key: null,
      },
      {
        endpoint: "https://api.business.githubcopilot.com/responses",
        authorization: `Bearer ${rawGithubToken}`,
        account: null,
        key: null,
      },
      {
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        authorization: `Bearer ${openaiToken}`,
        account: accountId,
        key: null,
      },
      {
        endpoint: "https://api.anthropic.com/v1/messages",
        authorization: null,
        account: null,
        key: anthropicKey,
      },
    ],
  );
  assert.ok(!JSON.stringify(providerRequests).includes(fallback));
  await t.test("latest run tokens survive reload and omit unreported counters", async () => {
    for (const [reported, expected] of [
      [
        { input_tokens: 9, output_tokens: 3700 },
        { inputTokens: 9, outputTokens: 3700 },
      ],
      [{ input_tokens: 4, output_tokens: 0 }, { inputTokens: 4 }],
      [null, {}],
    ] as const) {
      copilotUsage = reported;
      const result = await call(`${route}/turns`, {
        method: "POST",
        headers: { "x-grogu-profile": user.id },
        body: JSON.stringify({
          provider: "github-copilot",
          text: "Report this run's tokens",
          credential: { accessToken: githubToken },
        }),
      });
      assert.equal(result.status, 200);
      const usageEvents = (await result.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(usageEvents.at(-1)?.type, "done");
      const saved = await (await reopened(route)).json();
      if (reported) {
        assert.deepEqual(usageEvents.at(-2), {
          type: "usage",
          contextTokens: reported.input_tokens,
          ...expected,
        });
        assert.deepEqual(saved.usage, {
          contextTokens: reported.input_tokens,
          ...expected,
          provider: "github-copilot",
          model: "gpt-5.3-codex",
        });
      } else {
        assert.ok(!usageEvents.some((event) => event.type === "usage"));
        assert.equal(saved.usage, undefined);
      }
    }
  });
  const active = await call(`${route}/turns`, {
    method: "POST",
    body: '{"provider":"sparky","text":"Hold the provider response open"}',
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(active.status, 200);
  assert.ok(active.body);
  const reader = active.body.getReader();
  const start = await reader.read();
  assert.ok(start.value);
  const { type, runId } = JSON.parse(new TextDecoder().decode(start.value));
  assert.equal(type, "start");
  await activeProvider.promise;
  const activeChats = await (await call("/chats")).json();
  assert.deepEqual(
    activeChats.chats.find((item: { id: string }) => item.id === interrupted.id)?.activeRun,
    { id: runId },
  );
  assert.ok(readActiveOpenClawAgentDatabaseLeasesReadOnly().length > 0);
  const steering = await call(`${route}/runs/${runId}/steer`, {
    method: "POST",
    body: JSON.stringify({ id: randomUUID(), text: "Queued during shutdown" }),
  });
  assert.equal(steering.status, 200);
  assert.deepEqual(await steering.json(), { queued: true });
  const closing = shutdown();
  try {
    let remaining = "";
    const decoder = new TextDecoder();
    for (let frame = await reader.read(); !frame.done; frame = await reader.read()) {
      remaining += decoder.decode(frame.value, { stream: true });
    }
    remaining += decoder.decode();
    assert.match(remaining, /"code":"interrupted"/);
    assert.doesNotMatch(remaining, /"type":"done"/);
    await providerDisconnected.promise;
  } finally {
    reader.releaseLock();
    await closing;
  }
  assert.deepEqual(readActiveOpenClawAgentDatabaseLeasesReadOnly(), []);
  const restart = await open();
  const history = await restart.call(route);
  assert.equal(history.status, 200);
  assert.doesNotMatch(JSON.stringify(await history.json()), /Queued during shutdown/);
  const rejected = await restart.call(`${route}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: rejectedKeyPrompt }),
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(rejected.status, 200);
  const rejectedStream = await rejected.text();
  assert.match(rejectedStream, /"code":"provider_rejected"/, rejectedStream);
  assert.doesNotMatch(rejectedStream, /operation_failed|Invalid API key/);
  const canonicalRun = options.turns.run.bind(options.turns);
  options.turns.run = async (turn) => {
    try {
      await canonicalRun(turn);
    } finally {
      if (turn.input.text === offlinePrompt) {
        offlineSettled.resolve();
      }
      if (turn.input.text === failedOfflinePrompt) {
        failedOfflineSettled.resolve();
      }
    }
  };
  const { chat: offline } = await (
    await restart.call("/chats", { method: "POST", body: "{}" })
  ).json();
  const offlineRoute = `/chats/${offline.id}`;
  const offlineResponse = await restart.call(`${offlineRoute}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: offlinePrompt }),
    headers: { "x-grogu-profile": user.id, "x-proof-disconnect": "yes" },
  });
  assert.equal(offlineResponse.status, 200);
  const offlineReader = offlineResponse.body!.getReader();
  const offlineStart = JSON.parse(new TextDecoder().decode((await offlineReader.read()).value));
  assert.equal(offlineStart.type, "start");
  await offlineProvider.promise;
  await offlineReader.cancel();
  await offlineDisconnected.promise;
  const detached = await (await restart.call(offlineRoute)).json();
  offlineRelease.resolve();
  await offlineSettled.promise;
  try {
    const savedOffline = await (await reopened(offlineRoute)).json();
    assert.ok(
      savedOffline.chat.messages.some(
        (message: { role: string; text: string }) =>
          message.role === "user" && message.text === offlinePrompt,
      ),
    );
    assert.equal(savedOffline.chat.messages.at(-1)?.status, "complete");
    assert.match(savedOffline.chat.messages.at(-1)?.text, /Committed synthetic answer\./);
    assert.deepEqual(detached.activeRun, { id: offlineStart.runId });

    const { chat: failedOffline } = await (
      await restart.call("/chats", { method: "POST", body: "{}" })
    ).json();
    const failedRoute = `/chats/${failedOffline.id}`;
    const failedResponse = await restart.call(`${failedRoute}/turns`, {
      method: "POST",
      body: JSON.stringify({ provider: "sparky", text: failedOfflinePrompt }),
      headers: { "x-grogu-profile": user.id, "x-proof-disconnect": "failure" },
    });
    const failedReader = failedResponse.body!.getReader();
    assert.equal(
      JSON.parse(new TextDecoder().decode((await failedReader.read()).value)).type,
      "start",
    );
    await failedOfflineProvider.promise;
    await failedReader.cancel();
    await failedOfflineDisconnected.promise;
    failedOfflineRelease.resolve();
    await failedOfflineSettled.promise;
    const failedHistory = await (await reopened(failedRoute)).json();
    const failure = failedHistory.chat.messages.at(-1);
    assert.equal(failure.role, "assistant");
    assert.equal(failure.status, "failed");
    assert.equal(
      failure.text,
      "Sparky did not accept the service key. Choose another model, or ask the server operator to check Sparky.",
    );
    assert.doesNotMatch(JSON.stringify(failedHistory), /synthetic-private-error|Invalid API key/);
  } finally {
    await restart.shutdown();
  }
  await reopenedShutdown();
  assert.equal(sendNotification.mock.callCount(), 2);
  for (const notification of sendNotification.mock.calls) {
    assert.deepEqual(JSON.parse(String(notification.arguments[1])), { tag: "issue-report" });
  }
  const plaintextMarkers = [
    suffix,
    "Reply briefly",
    "Committed synthetic answer.",
    "synthetic-report-secret-123456",
    "Scoped widget body",
    "Synthetic widget",
    sourceUrl,
    "Family source evidence.",
    offlinePrompt,
  ];
  for (const entry of await readdir(stateDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const filePath = path.join(entry.parentPath, entry.name);
      const bytes = await readFile(filePath);
      for (const marker of plaintextMarkers) {
        assert.ok(!bytes.includes(marker), `plaintext marker persisted in ${filePath}`);
      }
    }
  }
  fixtureCompleted = true;
});

void test("Family rate limits separate busy Sparky from personal plan limits", () => {
  const limited = (provider: string) =>
    publicError(
      new Error("Run failed", {
        cause: new FailoverError("Concurrency limit reached for this token owner", {
          reason: "rate_limit",
          provider,
        }),
      }),
    ).code;
  assert.equal(limited("sparky"), "provider_busy");
  assert.equal(limited("github-copilot"), "rate_limit");
});

void test("An in-flight session capability stops when its profile is merged", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-merge-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  let staleAuthorityAccepted = false;
  const app = createProtectedHttp({
    origin,
    accessIssuer: "https://synthetic.example",
    directory: { issuer: "https://synthetic.example", allowedSubjects: [] },
    stateDir,
    usersRoot: await root(usersDir),
    verifyIdentity: async (request) => {
      const subject = request.headers.get("cookie") ?? "";
      return {
        issuer: "https://synthetic.example",
        subject,
        kind: "human",
        expiresAt,
        sessionId: createHash("sha256").update(subject).digest("hex"),
        assertCurrent() {},
        async revalidate() {},
      };
    },
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    turns: {
      models: [{ provider: "anthropic", id: "synthetic", label: "Synthetic only" }],
      async run(turn) {
        entered.resolve();
        await release.promise;
        turn.sessionAccess.assertCurrent();
        staleAuthorityAccepted = true;
        await turn.sessionAccess.resolve({
          action: "history",
          requesterSessionKey: turn.target.sessionKey,
          reference: turn.id,
        });
        await turn.delta("Must not cross the profile merge.");
      },
      async steer() {
        assert.fail("Unexpected steering.");
      },
    },
  });
  const call = (subject: string, route: string, init?: RequestInit) =>
    app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: subject,
          "content-type": "application/json",
          ...init?.headers,
        },
      }),
    );
  const alice = (await (await call("alice", "/me")).json()).user;
  const bob = (await (await call("bob", "/me")).json()).user;
  const created = await call("alice", "/chats", {
    method: "POST",
    body: '{"title":"Alice private"}',
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  const { chat } = createdBody;
  const turn = await call("alice", `/chats/${chat.id}/turns`, {
    method: "POST",
    headers: { "x-grogu-profile": alice.id },
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  });
  assert.equal(turn.status, 200);
  await entered.promise;
  await mergeCanonicalUserProfiles(alice.id, bob.id, { env: { OPENCLAW_STATE_DIR: stateDir } });
  release.resolve();
  const events = await turn.text();
  assert.equal(staleAuthorityAccepted, false);
  assert.match(events, /"type":"error"/);
  assert.doesNotMatch(events, /Must not cross the profile merge|"type":"done"/);
});

void test("automation definitions consume member and global storage quota", async (t) => {
  const stateDir = path.resolve(".artifacts", `automation-quota-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  const origin = "https://quota.example";
  const expiresAt = Date.now() + 120_000;
  const options = {
    origin,
    stateDir,
    accessIssuer: "https://identity.example",
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    usersRoot: await root(stateDir),
    verifyIdentity: async (request: Request) => {
      const subject = request.headers.get("cookie")?.slice("synthetic=".length);
      if (subject !== "alice" && subject !== "bob") {
        throw new ProtectedError(401, "unauthorized", "Sign in.");
      }
      return {
        issuer: "https://identity.example",
        subject,
        kind: "human" as const,
        sessionId: subject,
        expiresAt,
        assertCurrent() {},
        async revalidate() {},
      };
    },
    agentExtensions: [protectedResearchAgent],
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    turns: {
      models: [
        {
          provider: "sparky" as const,
          id: "synthetic-sparky",
          label: "Synthetic Sparky",
          thinking: { levels: ["low" as const], default: "low" as const },
        },
      ],
      async run() {
        assert.fail("Automation quota proof does not run an agent.");
      },
      async steer() {
        assert.fail("Automation quota proof does not steer an agent.");
      },
    },
  };
  const app = createProtectedHttp({
    ...options,
    storageLimits: { globalBytes: 12_000, userBytes: 8_000, freeFloorBytes: 1 },
  });
  t.after(() => app.shutdown());
  const call = (subject: string, route: string, init?: RequestInit) =>
    app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: `synthetic=${subject}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      }),
    );
  await call("alice", "/me");
  const bob = (await (await call("bob", "/me")).json()).user;
  for (const subject of ["alice", "bob"]) {
    assert.equal(
      await addProtectedSubject(stateDir, { issuer: "https://identity.example", subject }),
      "added",
    );
  }
  const draft = {
    name: "Synthetic quota test",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  };
  const firstCreated = await call("alice", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(firstCreated.status, 201, await firstCreated.clone().text());
  const firstAutomation = (await firstCreated.json()).automation;

  const secondAliceCreate = await call("alice", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(secondAliceCreate.status, 413);
  assert.equal((await secondAliceCreate.json()).error.code, "quota_exceeded");

  const firstBobCreate = await call("bob", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(firstBobCreate.status, 201);
  const bobAutomation = (await firstBobCreate.json()).automation;

  const secondBobCreate = await call("bob", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(secondBobCreate.status, 413);
  assert.equal((await secondBobCreate.json()).error.code, "quota_exceeded");

  const oversizedPatch = await call("alice", `/automations/${firstAutomation.id}`, {
    method: "PATCH",
    headers: { "if-match": firstAutomation.version },
    body: JSON.stringify({ instructions: "x".repeat(6_000) }),
  });
  assert.equal(oversizedPatch.status, 413);
  assert.equal((await oversizedPatch.json()).error.code, "quota_exceeded");
  const unchanged = await call("alice", `/automations/${firstAutomation.id}`);
  const unchangedAutomation = (await unchanged.json()).automation;
  assert.equal(unchangedAutomation.version, firstAutomation.version);
  assert.equal(unchangedAutomation.instructions, draft.instructions);

  await app.startAutomations(() => {});
  const legacyCatalog = await (await call("alice", "/automations/catalog")).json();
  assert.equal(legacyCatalog.capabilities.automations.delete, undefined);
  const deleteCatalog = await (
    await call("alice", "/automations/catalog", {
      headers: { "x-alcove-capabilities": "automation-delete-v1" },
    })
  ).json();
  assert.equal(deleteCatalog.capabilities.automations.delete, true);
  const binding = await bindProtectedAutomationJobWithAdmission(
    captureProtectedStateWorkerContext(stateDir),
    {
      profileId: bob.id,
      automationId: bobAutomation.id,
      jobId: randomUUID(),
      definitionRevision: Number(bobAutomation.version),
      now: Date.now(),
    },
    { profileId: bob.id, assertCurrent() {} },
  );
  assert.equal(binding.status, "bound");
  const boundDelete = await call("bob", `/automations/${bobAutomation.id}`, {
    method: "DELETE",
    headers: { "if-match": bobAutomation.version },
  });
  assert.equal(boundDelete.status, 409);
  assert.equal((await boundDelete.json()).error.code, "automation_busy");
  const route = `/automations/${firstAutomation.id}`;
  const deleteAutomation = (subject: string, version?: string) =>
    call(subject, route, {
      method: "DELETE",
      headers: version === undefined ? {} : { "if-match": version },
    });
  assert.equal((await deleteAutomation("alice")).status, 428);
  assert.equal((await deleteAutomation("bob", firstAutomation.version)).status, 404);
  const staleDelete = await deleteAutomation("alice", "999");
  assert.equal(staleDelete.status, 412);
  assert.equal((await staleDelete.json()).error.code, "version_mismatch");
  assert.equal((await deleteAutomation("alice", firstAutomation.version)).status, 204);
  assert.equal((await deleteAutomation("alice", firstAutomation.version)).status, 404);
  const replacement = await call("alice", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(replacement.status, 201);

  const withoutStorageLimits = createProtectedHttp(options);
  t.after(() => withoutStorageLimits.shutdown());
  const catalogWithoutLimits = await withoutStorageLimits.fetch(
    new Request(`${origin}/api/protected/v1/automations/catalog`, {
      headers: { origin, cookie: "synthetic=alice" },
    }),
  );
  const disabledCatalog = await catalogWithoutLimits.json();
  assert.equal(disabledCatalog.capabilities.automations.list, false);
  assert.equal(disabledCatalog.capabilities.automations.create, false);
  const disabledCreate = await withoutStorageLimits.fetch(
    new Request(`${origin}/api/protected/v1/automations`, {
      method: "POST",
      headers: {
        origin,
        cookie: "synthetic=alice",
        "content-type": "application/json",
      },
      body: JSON.stringify(draft),
    }),
  );
  assert.equal(disabledCreate.status, 404);
});

void test("the owner sets member storage limits and is exempt from them", async (t) => {
  const stateDir = path.resolve(".artifacts", `storage-limit-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const origin = "https://limits.example";
  const issuer = "https://identity.example";
  const expiresAt = Date.now() + 120_000;
  const MiB = 1024 * 1024;
  const options = {
    origin,
    stateDir,
    accessIssuer: issuer,
    ownerSubject: "alice",
    directory: { issuer, allowedSubjects: ["alice", "bob"] },
    usersRoot: await root(stateDir),
    verifyIdentity: async (request: Request) => {
      const subject = request.headers.get("cookie")?.slice("synthetic=".length);
      if (subject !== "alice" && subject !== "bob") {
        throw new ProtectedError(401, "unauthorized", "Sign in.");
      }
      return {
        issuer,
        subject,
        kind: "human" as const,
        sessionId: subject,
        expiresAt,
        assertCurrent() {},
        async revalidate() {},
      };
    },
    agentExtensions: [protectedResearchAgent],
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    turns: {
      models: [
        {
          provider: "sparky" as const,
          id: "synthetic-sparky",
          label: "Synthetic Sparky",
          thinking: { levels: ["low" as const], default: "low" as const },
        },
      ],
      async run() {
        assert.fail("Storage limit proof does not run an agent.");
      },
      async steer() {
        assert.fail("Storage limit proof does not steer an agent.");
      },
    },
  };
  const app = createProtectedHttp({
    ...options,
    storageLimits: { globalBytes: 64 * MiB, userBytes: 32 * MiB, freeFloorBytes: 1 },
  });
  t.after(() => app.shutdown());
  const fetchFrom = (target: typeof app) => (subject: string, route: string, init?: RequestInit) =>
    target.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: `synthetic=${subject}`,
          "content-type": "application/json",
          ...init?.headers,
        },
      }),
    );
  const call = fetchFrom(app);
  for (const subject of ["alice", "bob"]) {
    assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "added");
    await call(subject, "/me");
  }
  const people = (await (await call("alice", "/admin/people")).json()).people as {
    id: string;
    subject?: string;
  }[];
  const bobId = people.find((person) => person.subject === "bob")!.id;
  const aliceId = people.find((person) => person.subject === "alice")!.id;
  const route = (id: string) => `/admin/people/${id}/storage-limit`;
  const errorCode = async (response: Response) => (await response.json()).error.code;

  assert.equal((await call("bob", route(bobId))).status, 403);
  const initial = await (await call("alice", route(bobId))).json();
  assert.deepEqual(
    { ...initial, usedBytes: typeof initial.usedBytes },
    {
      usedBytes: "number",
      limitBytes: 32 * MiB,
      defaultLimitBytes: 32 * MiB,
      customLimitBytes: null,
      exempt: false,
      minLimitBytes: 16 * MiB,
      maxLimitBytes: 64 * MiB,
      version: "default",
    },
  );
  const put = (id: string, value: unknown, version?: string) =>
    call("alice", route(id), {
      method: "PUT",
      headers: version ? { "if-match": version } : {},
      body: JSON.stringify(value),
    });
  const missingVersion = await put(bobId, { limitBytes: 20 * MiB });
  assert.equal(missingVersion.status, 428);
  assert.equal(await errorCode(missingVersion), "version_required");
  for (const value of [
    { limitBytes: 1 },
    { limitBytes: 65 * MiB },
    { limitBytes: 20 * MiB, x: 1 },
  ]) {
    const rejected = await put(bobId, value, "default");
    assert.equal(rejected.status, 400);
    assert.equal(await errorCode(rejected), "invalid_limit");
  }
  const updated = await put(bobId, { limitBytes: 20 * MiB }, initial.version);
  assert.equal(updated.status, 200);
  const custom = await updated.json();
  assert.equal(custom.limitBytes, 20 * MiB);
  assert.equal(custom.customLimitBytes, 20 * MiB);
  assert.notEqual(custom.version, initial.version);
  const stale = await put(bobId, { limitBytes: 24 * MiB }, initial.version);
  assert.equal(stale.status, 409);
  assert.equal(await errorCode(stale), "version_conflict");

  // Quota admission and the member's storage view read the same effective limit.
  assert.equal((await (await call("bob", "/storage/chats")).json()).limitBytes, 20 * MiB);
  assert.equal((await (await call("alice", "/storage/chats")).json()).limitBytes, null);

  const owner = await (await call("alice", route(aliceId))).json();
  assert.equal(owner.exempt, true);
  assert.equal(owner.limitBytes, null);
  const exempt = await put(aliceId, { limitBytes: 20 * MiB }, owner.version);
  assert.equal(exempt.status, 409);
  assert.equal(await errorCode(exempt), "limit_exempt");

  const reset = await call("alice", route(bobId), {
    method: "DELETE",
    headers: { "if-match": custom.version },
  });
  assert.equal(reset.status, 200);
  const restored = await reset.json();
  assert.equal(restored.customLimitBytes, null);
  assert.equal(restored.limitBytes, 32 * MiB);
  const unknown = await call("alice", route(randomUUID()));
  assert.equal(unknown.status, 404);
  assert.equal(await errorCode(unknown), "person_not_found");

  // With a tiny budget the owner can exceed both limits; members then see the shared-budget reason.
  const small = createProtectedHttp({
    ...options,
    storageLimits: { globalBytes: 12_000, userBytes: 8_000, freeFloorBytes: 1 },
  });
  t.after(() => small.shutdown());
  const smallCall = fetchFrom(small);
  const draft = {
    name: "Synthetic limit test",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky", id: "synthetic-sparky" },
    schedule: { kind: "every", everyMs: 60_000 },
  };
  for (let index = 0; index < 3; index += 1) {
    const created = await smallCall("alice", "/automations", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    assert.equal(created.status, 201);
  }
  const blocked = await smallCall("bob", "/automations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  assert.equal(blocked.status, 413);
  const blockedError = (await blocked.json()).error;
  assert.equal(blockedError.code, "quota_exceeded");
  assert.match(blockedError.message, /shared storage/u);
});

void test("automation authoring chats hold a server binding and save only the sent draft", async (t) => {
  const stateDir = path.resolve(".artifacts", `automation-authoring-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await prepareProtectedSharedState(stateDir, () => {});
  const origin = "https://authoring.example";
  const expiresAt = Date.now() + 120_000;
  const routed: boolean[] = [];
  const app = createProtectedHttp({
    origin,
    stateDir,
    accessIssuer: "https://identity.example",
    directory: { issuer: "https://identity.example", allowedSubjects: ["alice", "bob"] },
    usersRoot: await root(stateDir),
    verifyIdentity: async (request: Request) => {
      const subject = request.headers.get("cookie")?.slice("synthetic=".length);
      if (subject !== "alice" && subject !== "bob") {
        throw new ProtectedError(401, "unauthorized", "Sign in.");
      }
      return {
        issuer: "https://identity.example",
        subject,
        kind: "human" as const,
        sessionId: subject,
        expiresAt,
        assertCurrent() {},
        async revalidate() {},
      };
    },
    agentExtensions: [protectedResearchAgent],
    maxChatsPerUser: 10,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 400_000, userBytes: 200_000, freeFloorBytes: 1 },
    turns: {
      models: [
        {
          provider: "sparky" as const,
          id: "synthetic-sparky",
          label: "Synthetic Sparky",
          thinking: { levels: ["low" as const], default: "low" as const },
        },
      ],
      async run(turn) {
        routed.push(turn.routing !== undefined);
        const tools = turn.automationChat;
        if (tools && "authoring" in tools) {
          const current = await tools.read();
          // One model message may carry parallel tool calls; the bindings must order them.
          await Promise.all([
            turn.input.text.includes("update")
              ? tools.update({ draft: { ...current.draft, name: "Revised by chat" } })
              : undefined,
            turn.input.text.includes("save")
              ? tools.save({ draftRevision: turn.input.text.split(" ").at(-1)! })
              : undefined,
          ]);
        }
        await turn.delta("Done.");
      },
      async steer() {
        assert.fail("Authoring proof does not steer an agent.");
      },
    },
  });
  t.after(() => app.shutdown());
  const negotiated = "automations-chat-v1, automations-authoring-v1";
  const call = (subject: string, route: string, init?: RequestInit, capabilities = negotiated) =>
    app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: `synthetic=${subject}`,
          "content-type": "application/json",
          "x-alcove-capabilities": capabilities,
          ...init?.headers,
        },
      }),
    );
  const profiles: Record<string, string> = {};
  for (const subject of ["alice", "bob"]) {
    profiles[subject] = (await (await call(subject, "/me")).json()).user.id;
    assert.equal(
      await addProtectedSubject(stateDir, { issuer: "https://identity.example", subject }),
      "added",
    );
  }
  const draft = {
    name: "Synthetic authoring draft",
    instructions: "Summarize public project updates.",
    whenToNotify: "Only when there is a meaningful update.",
    agentId: "travel",
    model: { provider: "sparky" as const, id: "synthetic-sparky" },
    thinking: "low" as const,
    schedule: { kind: "every" as const, everyMs: 60_000 },
  };
  const turn = async (
    subject: string,
    chatId: string,
    text: string,
    authoring?: Record<string, unknown>,
    capabilities = negotiated,
  ) => {
    const response = await call(
      subject,
      `/chats/${chatId}/turns`,
      {
        method: "POST",
        headers: { "x-grogu-profile": profiles[subject]! },
        body: JSON.stringify({ provider: "sparky", text, ...(authoring ? { authoring } : {}) }),
      },
      capabilities,
    );
    const raw = await response.text();
    if (response.status !== 200) {
      const events: ProtectedAuthoringTurnEvent[] = [];
      return { status: response.status, code: JSON.parse(raw).error.code as string, events };
    }
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProtectedAuthoringTurnEvent);
    return { status: 200, code: undefined, events };
  };
  const ofType = <T extends ProtectedAuthoringTurnEvent["type"]>(
    events: ProtectedAuthoringTurnEvent[],
    type: T,
  ) =>
    events.filter(
      (event): event is Extract<ProtectedAuthoringTurnEvent, { type: T }> => event.type === type,
    );
  const listAutomations = async () =>
    (await (await call("alice", "/automations")).json()).automations as { id: string }[];

  const plainCatalog = await (
    await call("alice", "/automations/catalog", {}, "automations-chat-v1")
  ).json();
  assert.equal(plainCatalog.capabilities.automations.chat.authoring, undefined);
  const catalog = await (await call("alice", "/automations/catalog")).json();
  assert.equal(catalog.capabilities.automations.chat.authoring, true);
  assert.equal(
    (await call("alice", "/automations/authoring", { method: "POST" }, "automations-chat-v1"))
      .status,
    404,
  );

  // The first message creates an unsaved Grogu chat; nothing is saved or scheduled.
  const created = await call("alice", "/automations/authoring", { method: "POST" });
  assert.equal(created.status, 201);
  const { chat } = await created.json();
  assert.deepEqual(chat.authoring, { kind: "automation" });
  assert.equal(chat.selectedAgentId, "grogu");
  assert.deepEqual(await listAutomations(), []);
  const isolatedAuthoring = await turn("alice", chat.id, "Save", {
    draft: { ...draft, contextAccess: "isolated" },
    draftRevision: "1",
  });
  assert.equal(isolatedAuthoring.status, 503);
  assert.equal(isolatedAuthoring.code, "automation_isolation_unavailable");
  assert.deepEqual(await listAutomations(), []);
  const agentSwitch = await call("alice", `/chats/${chat.id}/agent`, {
    method: "PATCH",
    headers: { "if-match": chat.version },
    body: JSON.stringify({ selectedAgentId: "travel" }),
  });
  assert.equal(agentSwitch.status, 409);
  assert.equal((await agentSwitch.json()).error.code, "authoring_chat");

  // The server-held binding, not the body, decides whether a turn may author.
  assert.equal((await turn("alice", chat.id, "Hello")).code, "authoring_required");
  assert.equal(
    (await turn("alice", chat.id, "Hello", { draft, draftRevision: "1" }, "automations-chat-v1"))
      .code,
    "authoring_required",
  );
  assert.equal((await turn("bob", chat.id, "Hello", { draft, draftRevision: "1" })).status, 404);
  const { chat: ordinary } = await (
    await call("alice", "/chats", { method: "POST", body: "{}" })
  ).json();
  assert.equal(
    (await turn("alice", ordinary.id, "Hello", { draft, draftRevision: "1" })).status,
    400,
  );
  assert.equal(
    (await turn("alice", chat.id, "Hello", { draft, draftRevision: "1", automationVersion: "1" }))
      .status,
    400,
  );

  const updated = await turn("alice", chat.id, "Please update", { draft, draftRevision: "4" });
  assert.deepEqual(ofType(updated.events, "automation-draft-update"), [
    {
      type: "automation-draft-update",
      baseDraftRevision: "4",
      draftRevision: "5",
      draft: { ...draft, name: "Revised by chat" },
    },
  ]);
  assert.deepEqual(await listAutomations(), []);
  const changedThenSaved = await turn("alice", chat.id, "Please update and save 5", {
    draft,
    draftRevision: "5",
  });
  assert.deepEqual(ofType(changedThenSaved.events, "automation-save-refused"), [
    { type: "automation-save-refused", draftRevision: "5", reason: "draft_changed" },
  ]);
  assert.deepEqual(await listAutomations(), []);
  // A starter draft's [bracketed] placeholders must be replaced before chat can save it.
  const unfinished = await turn("alice", chat.id, "Please save 5", {
    draft: { ...draft, instructions: "Check the forecast for [your town or area]." },
    draftRevision: "5",
  });
  assert.deepEqual(ofType(unfinished.events, "automation-save-refused"), [
    { type: "automation-save-refused", draftRevision: "5", reason: "invalid" },
  ]);
  assert.deepEqual(await listAutomations(), []);

  // A first save that stopped before binding left its record under the chat id; a retry reuses it.
  const orphan = await createProtectedAutomationWithAdmission(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      profileId: profiles.alice!,
      definition: { ...draft, name: "Saved before binding" },
      now: Date.now(),
      automationId: chat.id,
    },
    { profileId: profiles.alice!, assertCurrent() {} },
  );
  assert.ok(orphan.status === "created");
  const interrupted = await turn("alice", chat.id, "Please save 6", { draft, draftRevision: "6" });
  assert.deepEqual(ofType(interrupted.events, "automation-save-refused"), [
    {
      type: "automation-save-refused",
      draftRevision: "6",
      reason: "version_mismatch",
      currentVersion: String(orphan.automation.definitionRevision),
    },
  ]);
  assert.deepEqual(ofType(interrupted.events, "automation-saved"), []);
  assert.deepEqual(
    (await listAutomations()).map(({ id }) => id),
    [chat.id],
  );
  const bound = (await (await call("alice", "/chats")).json()).chats.find(
    ({ id }: { id: string }) => id === chat.id,
  );
  assert.deepEqual(bound.authoring, { kind: "automation", automationId: chat.id });
  // Released clients parse chats against strict V1 schemas without the authoring field.
  const v1Chats = (await (await call("alice", "/chats", {}, "automations-chat-v1")).json()).chats;
  assert.ok(v1Chats.some(({ id }: { id: string }) => id === chat.id));
  assert.ok(v1Chats.every((summary: object) => !("authoring" in summary)));
  const v1Chat = (
    await (await call("alice", `/chats/${chat.id}`, {}, "automations-chat-v1")).json()
  ).chat;
  assert.equal("authoring" in v1Chat, false);
  const savedEvent = {
    automation: { version: String(orphan.automation.definitionRevision) },
  };

  // A bound chat requires the record version it was opened against.
  assert.equal(
    (await turn("alice", chat.id, "Hello", { draft, draftRevision: "7" })).code,
    "version_required",
  );
  const resaved = await turn("alice", chat.id, "Please save 7", {
    draft,
    draftRevision: "7",
    automationVersion: savedEvent.automation.version,
  });
  const [resavedEvent] = ofType(resaved.events, "automation-saved");
  assert.ok(resavedEvent);
  assert.equal(resavedEvent.automation.name, draft.name);
  assert.equal(resavedEvent.automation.enabled, false);
  assert.notEqual(resavedEvent.automation.version, savedEvent.automation.version);
  assert.equal(
    (
      await turn("alice", chat.id, "Hello", {
        draft,
        draftRevision: "8",
        automationVersion: savedEvent.automation.version,
      })
    ).status,
    412,
  );
  assert.deepEqual(routed, [false, false, false, false, false]);

  // Saved items reopen their one bound chat; other members cannot see or bind them.
  const reopened = await call("alice", `/automations/${chat.id}/authoring`, { method: "POST" });
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).chat.id, chat.id);
  assert.equal(
    (await call("bob", `/automations/${chat.id}/authoring`, { method: "POST" })).status,
    404,
  );
  const formSaved = (
    await (
      await call("alice", "/automations", { method: "POST", body: JSON.stringify(draft) })
    ).json()
  ).automation;
  const finished = await commitProtectedAutomationFinishedResult(
    stateDir,
    {
      automationId: formSaved.id,
      definitionRevision: Number(formSaved.version),
      centralOwnerProfileId: profiles.alice!,
      jobId: "synthetic-job",
      runAtMs: 1_000,
      runId: randomUUID(),
      completedAtMs: 2_000,
      automationName: draft.name,
      privateFinalText: "Synthetic result.",
      transcript: { sessionKey: "synthetic-session", sessionId: randomUUID() },
    },
    {
      profileId: profiles.alice!,
      revalidate: async () => {},
      assertCurrent: () => {},
      enrollPublication: () => ({ finish: () => {} }),
      reserveStorage: async () => ({ settle: () => {}, release: () => {} }),
      retainUncertainCommit: () => {
        assert.fail("Unexpected uncertain result commit.");
      },
    },
  );
  assert.equal(finished.status, "created");
  if (finished.status !== "created") {
    throw new Error("Synthetic result was not saved.");
  }
  const runsPath = `/automations/${formSaved.id}/runs`;
  const runCapabilities = `${negotiated}, automation-results-v1`;
  assert.equal((await call("alice", runsPath)).status, 404);
  const runs = await call("alice", runsPath, {}, runCapabilities);
  assert.equal(runs.status, 200);
  assert.equal((await runs.json()).runs[0].text, "Synthetic result.");
  const result = await call("alice", `${runsPath}/${finished.id}`, {}, runCapabilities);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).run.id, finished.id);
  assert.equal((await call("bob", runsPath, {}, runCapabilities)).status, 404);
  assert.equal((await call("bob", `${runsPath}/${finished.id}`, {}, runCapabilities)).status, 404);
  const first = await call("alice", `/automations/${formSaved.id}/authoring`, { method: "POST" });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.chat.authoring, { kind: "automation", automationId: formSaved.id });
  assert.equal(firstBody.automation.version, formSaved.version);
  const again = await call("alice", `/automations/${formSaved.id}/authoring`, { method: "POST" });
  assert.equal((await again.json()).chat.id, firstBody.chat.id);

  // A form save from an unsaved authoring chat saves under that chat and binds it.
  const formChat = (
    await (await call("alice", "/automations/authoring", { method: "POST" })).json()
  ).chat;
  const formSave = (subject: string, chatId: string, capabilities = negotiated) =>
    call(
      subject,
      "/automations",
      {
        method: "POST",
        headers: { "x-alcove-authoring-chat": chatId },
        body: JSON.stringify(draft),
      },
      capabilities,
    );
  assert.equal((await formSave("alice", formChat.id, "automations-chat-v1")).status, 404);
  assert.equal((await formSave("bob", formChat.id)).status, 404);
  const formBound = await formSave("alice", formChat.id);
  assert.equal(formBound.status, 201);
  const formBoundAutomation = (await formBound.json()).automation;
  assert.equal(formBoundAutomation.id, formChat.id);
  assert.equal(formBoundAutomation.enabled, false);
  const formReopened = await call("alice", `/automations/${formChat.id}/authoring`, {
    method: "POST",
  });
  assert.equal(formReopened.status, 200);
  assert.deepEqual((await formReopened.json()).chat.authoring, {
    kind: "automation",
    automationId: formChat.id,
  });
  const rebound = await formSave("alice", formChat.id);
  assert.equal(rebound.status, 409);
  assert.equal((await rebound.json()).error.code, "authoring_bound");
});
