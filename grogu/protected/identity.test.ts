import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createCloudflareAccessVerifier, protectedAccessProofPath } from "./identity.js";

const issuer = "https://team.cloudflareaccess.com";
const origin = "https://chat.example";
const audience = "a".repeat(64);
const human = "11111111-1111-1111-1111-111111111111";
const testClientId = `${"b".repeat(32)}.access`;
const secret = "s".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
let issued = 0;

function token(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: String(issued++),
    ...claims,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

const serviceToken = () => token({ sub: "", common_name: testClientId });

type Edge = (proof: Request, answer: (request: Request) => Promise<Response>) => Promise<Response>;

/** Stands in for the Access edge: a valid credential reaches the origin with a new assertion. */
const forwardValid =
  (current: { secret: string }): Edge =>
  (proof, answer) =>
    proof.headers.get("cf-access-client-id") === testClientId &&
    proof.headers.get("cf-access-client-secret") === current.secret
      ? answer(new Request(proof.url, { headers: { "cf-access-jwt-assertion": serviceToken() } }))
      : Promise.resolve(new Response("Forbidden", { status: 403 }));

function verifier(configured: string | undefined, edge: Edge = forwardValid({ secret })) {
  const proofs: Headers[] = [];
  const verify = createCloudflareAccessVerifier({
    issuer,
    audience,
    origin,
    isAllowed: ({ subject }) => subject === human,
    testClientId: configured,
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${issuer}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      if (url === `${issuer}/cdn-cgi/access/get-identity`) {
        return Response.json({ user_uuid: human });
      }
      assert.equal(new URL(url).origin + new URL(url).pathname, origin + protectedAccessProofPath);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      proofs.push(headers);
      return edge(new Request(url, { headers }), verify.answerProof);
    }) as typeof fetch,
  });
  return Object.assign(verify, { proofs });
}

const serviceRequest = (
  jwt: string | undefined,
  credential: { id?: string; secret?: string } = { id: testClientId, secret },
) =>
  new Request(`${origin}/me`, {
    headers: {
      cookie: "CF_Authorization=stale",
      ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
      ...(credential.id ? { "x-grogu-test-client-id": credential.id } : {}),
      ...(credential.secret ? { "x-grogu-test-client-secret": credential.secret } : {}),
    },
  });

void test("the test client proves its credential through a fresh Access request", async () => {
  const current = { secret };
  const verify = verifier(testClientId, forwardValid(current));
  const first = await verify(serviceRequest(serviceToken()));
  assert.equal(first.subject, `service-token:${testClientId}`);
  const [proof] = verify.proofs;
  assert.equal(proof?.get("cookie"), null);
  assert.equal(proof?.get("cf-access-jwt-assertion"), null);
  assert.equal(proof?.get("cf-access-client-secret"), secret);

  // Each request carries a new assertion, but the run and logout session stays stable.
  const second = await verify(
    serviceRequest(
      token({ sub: "", common_name: testClientId, exp: Math.floor(Date.now() / 1000) + 5 }),
    ),
  );
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.expiresAt, first.expiresAt);
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    assert.throws(() => second.assertCurrent(), { status: 401 });
  } finally {
    Date.now = realNow;
  }
  assert.doesNotMatch(first.sessionId, new RegExp(secret));

  current.secret = "r".repeat(64);
  await assert.rejects(first.revalidate(), { status: 401 });
  const rotated = await verify(
    serviceRequest(serviceToken(), { id: testClientId, secret: current.secret }),
  );
  assert.notEqual(rotated.sessionId, first.sessionId);
});

void test("the test client is denied without every proof requirement", async () => {
  const stale = () =>
    Response.json({ challenge: "x".repeat(43) }, { headers: { "cache-control": "no-store" } });
  const echo = (proof: Request, cache: string) =>
    Response.json(
      { challenge: new URL(proof.url).searchParams.get("challenge") },
      { headers: { "cache-control": cache } },
    );
  const forwardAs =
    (jwt: string | undefined): Edge =>
    (proof, answer) =>
      answer(new Request(proof.url, jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {}));
  const cases: Array<[string, Request, Edge?]> = [
    ["credential copies without an assertion", serviceRequest(undefined)],
    ["missing credential copies", serviceRequest(serviceToken(), {})],
    ["missing secret copy", serviceRequest(serviceToken(), { id: testClientId })],
    ["another client copy", serviceRequest(serviceToken(), { id: "other.access", secret })],
    ["a bad secret", serviceRequest(serviceToken(), { id: testClientId, secret: "bad" })],
    ["a redirect", serviceRequest(serviceToken()), async () => Response.redirect(origin, 302)],
    ["a cached reply", serviceRequest(serviceToken()), async () => stale()],
    [
      "a cacheable echo",
      serviceRequest(serviceToken()),
      async (proof) => echo(proof, "max-age=60"),
    ],
    ["a proof without an assertion", serviceRequest(serviceToken()), forwardAs(undefined)],
    ["a human proof assertion", serviceRequest(serviceToken()), forwardAs(token({ sub: human }))],
    [
      "another client's proof assertion",
      serviceRequest(serviceToken()),
      forwardAs(token({ sub: "", common_name: "other.access" })),
    ],
  ];
  for (const [name, request, edge] of cases) {
    await assert.rejects(verifier(testClientId, edge)(request), { status: 401 }, name);
  }
  const echoes = verifier(testClientId, async (proof) => echo(proof, "no-store"));
  await echoes(serviceRequest(serviceToken()));
  await assert.rejects(
    echoes.answerProof(new Request(`${origin}${protectedAccessProofPath}?challenge=short`)),
    { status: 401 },
  );
});

void test("human identities keep cookie and identity-lookup behavior", async () => {
  const verify = verifier(testClientId);
  const jwt = token({ sub: human });
  const identity = await verify(
    new Request(`${origin}/me`, { headers: { cookie: `CF_Authorization=${jwt}` } }),
  );
  assert.equal(identity.subject, human);
  const next = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human })}` },
    }),
  );
  assert.notEqual(next.sessionId, identity.sessionId);
  assert.equal(verify.proofs.length, 0);
});

void test("accepts only the exact configured single-string audience", async () => {
  const verify = verifier(testClientId);
  const claims = { sub: "", common_name: testClientId };
  const identity = await verify(serviceRequest(token({ ...claims, aud: audience })));
  assert.equal(identity.subject, `service-token:${testClientId}`);
  await assert.rejects(verify(serviceRequest(token({ ...claims, aud: `${audience}x` }))), {
    status: 401,
  });
  await assert.rejects(verify(serviceRequest(token({ ...claims, aud: [`${audience}x`] }))), {
    status: 401,
  });
});

void test("does not fall back to a cookie when an assertion is invalid", async () => {
  await assert.rejects(
    verifier(testClientId)(
      new Request(`${origin}/me`, {
        headers: {
          cookie: `CF_Authorization=${serviceToken()}`,
          "cf-access-jwt-assertion": "invalid",
          "x-grogu-test-client-id": testClientId,
          "x-grogu-test-client-secret": secret,
        },
      }),
    ),
    { status: 401 },
  );
});

void test("other service tokens and unconfigured test clients are denied", async () => {
  await assert.rejects(
    verifier(testClientId)(serviceRequest(token({ sub: "", common_name: "other.access" }))),
    { status: 401 },
  );
  const unconfigured = verifier(undefined);
  await assert.rejects(unconfigured(serviceRequest(serviceToken())), { status: 401 });
  await assert.rejects(
    unconfigured.answerProof(
      new Request(`${origin}${protectedAccessProofPath}?challenge=${"x".repeat(43)}`, {
        headers: { "cf-access-jwt-assertion": serviceToken() },
      }),
    ),
    { status: 401 },
  );
});
