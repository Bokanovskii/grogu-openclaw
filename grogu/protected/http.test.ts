import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect as connectSocket } from "node:net";
import path from "node:path";
import { before as beforeTests, test } from "node:test";
import { FailoverError } from "../../src/agents/failover/error.js";
import { root } from "../../src/infra/fs-safe.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../../src/state/openclaw-agent-db-lease.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
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

function providerSse(events: Array<{ type: string; [field: string]: unknown }>, named = false) {
  return new Response(
    events
      .map((event) => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesReply(text: string) {
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
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
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
    ["--import", "tsx", "--input-type=module", "-e", script],
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
  const staticClient = await createProtectedStaticClient(await root(bundleDir));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const usersRoot = await root(usersDir);
  const expiresAt = Date.now() + 120_000;
  const verifyIdentity: ProtectedIdentityVerifier = async (request) => {
    const subject = request.headers.get("cookie")?.slice("synthetic=".length);
    if (subject !== "alice" && subject !== "bob" && subject !== "carol") {
      throw new ProtectedError(401, "unauthorized", "Sign in.");
    }
    return {
      issuer: "https://synthetic.example",
      subject,
      expiresAt,
      sessionId: createHash("sha256").update(subject).digest("hex"),
      assertCurrent() {},
      async revalidate() {},
    };
  };
  const submitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const origin = "https://family.example";
  const open = async (freeFloorBytes = 1) => {
    const app = createProtectedHttp({
      origin,
      stateDir,
      usersRoot,
      verifyIdentity,
      maxChatsPerUser: 3,
      maxFileBytes: 64_000,
      storageLimits: { globalBytes: 95_000, userBytes: 58_000, freeFloorBytes },
      providerRelay: createProviderRelay(),
      turns: {
        models: [{ provider: "anthropic", id: "synthetic", label: "Synthetic only" }],
        async run(turn) {
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
    const call = (user: string, route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", headers.get("origin") ?? origin);
      headers.set("cookie", headers.get("cookie") ?? `synthetic=${user}`);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      return fetch(`${url}/api/protected/v1${route}`, { ...init, headers });
    };
    return { server, url, call, revokeProfile: (id: string) => app.revokeProfile(id) };
  };
  const first = await open();
  t.after(() => close(first.server));
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
  assert.deepEqual(capabilities, { copilotConnect: true, openaiConnect: true });
  const created = await first.call("alice", "/chats", {
    method: "POST",
    body: '{"title":"Alice private"}',
  });
  assert.equal(created.status, 200);
  const { chat } = await created.json();
  const route = `/chats/${chat.id}`;
  const secondAlice = await first.call("alice", "/chats", { method: "POST", body: "{}" });
  assert.equal(secondAlice.status, 413);
  assert.equal((await secondAlice.json()).error.code, "quota_exceeded");
  assert.equal((await first.call("bob", route)).status, 404);
  assert.deepEqual(await (await first.call("bob", "/export")).json(), { chats: [] });
  assert.equal(
    (await first.call("alice", route, { method: "DELETE", headers: { "if-match": "stale" } }))
      .status,
    409,
  );

  const turn = {
    method: "POST",
    body: '{"provider":"anthropic","text":"Hello","credential":{"accessToken":"synthetic-only"}}',
  };
  assert.equal((await first.call("alice", `${route}/turns`, turn)).status, 403);
  const running = await first.call("alice", `${route}/turns`, {
    ...turn,
    headers: { "x-grogu-profile": user.id },
  });
  assert.equal(running.status, 200);
  await submitted.promise;
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
      ["github-copilot", "https://github.com/login/device", "synthetic-github"],
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
  assert.equal((await first.call("bob", "/logout", { method: "POST" })).status, 204);
  await close(first.server);

  const reopened = await open(Number.MAX_SAFE_INTEGER);
  t.after(() => close(reopened.server));
  assert.equal((await reopened.call("alice", "/me")).status, 401);
  assert.equal((await reopened.call("bob", "/me")).status, 401);
  const lowDisk = await reopened.call("carol", "/chats", { method: "POST", body: "{}" });
  assert.equal(lowDisk.status, 507);
  assert.equal((await lowDisk.json()).error.code, "storage_full");
});

void test("Family canonical turns save sources, widgets, and offline replies, then drain on shutdown", async (t) => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(
    stateDir && path.relative(path.resolve(".artifacts"), stateDir).startsWith("protected-proof-"),
    "Set an isolated OPENCLAW_STATE_DIR under .artifacts/protected-proof-*.",
  );
  const usersDir = path.join(stateDir, "users");
  const workspaceDir = path.join(stateDir, "workspace");
  const agentDir = path.join(stateDir, "agents", "protected", "agent");
  await Promise.all(
    [usersDir, workspaceDir, agentDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  const seen: Array<{
    auth: string | undefined;
    body: { tools?: Array<{ function: { name: string } }> };
  }> = [];
  const activeProvider = Promise.withResolvers<void>();
  const providerDisconnected = Promise.withResolvers<void>();
  const offlineProvider = Promise.withResolvers<void>();
  const offlineRelease = Promise.withResolvers<void>();
  const offlineSettled = Promise.withResolvers<void>();
  const offlineDisconnected = Promise.withResolvers<void>();
  const offlinePrompt = "Finish this reply after the connection closes";
  t.after(() => offlineRelease.resolve());
  const sourceUrl = "https://example.com/family-source";
  const rejectedKeyPrompt = "Use a revoked service key";
  const suffix = randomUUID();
  const githubToken = `gho_family_${suffix}`;
  const anthropicKey = `sk-ant-family-${suffix}`;
  const openaiRefresh = `family-refresh-${suffix}`;
  const accountId = "family-synthetic-account";
  const openaiToken = `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url")}.family-${suffix}`;
  const fallback = `host-fallback-${suffix}`;
  const ambient = ["COPILOT_GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const prior = ambient.map((key) => process.env[key]);
  for (const key of ambient) {
    process.env[key] = fallback;
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
  const originalFetch = globalThis.fetch;
  let fixtureCompleted = false;
  const opened: Array<{ app: { shutdown: () => Promise<void> }; server: Server }> = [];
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
            return responsesReply("Canonical Copilot reply.");
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
      await Promise.all(opened.map(({ app }) => app.shutdown()));
      await Promise.all(opened.map(({ server }) => close(server)));
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
      const widgetArguments = JSON.stringify({
        title: "Synthetic widget",
        widget_code: "<p>Scoped widget body</p>",
      });
      const frames =
        seen.length === 1
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
      response.end("data: [DONE]\n\n");
    })().catch(() => response.destroy());
  });
  const providerOrigin = await listen(provider);
  t.after(() => close(provider));
  const origin = "https://family.example";
  const expiresAt = Date.now() + 120_000;
  const serviceConfig = protectedOpenClawConfig(stateDir);
  const encryption = createStorageValueEncryption(randomBytes(32));
  t.after(() => encryption.dispose());
  const options = {
    origin,
    stateDir,
    usersRoot: await root(usersDir),
    encryption,
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 16_000_000, userBytes: 8_000_000, freeFloorBytes: 1 },
    verifyIdentity: (async () => ({
      issuer: "https://synthetic.example",
      subject: "synthetic-sparky",
      expiresAt,
      sessionId: createHash("sha256").update("synthetic-session").digest("hex"),
      assertCurrent() {},
      async revalidate() {},
    })) satisfies ProtectedIdentityVerifier,
    turns: createCanonicalProtectedTurns({
      config: {
        ...serviceConfig,
        agents: {
          ...serviceConfig.agents,
          defaults: { models: { "openai/gpt-5.6-luna": { params: { transport: "sse" } } } },
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
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      },
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
    const app = createProtectedHttp(options);
    const server = createProtectedServer(origin, app.fetch);
    server.on("request", (incoming, outgoing) => {
      if (incoming.headers["x-proof-disconnect"] === "yes") {
        outgoing.once("close", () => offlineDisconnected.resolve());
      }
    });
    const url = await listen(server);
    opened.push({ app, server });
    const call = (route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", headers.get("origin") ?? origin);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      return fetch(`${url}/api/protected/v1${route}`, { ...init, headers });
    };
    return { call, shutdown: () => closeProtectedServer(server, app, stateDir) };
  };
  const { call, shutdown } = await open();
  const { user, models: fixedModels } = await (await call("/me")).json();
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
  const { chat } = await (await call("/chats", { method: "POST", body: "{}" })).json();
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
  assert.equal(seen[0]?.auth, "Bearer synthetic-request-only-key");
  const tools = seen[0]?.body.tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual([...tools].toSorted(), ["show_widget", "web_fetch"]);
  assert.ok(tools.includes("show_widget"));
  const { call: reopened } = await open();
  const read = await (await reopened(`/chats/${chat.id}`)).json();
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
  const deleted = await reopened(`/chats/${chat.id}`, {
    method: "DELETE",
    headers: { "if-match": read.chat.version },
  });
  assert.equal(deleted.status, 204);
  assert.equal((await reopened(`/chats/${chat.id}/widgets/${widget.id}`)).status, 404);

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
    const before = providerRequests.length;
    assert.match(await (await turn()).text(), /provider_credential_required/);
    assert.equal(providerRequests.length, before);
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
      assert.deepEqual(usageEvents.at(-2), { type: "usage", contextTokens: 3 });
      assert.deepEqual(transcript.usage, {
        contextTokens: 3,
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
        authorization: `Bearer ${githubToken}`,
        account: null,
        key: null,
      },
      {
        endpoint: "https://api.github.com/copilot_internal/user",
        authorization: `Bearer ${githubToken}`,
        account: null,
        key: null,
      },
      {
        endpoint: "https://api.business.githubcopilot.com/responses",
        authorization: `Bearer ${githubToken}`,
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
  } finally {
    await restart.shutdown();
  }
  for (const dir of [stateDir, process.env.HOME!]) {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const bytes = await readFile(path.join(entry.parentPath, entry.name));
        assert.ok(
          !bytes.includes(suffix),
          `synthetic personal credential persisted in ${entry.name}`,
        );
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
