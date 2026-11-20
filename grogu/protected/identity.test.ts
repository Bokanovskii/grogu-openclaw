import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createCloudflareAccessVerifier } from "./identity.js";

const issuer = "https://team.cloudflareaccess.com";
const audience = "a".repeat(64);
const testClientId = `${"b".repeat(32)}.access`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function token(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

function verifier(identity: Record<string, unknown>, configured: string | undefined) {
  return createCloudflareAccessVerifier({
    issuer,
    audience,
    isAllowed: ({ subject }) => subject === "11111111-1111-1111-1111-111111111111",
    testClientId: configured,
    fetchImpl: (async (url: string) =>
      Response.json(url.endsWith("/certs") ? { keys: [jwk] } : identity)) as typeof fetch,
  });
}

const request = (jwt: string) =>
  new Request("https://chat.example/me", { headers: { cookie: `CF_Authorization=${jwt}` } });

void test("the configured service token maps to one separate test subject", async () => {
  const identity = await verifier(
    {
      service_token_status: true,
      service_token_id: "3537a672-e4d8-4d89-aab9-26cb622918a1",
      common_name: testClientId,
    },
    testClientId,
  )(request(token({ sub: "", common_name: testClientId })));
  assert.equal(identity.subject, `service-token:${testClientId}`);
  assert.doesNotThrow(identity.assertCurrent);
});

void test("accepts a service assertion without a browser cookie and revalidates it", async () => {
  const jwt = token({ sub: "", common_name: testClientId });
  let active = true;
  const verify = createCloudflareAccessVerifier({
    issuer,
    audience,
    isAllowed: () => false,
    testClientId,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/certs")) {
        return Response.json({ keys: [jwk] });
      }
      assert.equal(url, `${issuer}/cdn-cgi/access/get-identity`);
      assert.equal(new Headers(init?.headers).get("cookie"), `CF_Authorization=${jwt}`);
      return Response.json({
        service_token_status: active,
        service_token_id: testClientId,
      });
    }) as typeof fetch,
  });
  const identity = await verify(
    new Request("https://chat.example/me", { headers: { "cf-access-jwt-assertion": jwt } }),
  );
  assert.equal(identity.subject, `service-token:${testClientId}`);
  const withCookie = await verify(
    new Request("https://chat.example/me", {
      headers: { cookie: "CF_Authorization=stale", "cf-access-jwt-assertion": jwt },
    }),
  );
  assert.equal(withCookie.subject, identity.subject);
  active = false;
  await assert.rejects(identity.revalidate(), { status: 401 });
});

void test("continues to accept a human identity from a browser cookie", async () => {
  const subject = "11111111-1111-1111-1111-111111111111";
  const identity = await verifier(
    { user_uuid: subject },
    undefined,
  )(request(token({ sub: subject })));
  assert.equal(identity.subject, subject);
});

void test("does not fall back to a cookie when an assertion is invalid", async () => {
  const jwt = token({ sub: "", common_name: testClientId });
  await assert.rejects(
    verifier(
      { service_token_status: true, service_token_id: testClientId },
      testClientId,
    )(
      new Request("https://chat.example/me", {
        headers: { cookie: `CF_Authorization=${jwt}`, "cf-access-jwt-assertion": "invalid" },
      }),
    ),
    { status: 401 },
  );
});

void test("other service tokens and unconfirmed service identities are denied", async () => {
  const otherClient = `${"c".repeat(32)}.access`;
  const confirmed = { service_token_status: true, service_token_id: testClientId };
  await assert.rejects(
    verifier(confirmed, testClientId)(request(token({ sub: "", common_name: otherClient }))),
    { status: 401 },
  );
  await assert.rejects(
    verifier(
      { service_token_status: true, service_token_id: otherClient },
      testClientId,
    )(request(token({ sub: "", common_name: testClientId }))),
    { status: 401 },
  );
  await assert.rejects(
    verifier(confirmed, undefined)(request(token({ sub: "", common_name: testClientId }))),
    { status: 401 },
  );
});
