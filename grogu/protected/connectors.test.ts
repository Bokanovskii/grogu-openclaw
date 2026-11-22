import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { operateUserConnector } from "../../src/state/user-connectors.js";
import { gmailReadOnlyScope } from "../../src/state/user-connectors.types.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createProtectedConnectors } from "./connectors.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  after(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
let stateDir: string;
let profileId: string;
let memberId: string;
before(() => {
  stateDir = dirs.make("openclaw-connectors-");
  const database = { path: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }) };
  memberId = ensureProfileForEmail("member@example.test", database).id;
});
beforeEach(() => {
  profileId = ensureProfileForEmail(`${randomUUID()}@example.test`, {
    path: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
  }).id;
});
const client = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-client-secret",
  redirectUri: "https://alcove.example/api/protected/v1/connectors/gmail/callback",
};
const authority = () => ({
  profileId,
  assertCurrent() {},
  async revalidate() {},
});
function fixture(scope = gmailReadOnlyScope) {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.href === "https://oauth2.googleapis.com/token") {
      const refresh = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
      return Response.json({
        access_token: refresh ? "synthetic-refreshed-access" : "synthetic-access",
        refresh_token: refresh ? "synthetic-rotated-refresh" : "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: gmailReadOnlyScope,
      });
    }
    if (url.pathname === "/oauth2/v2/tokeninfo") {
      return Response.json({
        scope,
        audience: client.clientId,
        issued_to: client.clientId,
      });
    }
    if (url.pathname.endsWith("/profile")) {
      return Response.json({ emailAddress: "owner@gmail.example" });
    }
    if (url.hostname === "gmail.googleapis.com") {
      return Response.json({ messages: [{ id: "abcd1234" }] });
    }
    if (url.hostname.endsWith(".icloud.com")) {
      return new Response('<d:multistatus xmlns:d="DAV:"/>', {
        status: 207,
        headers: { "content-type": "application/xml" },
      });
    }
    throw new Error("Unexpected external request");
  };
  const connectors = createProtectedConnectors({
    stateDir,
    authority: authority(),
    googleClient: client,
    fetchImpl,
  });
  return { connectors, requests, fetchImpl };
}

void test("fresh Gmail consent binds only this profile and exposes only bounded GET reads", async () => {
  const { connectors, requests } = fixture();
  const started = new URL((await connectors.startGmail()).authorizationUrl);
  assert.equal(started.searchParams.get("scope"), gmailReadOnlyScope);
  assert.equal(started.searchParams.get("prompt"), "consent");
  assert.equal(started.searchParams.get("include_granted_scopes"), "false");
  const state = started.searchParams.get("state")!;
  await connectors.completeGmail("synthetic-code", state);
  await assert.rejects(connectors.completeGmail("synthetic-code", state), /expired or changed/);
  assert.deepEqual(await connectors.readGmail({ query: "is:unread" }), {
    messages: [{ id: "abcd1234" }],
  });
  const tokenRequest = requests.find(({ url }) => url.pathname === "/token")!;
  const tokenBody = new URLSearchParams(String(tokenRequest.init?.body));
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.match(tokenBody.get("code_verifier")!, /^[A-Za-z0-9_-]{43}$/u);
  const mailboxRequest = requests.at(-1)!;
  assert.equal(mailboxRequest.url.searchParams.get("maxResults"), "50");
  assert.equal(mailboxRequest.init?.method ?? "GET", "GET");
  assert.equal(mailboxRequest.init?.redirect, "manual");
  assert.deepEqual((await connectors.status()).gmail, {
    connected: true,
    account: "owner@gmail.example",
  });
  assert.equal(
    await operateUserConnector(
      { action: "read", profileId: memberId, kind: "gmail" },
      {
        env: { OPENCLAW_STATE_DIR: stateDir },
        assertCurrent() {},
      },
    ),
    undefined,
  );
});

void test("broader Google grants and retired authority cannot persist or return a connection", async () => {
  const { connectors, requests } = fixture("https://mail.google.com/");
  const state = new URL((await connectors.startGmail()).authorizationUrl).searchParams.get(
    "state",
  )!;
  await assert.rejects(connectors.completeGmail("synthetic-code", state), /only gmail.readonly/);
  assert.equal((await connectors.status()).gmail.connected, false);
  assert.equal(
    requests.some(({ url }) => url.pathname.endsWith("/profile")),
    false,
  );
  const retired = createProtectedConnectors({
    stateDir,
    googleClient: client,
    authority: {
      profileId,
      assertCurrent() {
        throw new Error("Retired owner");
      },
      async revalidate() {
        throw new Error("Retired owner");
      },
    },
    fetchImpl: async () => {
      throw new Error("Must not send");
    },
  });
  await assert.rejects(retired.startGmail(), /Retired owner/);
  await connectors.disconnect("gmail");
});

void test("Calendar checks fresh credentials and permits only Apple discovery and event REPORTs", async () => {
  const { connectors, requests } = fixture();
  await connectors.connectCalendar("owner@example.test", "aaaa-bbbb-cccc-dddd");
  await connectors.discoverCalendar("https://p01-caldav.icloud.com/123/calendars/");
  await connectors.readCalendar({
    url: "https://p01-caldav.icloud.com/123/calendars/work/",
    start: "20261122T000000Z",
    end: "20261123T000000Z",
  });
  assert.deepEqual(
    requests.map(({ init }) => init?.method),
    ["PROPFIND", "PROPFIND", "REPORT"],
  );
  assert.match(String(requests.at(-1)?.init?.body), /name="VEVENT"/u);
  assert.match(String(requests.at(-1)?.init?.body), /start="20261122T000000Z"/u);
  const count = requests.length;
  await assert.rejects(
    connectors.discoverCalendar("https://example.test/private"),
    /valid connector details/,
  );
  assert.equal(requests.length, count);
  assert.doesNotMatch(JSON.stringify(await connectors.status()), /aaaa-bbbb/u);
});

void test("expired Gmail refresh has one durable owner and rejects stale credential writes", async () => {
  const { connectors, requests } = fixture();
  const state = new URL((await connectors.startGmail()).authorizationUrl).searchParams.get(
    "state",
  )!;
  await connectors.completeGmail("synthetic-code", state);
  const options = { env: { OPENCLAW_STATE_DIR: stateDir }, assertCurrent() {} };
  const old = await operateUserConnector({ action: "read", profileId, kind: "gmail" }, options);
  assert.ok(old?.kind === "gmail" && old.credential);
  const expired = {
    ...old,
    generation: randomUUID(),
    credential: { ...old.credential, expiresAt: 1 },
  };
  await operateUserConnector(
    {
      action: "replace",
      kind: "gmail",
      profileId,
      expectedGeneration: old.generation,
      connector: expired,
    },
    options,
  );
  const results = await Promise.allSettled([connectors.readGmail({}), connectors.readGmail({})]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  const refreshRequests = requests.filter(
    ({ url, init }) =>
      url.pathname === "/token" &&
      new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token",
  );
  assert.equal(refreshRequests.length, 1);
  const stored = await operateUserConnector({ action: "read", profileId, kind: "gmail" }, options);
  assert.ok(stored?.kind === "gmail" && stored.credential);
  assert.equal(stored.credential.refreshToken, "synthetic-rotated-refresh");
  assert.equal(stored.pending, undefined);
  await assert.rejects(
    operateUserConnector(
      {
        action: "replace",
        kind: "gmail",
        profileId,
        expectedGeneration: expired.generation,
        connector: { ...expired, generation: randomUUID() },
      },
      options,
    ),
    /Connector changed/,
  );
});

void test("a Gmail response cannot escape after its profile is revoked during the request", async () => {
  const { fetchImpl } = fixture();
  const connectors = createProtectedConnectors({
    stateDir,
    authority: authority(),
    googleClient: client,
    fetchImpl: async (input, init) => {
      const response = await fetchImpl(input, init);
      if (new URL(String(input)).pathname.endsWith("/messages")) {
        await updateCanonicalUserProfileAccess(
          { action: "revoke", profileId },
          {
            env: { OPENCLAW_STATE_DIR: stateDir },
          },
        );
      }
      return response;
    },
  });
  const state = new URL((await connectors.startGmail()).authorizationUrl).searchParams.get(
    "state",
  )!;
  await connectors.completeGmail("synthetic-code", state);
  await assert.rejects(connectors.readGmail({}), /profile is unavailable/);
});
