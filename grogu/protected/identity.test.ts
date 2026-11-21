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
  assert.equal(identity.kind, "development");
  assert.doesNotThrow(identity.assertCurrent);
});

void test("a verified human is not classified as the development identity", async () => {
  const subject = "11111111-1111-1111-1111-111111111111";
  const identity = await verifier(
    { user_uuid: subject },
    testClientId,
  )(request(token({ sub: subject })));
  assert.equal(identity.kind, "human");
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
