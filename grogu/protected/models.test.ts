import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CopilotRuntimeAuthError } from "../../extensions/github-copilot/runtime-auth-error.js";
import { bindGithubCopilotToken } from "../../src/plugin-sdk/github-copilot-domain.js";
import { LiveModelCatalogHttpError } from "../../src/plugin-sdk/provider-catalog-live-runtime.js";
import { createProtectedCopilotModelLookup } from "./models.js";

const individual = "https://api.individual.githubcopilot.com";
const business = "https://api.business.githubcopilot.com";
const member = {
  profileId: "member",
  signal: new AbortController().signal,
  revalidate: async () => {},
};
const credential = { accessToken: bindGithubCopilotToken("synthetic-token", "github.com") };

function fixture() {
  const calls: string[] = [];
  const state = {
    baseUrl: individual,
    model: "first",
    hidden: false,
    denyAccount: false,
    denyCatalog: false,
    accountReady: Promise.resolve(),
  };
  const lookup = createProtectedCopilotModelLookup(async () => ({
    CopilotRuntimeAuthError,
    async resolveCopilotRuntimeAuth({ githubToken }) {
      calls.push("account");
      await state.accountReady;
      if (state.denyAccount) {
        throw new CopilotRuntimeAuthError({ reason: "http_error", status: 403 });
      }
      return { apiKey: githubToken, baseUrl: state.baseUrl, source: "synthetic" };
    },
    async fetchCopilotModelCatalog({ baseUrl }) {
      calls.push(baseUrl);
      if (state.denyCatalog) {
        throw new LiveModelCatalogHttpError("github-copilot", 401);
      }
      return [
        {
          id: state.model,
          name: baseUrl,
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 1024,
        },
      ];
    },
    isCopilotCatalogModelVisible: () => !state.hidden,
    getCopilotCatalogVendor: () => undefined,
    getCopilotCatalogContextSizes: () => undefined,
  }));
  return { lookup, state, calls };
}

void test("repeat lookup overlaps both live checks without retaining a model or a grant", async () => {
  const { lookup, state, calls } = fixture();
  assert.equal((await lookup(credential, member))[0]?.model.id, "first");
  assert.deepEqual(calls.splice(0), ["account", individual]);
  const hold = Promise.withResolvers<void>();
  state.accountReady = hold.promise;
  state.hidden = true;
  const repeated = lookup(credential, member);
  await setImmediate();
  try {
    assert.deepEqual(calls.toSorted(), [individual, "account"].toSorted());
  } finally {
    hold.resolve();
  }
  assert.deepEqual(await repeated, []);
  state.hidden = false;
  state.baseUrl = business;
  const moved = await lookup(credential, member);
  assert.equal(moved[0]?.model.label, business);
  assert.equal(moved[0]?.baseUrl, business);

  for (const source of ["denyAccount", "denyCatalog"] as const) {
    state[source] = true;
    await assert.rejects(lookup(credential, member), { code: "provider_auth_failed" });
    state[source] = false;
    calls.length = 0;
    await lookup(credential, member);
    assert.deepEqual(calls, ["account", business], "a denial evicts the hint");
  }
});

void test("route hints never cross profiles, credentials, ambient tenants, or a deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { lookup, calls } = fixture();
  await lookup({ ...credential, expiresAt: 1_100 }, member);
  calls.length = 0;
  t.mock.timers.tick(101);
  await assert.rejects(lookup({ ...credential, expiresAt: 1_100 }, member), {
    code: "provider_credential_expired",
  });
  assert.deepEqual(calls, []);
  await lookup(credential, member);
  assert.deepEqual(
    calls.splice(0),
    ["account", individual],
    "the previous credential expiry caps its hint",
  );
  await assert.rejects(
    lookup(credential, {
      ...member,
      revalidate: async () => {
        throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  assert.deepEqual(calls, []);
  for (const [token, profile] of [
    [credential.accessToken, "other"],
    [bindGithubCopilotToken("different-synthetic-token", "github.com"), member.profileId],
    [bindGithubCopilotToken("enterprise", "one.ghe.com"), member.profileId],
    [bindGithubCopilotToken("enterprise", "one.ghe.com"), member.profileId],
  ] as const) {
    await lookup({ accessToken: token }, { ...member, profileId: profile });
    assert.deepEqual(calls.splice(0), ["account", individual]);
  }
  t.mock.timers.tick(300_001);
  await lookup(credential, member);
  assert.deepEqual(
    calls,
    ["account", individual],
    "even an unexpired credential needs a fresh route after five minutes",
  );
});

void test("an unbound credential follows the current ambient tenant", async (t) => {
  const previous = process.env.COPILOT_GITHUB_DOMAIN;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.COPILOT_GITHUB_DOMAIN;
    } else {
      process.env.COPILOT_GITHUB_DOMAIN = previous;
    }
  });
  const { lookup, calls } = fixture();
  const token = { accessToken: "synthetic-unbound" };
  process.env.COPILOT_GITHUB_DOMAIN = "github.com";
  await lookup(token, member);
  await lookup(token, member);
  assert.deepEqual(calls.splice(0), ["account", individual, individual, "account"]);
  process.env.COPILOT_GITHUB_DOMAIN = "one.ghe.com";
  await lookup(token, member);
  assert.deepEqual(calls, ["account", individual]);
});
