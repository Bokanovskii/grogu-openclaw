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

function verifier(
  configured: string | undefined,
  edge: Edge = forwardValid({ secret }),
  now: () => number = () => Date.now(),
) {
  const proofs: Headers[] = [];
  let identityFetches = 0;
  const verify = createCloudflareAccessVerifier({
    issuer,
    audience,
    origin,
    isAllowed: ({ subject }) => subject === human,
    testClientId: configured,
    now,
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${issuer}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      if (url === `${issuer}/cdn-cgi/access/get-identity`) {
        identityFetches++;
        return Response.json({ user_uuid: human });
      }
      assert.equal(new URL(url).origin + new URL(url).pathname, origin + protectedAccessProofPath);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      proofs.push(headers);
      return edge(new Request(url, { headers }), verify.answerProof);
    }) as typeof fetch,
  });
  return Object.assign(verify, { proofs, identityFetchCount: () => identityFetches });
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
  let now = Date.now();
  const current = { secret };
  const verify = verifier(testClientId, forwardValid(current), () => now);
  const first = await verify(serviceRequest(serviceToken()));
  assert.equal(first.subject, `service-token:${testClientId}`);
  assert.equal(first.kind, "development");
  await first.revalidate();
  assert.equal(verify.proofs.length, 1);
  const [proof] = verify.proofs;
  assert.equal(proof?.get("cookie"), null);
  assert.equal(proof?.get("cf-access-jwt-assertion"), null);
  assert.equal(proof?.get("cf-access-client-secret"), secret);

  // Each request carries a new assertion, but the run and logout session stays stable.
  const second = await verify(
    serviceRequest(token({ sub: "", common_name: testClientId, exp: Math.floor(now / 1000) + 5 })),
  );
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.expiresAt, first.expiresAt);
  now += 10_000;
  assert.throws(() => second.assertCurrent(), { status: 401 });
  assert.doesNotMatch(first.sessionId, new RegExp(secret));

  current.secret = "r".repeat(64);
  now += 5 * 60_000 - 10_000;
  const proofCount = verify.proofs.length;
  await assert.rejects(first.revalidate(), { status: 401 });
  assert.equal(verify.proofs.length, proofCount + 1);
  await assert.rejects(first.revalidate(), { status: 401 });
  assert.equal(verify.proofs.length, proofCount + 2);
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
  const expired = token({
    sub: "",
    common_name: testClientId,
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  await assert.rejects(
    echoes.answerProof(
      new Request(`${origin}${protectedAccessProofPath}?challenge=${"x".repeat(43)}`, {
        headers: { "cf-access-jwt-assertion": expired },
      }),
    ),
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
  assert.equal(identity.kind, "human");
  const next = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human })}` },
    }),
  );
  assert.notEqual(next.sessionId, identity.sessionId);
  assert.equal(verify.proofs.length, 0);
});

void test("human identities reuse successful remote revalidation for five minutes", async () => {
  let now = Date.now();
  const verify = verifier(testClientId, undefined, () => now);
  const identity = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human })}` },
    }),
  );
  assert.equal(verify.identityFetchCount(), 1);
  await identity.revalidate();
  assert.equal(verify.identityFetchCount(), 1);
  const anotherIdentity = await verify(
    new Request(`${origin}/me`, {
      headers: {
        cookie: `CF_Authorization=${token({ sub: human, exp: Math.floor(now / 1000) + 3600 })}`,
      },
    }),
  );
  assert.equal(verify.identityFetchCount(), 2);
  await identity.revalidate();
  await anotherIdentity.revalidate();
  assert.equal(verify.identityFetchCount(), 2);
  now += 5 * 60_000 - 1;
  await identity.revalidate();
  assert.equal(verify.identityFetchCount(), 2);
  now++;
  await identity.revalidate();
  assert.equal(verify.identityFetchCount(), 3);
});

void test("failed and thrown remote revalidations are never reused", async () => {
  let now = Date.now();
  let identityFetches = 0;
  let remoteFailure: "throw" | "wrong-identity" | undefined;
  const verify = createCloudflareAccessVerifier({
    issuer,
    audience,
    isAllowed: () => true,
    now: () => now,
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      if (url === `${issuer}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      identityFetches++;
      if (remoteFailure === "throw") {
        remoteFailure = undefined;
        throw new Error("synthetic Access outage");
      }
      if (remoteFailure === "wrong-identity") {
        remoteFailure = undefined;
        return Response.json({ user_uuid: "another-member" });
      }
      return Response.json({ user_uuid: human });
    }) as typeof fetch,
  });
  const identity = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human })}` },
    }),
  );
  now += 5 * 60_000;
  remoteFailure = "throw";
  await assert.rejects(identity.revalidate(), /synthetic Access outage/u);
  remoteFailure = "wrong-identity";
  await assert.rejects(identity.revalidate(), { status: 401 });
  await identity.revalidate();
  assert.equal(identityFetches, 4);
});

void test("token expiry and local membership revocation remain immediate in the cache window", async () => {
  let now = Date.now();
  const expiresAt = Math.floor(now / 1000) + 5;
  const verify = verifier(testClientId, undefined, () => now);
  const expiring = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human, exp: expiresAt })}` },
    }),
  );
  now += 5_000;
  await assert.rejects(expiring.revalidate(), { status: 401 });
  assert.equal(verify.identityFetchCount(), 1);

  let allowed = true;
  let identityFetches = 0;
  const locallyRevocable = createCloudflareAccessVerifier({
    issuer,
    audience,
    isAllowed: () => allowed,
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      if (url === `${issuer}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      identityFetches++;
      return Response.json({ user_uuid: human });
    }) as typeof fetch,
  });
  const admitted = await locallyRevocable(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: human })}` },
    }),
  );
  await admitted.revalidate();
  allowed = false;
  await assert.rejects(admitted.revalidate(), { status: 401 });
  assert.equal(identityFetches, 1);
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

void test("verified email binds new admission and is cached only while admission remains current", async () => {
  const subject = "11111111-1111-1111-1111-111111111111";
  const now = Date.now();
  let allowed = false;
  let approved = true;
  let bindings = 0;
  const verify = createCloudflareAccessVerifier({
    issuer,
    audience,
    isAllowed: () => allowed,
    now: () => now,
    bindVerifiedIdentity: async (_identity, assertCurrent) => {
      assertCurrent();
      bindings++;
      allowed = approved;
      return allowed;
    },
    fetchImpl: (async (url: string) =>
      Response.json(
        url.endsWith("/certs")
          ? { keys: [jwk] }
          : { user_uuid: subject, email: "member@example.invalid" },
      )) as typeof fetch,
  });
  const identity = await verify(
    new Request(`${origin}/me`, {
      headers: { cookie: `CF_Authorization=${token({ sub: subject })}` },
    }),
  );
  await identity.revalidate();
  await identity.revalidate();
  assert.equal(bindings, 1);
  verify.invalidateSubject(subject);
  await identity.revalidate();
  assert.equal(bindings, 2);
  approved = false;
  allowed = false;
  await assert.rejects(identity.revalidate(), { status: 401 });
  assert.equal(bindings, 2);
});
