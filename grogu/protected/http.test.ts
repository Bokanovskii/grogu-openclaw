import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { test } from "node:test";
import type { ProtectedPeople } from "@openclaw/gateway-protocol/protected";
import { FailoverError } from "../../src/agents/failover/error.js";
import { root } from "../../src/infra/fs-safe.js";
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
import { ProtectedError, publicError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import type { ProtectedIdentityVerifier } from "./identity.js";
import { createProviderRelay } from "./provider-relay.js";
import { closeProtectedServer, createProtectedServer } from "./server.js";
import { protectedOpenClawConfig } from "./settings.js";
import { createProtectedStaticClient } from "./static-client.js";
import { createCanonicalProtectedTurns } from "./turns.js";

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
      kind: "human",
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
      directory: {
        issuer: "https://synthetic.example",
        allowedSubjects: ["alice", "bob", "carol"],
      },
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

void test("Family directory respects account visibility and isolates the development identity", async (t) => {
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
    const call = (user: keyof typeof subjects, route: string, init?: RequestInit) =>
      fetch(`${url}/api/protected/v1${route}`, {
        ...init,
        headers: {
          origin,
          cookie: `synthetic=${user}`,
          "content-type": "application/json",
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
  assert.deepEqual((await (await first.call("alice", "/account")).json()).directory, {
    description: "",
    hidden: false,
  });
  assert.equal((await (await first.call("development", "/account")).json()).directory.hidden, true);
  const put = (user: keyof typeof subjects, route: string, value: unknown) =>
    first.call(user, route, { method: "PUT", body: JSON.stringify(value) });

  assert.equal((await put("alice", "/account/name", { displayName: "Alice" })).status, 200);
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
      { id: alice.id, displayName: "Alice", description: "" },
      { id: bob.id, displayName: "Bob", description: "Enjoys books" },
    ],
  );
  assert.deepEqual(await list("development"), []);
  assert.notEqual(development.id, alice.id);
  assert.notEqual(development.id, bob.id);

  assert.equal(
    (await put("bob", "/account/directory-settings", { description: "Enjoys books", hidden: true }))
      .status,
    200,
  );
  assert.deepEqual(await list("alice"), [{ id: alice.id, displayName: "Alice", description: "" }]);
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
  assert.deepEqual(await list("alice"), [{ id: alice.id, displayName: "Alice", description: "" }]);
  assert.equal(
    (await put("bob", "/account/directory-settings", { description: "Enjoys books", hidden: true }))
      .status,
    200,
  );
  await close(first.server);

  const reopened = await open();
  t.after(() => close(reopened.server));
  const afterRestart = await (await reopened.call("alice", "/people")).json();
  assert.deepEqual(afterRestart.people, [{ id: alice.id, displayName: "Alice", description: "" }]);
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

void test("Family canonical turn streams sources and widgets, then drains an active run on close", async (t) => {
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
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
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
          return Response.json({ endpoints: { api: "https://api.business.githubcopilot.com" } });
        case "https://api.business.githubcopilot.com/responses":
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
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
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
  });
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
      if (seen.length === 3) {
        response.once("close", () => providerDisconnected.resolve());
        response.flushHeaders();
        activeProvider.resolve();
        return;
      }
      const widgetArguments = JSON.stringify({
        title: "Synthetic widget",
        widget_code: "<p>Scoped widget body</p>",
      });
      const frames =
        seen.length === 1
          ? [
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
  const options = {
    origin,
    stateDir,
    usersRoot: await root(usersDir),
    maxChatsPerUser: 3,
    maxFileBytes: 64_000,
    storageLimits: { globalBytes: 16_000_000, userBytes: 8_000_000, freeFloorBytes: 1 },
    directory: { issuer: "https://synthetic.example", allowedSubjects: ["synthetic-sparky"] },
    verifyIdentity: (async () => ({
      issuer: "https://synthetic.example",
      subject: "synthetic-sparky",
      kind: "human",
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
        { provider: "sparky", id: "synthetic", label: "Synthetic" },
        { provider: "github-copilot", id: "gpt-5.3-codex", label: "Copilot" },
        { provider: "openai", id: "gpt-5.6-luna", label: "OpenAI" },
        { provider: "anthropic", id: "claude-sonnet-4-6", label: "Anthropic" },
      ],
      resolveSparkyKey: async () => "synthetic-request-only-key",
    }),
  };
  const open = async () => {
    const app = createProtectedHttp(options);
    const server = createProtectedServer(origin, app.fetch);
    const url = await listen(server);
    t.after(() => close(server));
    const call = (route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", headers.get("origin") ?? origin);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      return fetch(`${url}/api/protected/v1${route}`, { ...init, headers });
    };
    return { call, shutdown: () => closeProtectedServer(server, app, stateDir) };
  };
  const { call, shutdown } = await open();
  const { user } = await (await call("/me")).json();
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
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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
  assert.doesNotMatch(JSON.stringify(read), /synthetic-request-only-key|Scoped widget body/);
  assert.notEqual(read.chat.version, chat.version);
  assert.deepEqual(read.chat.messages.at(-1).widgets, [
    { id: widget.id, title: "Synthetic widget" },
  ]);
  const widgetResponse = await reopened(`/chats/${chat.id}/widgets/${widget.id}`);
  assert.equal(widgetResponse.status, 200);
  assert.match((await widgetResponse.json()).html, /Scoped widget body/);
  const deleted = await reopened(`/chats/${chat.id}`, {
    method: "DELETE",
    headers: { "if-match": read.chat.version },
  });
  assert.equal(deleted.status, 204);
  assert.equal((await reopened(`/chats/${chat.id}/widgets/${widget.id}`)).status, 404);

  const { chat: interrupted } = await (await call("/chats", { method: "POST", body: "{}" })).json();
  const route = `/chats/${interrupted.id}`;
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
  await restart.shutdown();
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
