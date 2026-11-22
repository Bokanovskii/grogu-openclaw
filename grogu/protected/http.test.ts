import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as connectSocket } from "node:net";
import path from "node:path";
import { after, before as beforeTests, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ProtectedAgentCatalogSchema,
  ProtectedAgentCatalogV1Schema,
  ProtectedAutomationCatalogSchema,
  ProtectedAutomationCatalogV1Schema,
  ProtectedAutomationDraftValidationSchema,
  ProtectedAutomationListResponseSchema,
  ProtectedAutomationResponseSchema,
  type ProtectedModel,
  type ProtectedPeople,
} from "@openclaw/gateway-protocol/protected";
import { Value } from "typebox/value";
import { FailoverError } from "../../src/agents/failover/error.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { bindGithubCopilotToken } from "../../src/plugin-sdk/github-copilot-domain.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../../src/state/openclaw-agent-db-lease.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../src/state/user-preferences.js";
import {
  ensureCanonicalUserProfileForVerifiedIdentity,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
} from "../../src/state/user-profile-writes.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { addProtectedSubject } from "./admission-store.js";
import { protectedResearchAgent, type ProtectedAgentExtension } from "./agents.js";
import { ProtectedError, publicError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import type { ProtectedIdentityVerifier } from "./identity.js";
import { withThinking } from "./models.js";
import { createProviderRelay } from "./provider-relay.js";
import { closeProtectedServer, createProtectedServer } from "./server.js";
import { protectedOpenClawConfig } from "./settings.js";
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
) {
  const content = { type: "output_text", text, annotations: [] };
  const message = { type: "message", id: "msg_family", role: "assistant", content: [content] };
  return providerSse([
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { ...content, text: "" },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_family",
        status: "completed",
        output: [message],
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

void test("deleting another member's chat frees quota for a running turn", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-quota-http-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
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
  const me = await first.call("alice", "/me");
  assert.equal(me.status, 200);
  const { user, capabilities } = await me.json();
  assert.deepEqual(capabilities, { copilotConnect: true, openaiConnect: true, admin: false });
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
  const automationDraft = {
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
  assert.equal((await (await first.call("bob", "/storage/chats")).json()).usedBytes, 0);
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
      tools?: Array<{ function: { name: string } }>;
    };
  }> = [];
  const activeProvider = Promise.withResolvers<void>();
  const providerDisconnected = Promise.withResolvers<void>();
  const offlineProvider = Promise.withResolvers<void>();
  const offlineRelease = Promise.withResolvers<void>();
  const offlineSettled = Promise.withResolvers<void>();
  const offlineDisconnected = Promise.withResolvers<void>();
  const offlinePrompt = "Finish this reply after the connection closes";
  const failedOfflinePrompt = "Fail this reply after the connection closes";
  const failedOfflineProvider = Promise.withResolvers<void>();
  const failedOfflineRelease = Promise.withResolvers<void>();
  const failedOfflineSettled = Promise.withResolvers<void>();
  const failedOfflineDisconnected = Promise.withResolvers<void>();
  t.after(() => offlineRelease.resolve());
  t.after(() => failedOfflineRelease.resolve());
  const sourceUrl = "https://example.com/family-source";
  const routePrompt = "Hand this trip to the right agent.";
  const routeBrief = "Plan a relaxed weekend in Lisbon for two adults.";
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
  const copilotBodies: Array<{ model?: string; reasoning?: { effort?: string } }> = [];
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
                  model_picker_enabled: true,
                  capabilities: { type: "chat", supports: { reasoning_effort: ["low", "high"] } },
                },
                {
                  id: "gpt-5.4",
                  name: "Second model",
                  object: "model",
                  model_picker_enabled: true,
                  capabilities: {
                    type: "chat",
                    limits: { max_context_window_tokens: 64000 },
                    supports: { reasoning_effort: ["low", "high"] },
                  },
                },
                {
                  id: "no-reasoning",
                  name: "No reasoning",
                  object: "model",
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
          case "https://api.business.githubcopilot.com/responses":
            copilotBodies.push(await new Request(input, init).json());
            return responsesReply("Canonical Copilot reply.", copilotUsage);
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
      const routeArguments = JSON.stringify(body.messages).includes(routePrompt)
        ? { agentId: "travel", brief: routeBrief }
        : JSON.stringify(body.messages).includes(selfRoutePrompt)
          ? { agentId: "grogu", brief: "Answer it yourself." }
          : undefined;
      const hasToolResponse = body.messages.some(
        (message: { role?: string }) => message.role === "tool",
      );
      const sessionListTurn = JSON.stringify(body.messages).includes(
        "Inspect my permitted sessions.",
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
          : (cleanupTurn || finalWidgetTurn) && !hasToolResponse
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
                      [{ role: "assistant", content: "Committed synthetic answer." }, null],
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
  const { user, models: fixedModels } = await me.json();
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
    const end = text.indexOf("\n## Current agent: ");
    assert.ok(end > 0, "the request contains the Alcove current-agent section");
    return text.slice(0, end);
  };
  assert.deepEqual(toolNames(seen[0]), mainRunTools);
  assert.match(systemText(seen[0]), /\n# Alcove\n/);
  const { call: reopened } = await open();
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
  assert.ok(mentionedEvents.some((event) => event.type === "done"));
  assert.ok(
    mentionedEvents.some(
      (event) =>
        event.type === "child-result" &&
        event.agentId === "cleanup" &&
        event.text === "Committed synthetic answer.",
    ),
    "the native child result is streamed with its protected agent attribution",
  );
  const mentionedRead = await (await reopened(`/chats/${chat.id}`)).json();
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
    25,
    "usage includes both parent turns and both native child provider requests",
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
  assert.match(systemText(travelRequest), /\n## Skill: Travel dashboard\n/);
  assert.match(systemText(travelRequest), /```html\n<style>[\s\S]*<details class="day" open>/);
  assert.doesNotMatch(systemText(seen[0]), /## Skill: Travel dashboard/);
  // Earlier child runs must not seed workspace onboarding into later member prompts.
  assert.doesNotMatch(systemText(travelRequest), /## Bootstrap Pending/);
  // Grogu and Travel requests differ only after the shared header.
  assert.deepEqual(travelRequest?.body.tools, seen[0]?.body.tools);
  assert.equal(sharedPrefix(travelRequest), sharedPrefix(seen[0]));

  const { chat: routedChat } = await (
    await reopened("/chats", { method: "POST", body: "{}" })
  ).json();
  const firstRoutedRequest = seen.length;
  const routedTurn = await reopened(`/chats/${routedChat.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: routePrompt }),
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(routedTurn.status, 200);
  const routedEvents = (await routedTurn.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(routedEvents.at(-1)?.type, "done", JSON.stringify(routedEvents));
  assert.deepEqual(
    routedEvents
      .filter((event) => event.type === "child-result")
      .map((event) => [event.agentId, event.text]),
    [["travel", "Committed synthetic answer."]],
  );
  const routedRequests = seen.slice(firstRoutedRequest);
  assert.equal(routedRequests.length, 2, "Grogu routes once and Travel answers once");
  assert.match(systemText(routedRequests[0]), /\n## Current agent: Grogu \(grogu\)\n/);
  const routedChild = routedRequests[1];
  assert.match(systemText(routedChild), /\n## Current agent: Travel \(travel\)\n/);
  assert.match(systemText(routedChild), /\n## Skill: Travel dashboard\n/);
  assert.deepEqual(toolNames(routedChild), childTools, "a routed agent cannot route again");
  assert.match(JSON.stringify(routedChild?.body.messages), new RegExp(routeBrief));
  const routedRead = await (await reopened(`/chats/${routedChat.id}`)).json();
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
  const sessionHistoryPrompt = "Inspect my permitted sessions.";
  const sessionHistoryTurn = await reopened(`/chats/${coordinator.id}/turns`, {
    method: "POST",
    body: JSON.stringify({ provider: "sparky", text: sessionHistoryPrompt }),
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(sessionHistoryTurn.status, 200);
  assert.match(await sessionHistoryTurn.text(), /"type":"done"/);
  const sessionHistoryRequests = seen.filter(({ body }) =>
    JSON.stringify(body.messages).includes(sessionHistoryPrompt),
  );
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
  const copilotModels = () =>
    call("/providers/github-copilot/models", {
      method: "POST",
      headers: { "x-grogu-profile": user.id },
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
    const listing = await copilotModels();
    assert.equal(listing.status, 200);
    const { models } = await listing.json();
    assert.deepEqual(
      models.map((model: { id: string }) => model.id),
      ["gpt-5.3-codex", "gpt-5.4", "no-reasoning"],
    );
    assert.equal(models[1].contextWindow, 64000);
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
    const chosen = await copilotTurn("high");
    assert.equal(chosen.status, 200);
    const chosenEvents = (await chosen.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(copilotBodies.at(-1)?.model, "gpt-5.4");
    assert.equal(copilotBodies.at(-1)?.reasoning?.effort, "high");
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
  const plaintextMarkers = [
    suffix,
    "Reply briefly",
    "Committed synthetic answer.",
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
  await call("bob", "/me");
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
  assert.equal(firstCreated.status, 201);
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
