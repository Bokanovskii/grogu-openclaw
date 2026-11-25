import { createHash, createPublicKey, randomBytes, verify, type webcrypto } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import { ProtectedError } from "./errors.js";

type JsonWebKey = webcrypto.JsonWebKey;

export type VerifiedProtectedIdentity = {
  issuer: string;
  subject: string;
  kind: "human" | "development";
  displayName?: string;
  email?: string;
  /** Expiry of the stored session record; assertCurrent enforces the assertion's own expiry. */
  expiresAt: number;
  sessionId: string;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};

export type ProtectedIdentityVerifier = (request: Request) => Promise<VerifiedProtectedIdentity>;

/** Answers the test client's fresh Access proof. Only Access can supply its assertion. */
export const protectedAccessProofPath = "/api/protected/v1/access-proof";
const testClientIdHeader = "x-grogu-test-client-id";
const testClientSecretHeader = "x-grogu-test-client-secret";
const remoteRevalidationWindowMs = 5 * 60_000;
const keyLifetimeMs = 5 * 60_000;

function denied(): never {
  throw new ProtectedError(401, "unauthorized", "Sign in again to continue.");
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return denied();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        return denied();
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const protectedTestClientSubject = (clientId: string) => `service-token:${clientId}`;

/**
 * Uses only the pinned Access issuer, never a URL supplied by a token. An Access service token
 * has an empty `sub`; only the one configured test client maps to a fixed, separate test subject.
 *
 * Strict Access sends service tokens no cookie, `get-identity` refuses their assertions, and the
 * edge strips the standard credential headers. The test client therefore also sends namespaced
 * copies. They never establish identity: after a valid assertion names the configured client,
 * revalidation presents them to Access in a new request to the pinned origin, whose proof route
 * must receive a newly issued assertion for that client and echo a random challenge.
 */
export function createCloudflareAccessVerifier(options: {
  issuer: string;
  audience: string;
  isAllowed: (identity: { issuer: string; subject: string }) => boolean;
  bindVerifiedIdentity?: (
    identity: { issuer: string; subject: string; email: string },
    assertCurrent: () => void,
  ) => Promise<boolean>;
  testClientId?: string;
  origin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ProtectedIdentityVerifier & {
  answerProof: (request: Request) => Promise<Response>;
  invalidateSubject: (subject: string) => void;
  startKeyRefresh: () => () => void;
} {
  const issuer = new URL(options.issuer);
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".cloudflareaccess.com") ||
    issuer.origin !== options.issuer ||
    !options.audience
  ) {
    throw new TypeError("Configure an exact Cloudflare Access issuer origin and audience.");
  }
  const proofUrl = options.testClientId
    ? new URL(protectedAccessProofPath, options.origin)
    : undefined;
  if (proofUrl && (proofUrl.protocol !== "https:" || proofUrl.origin !== options.origin)) {
    throw new TypeError("Configure the exact protected origin for the test client.");
  }
  const boundEmails = new Map<string, string>();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  let keys: Array<JsonWebKey & { kid: string }> = [];
  let keysUntil = 0;
  let pendingKeys: Promise<void> | undefined;
  const refreshKeys = async () => {
    pendingKeys ??= (async () => {
      const payload = await boundedJson(
        await fetchImpl(`${issuer.origin}/cdn-cgi/access/certs`, {
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        }),
        128 * 1024,
      );
      if (!isRecord(payload) || !Array.isArray(payload.keys)) {
        denied();
      }
      keys = payload.keys.filter(
        (key): key is JsonWebKey & { kid: string } =>
          isRecord(key) &&
          key.kty === "RSA" &&
          typeof key.kid === "string" &&
          typeof key.n === "string" &&
          typeof key.e === "string" &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === "RS256"),
      );
      keysUntil = now() + keyLifetimeMs;
    })().finally(() => {
      pendingKeys = undefined;
    });
    await pendingKeys;
  };
  const verifyToken = async (token: string) => {
    if (token.length > 16 * 1024 || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) {
      return denied();
    }
    const [encodedHeader, encodedPayload, signature] = token.split(".") as [string, string, string];
    const header: unknown = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const claims: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (
      !isRecord(header) ||
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !isRecord(claims) ||
      claims.iss !== issuer.origin ||
      typeof claims.sub !== "string" ||
      (!claims.sub.trim() &&
        (!options.testClientId || claims.common_name !== options.testClientId)) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      !(
        claims.aud === options.audience ||
        (Array.isArray(claims.aud) && claims.aud.includes(options.audience))
      ) ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > now()))
    ) {
      return denied();
    }
    let key = keys.find((candidate) => candidate.kid === header.kid);
    if (!key || now() >= keysUntil) {
      await refreshKeys();
      key = keys.find((candidate) => candidate.kid === header.kid);
    }
    if (
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      )
    ) {
      return denied();
    }
    // Checked after the awaited key load so a slow fetch cannot admit an assertion that expired meanwhile.
    if (now() >= claims.exp * 1000) {
      return denied();
    }
    return {
      testClient: claims.sub.trim() ? undefined : options.testClientId,
      subject: claims.sub,
      expiresAt: claims.exp * 1000,
    };
  };
  const verifier: ProtectedIdentityVerifier = async (request) => {
    try {
      let token = request.headers.get("cf-access-jwt-assertion");
      if (token === null) {
        const cookie = request.headers.get("cookie") ?? "";
        const matches = cookie
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part.startsWith("CF_Authorization="));
        if (matches.length !== 1) {
          return denied();
        }
        token = matches[0]!.slice("CF_Authorization=".length);
      }
      const verified = await verifyToken(token);
      const { testClient, expiresAt } = verified;
      const subject = testClient ? protectedTestClientSubject(testClient) : verified.subject;
      const clientSecret = request.headers.get(testClientSecretHeader);
      if (
        testClient &&
        (request.headers.get(testClientIdHeader) !== testClient ||
          !clientSecret ||
          clientSecret.length > 1024 ||
          !/^[\x21-\x7e]+$/u.test(clientSecret))
      ) {
        return denied();
      }
      const assertTokenCurrent = () => {
        if (now() >= expiresAt) {
          denied();
        }
      };
      const assertCurrent = () => {
        assertTokenCurrent();
        if (!testClient && !options.isAllowed({ issuer: issuer.origin, subject })) {
          denied();
        }
      };
      const proveTestClient = async (client: string, secret: string) => {
        assertCurrent();
        const challenge = randomBytes(32).toString("base64url");
        const url = new URL(proofUrl!);
        url.searchParams.set("challenge", challenge);
        // A fresh request with only the copied credentials, never the old assertion or a cookie.
        const response = await fetchImpl(url, {
          headers: {
            "Cache-Control": "no-store",
            "CF-Access-Client-Id": client,
            "CF-Access-Client-Secret": secret,
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        const proof = await boundedJson(response, 1024);
        assertCurrent();
        if (
          response.status !== 200 ||
          !/(?:^|,)\s*no-store\s*(?:,|$)/u.test(response.headers.get("cache-control") ?? "") ||
          !isRecord(proof) ||
          proof.challenge !== challenge
        ) {
          denied();
        }
      };
      let lastRemoteRevalidationAt: number | undefined;
      let lastRemoteRevalidationEmail: string | undefined;
      const revalidate = async () => {
        const remoteAge =
          lastRemoteRevalidationAt === undefined ? undefined : now() - lastRemoteRevalidationAt;
        const bindingInvalidated =
          options.bindVerifiedIdentity !== undefined &&
          lastRemoteRevalidationEmail !== undefined &&
          boundEmails.get(subject) !== lastRemoteRevalidationEmail;
        if (
          remoteAge !== undefined &&
          remoteAge >= 0 &&
          remoteAge < remoteRevalidationWindowMs &&
          !bindingInvalidated
        ) {
          // Cloudflare revocation may lag up to five minutes; local checks still run on every call.
          assertCurrent();
          return;
        }
        let remoteEmail: string | undefined;
        if (testClient) {
          await proveTestClient(testClient, clientSecret!);
          lastRemoteRevalidationAt = now();
          lastRemoteRevalidationEmail = remoteEmail;
          return;
        }
        assertTokenCurrent();
        const identity = await boundedJson(
          await fetchImpl(`${issuer.origin}/cdn-cgi/access/get-identity`, {
            headers: { Cookie: `CF_Authorization=${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          }),
          64 * 1024,
        );
        assertTokenCurrent();
        if (!isRecord(identity) || (identity.user_uuid !== subject && identity.sub !== subject)) {
          denied();
        }
        const email =
          typeof identity.email === "string"
            ? identity.email
            : typeof identity.email_address === "string"
              ? identity.email_address
              : undefined;
        if (!testClient && email && options.bindVerifiedIdentity) {
          remoteEmail = email;
          const allowed = options.isAllowed({ issuer: issuer.origin, subject });
          if (!allowed) {
            boundEmails.delete(subject);
          }
          if (!allowed || boundEmails.get(subject) !== email) {
            const bound = await options.bindVerifiedIdentity(
              { issuer: issuer.origin, subject, email },
              assertTokenCurrent,
            );
            if (!bound) {
              denied();
            }
            boundEmails.set(subject, email);
          }
        }
        assertCurrent();
        lastRemoteRevalidationAt = now();
        lastRemoteRevalidationEmail = remoteEmail;
      };
      await revalidate();
      return {
        issuer: issuer.origin,
        subject,
        kind: testClient ? "development" : "human",
        // A test client session follows its credential generation, not each short-lived assertion.
        // Its record never expires, so logout lasts until the credential rotates.
        expiresAt: testClient ? Number.MAX_SAFE_INTEGER : expiresAt,
        sessionId: testClient
          ? createHash("sha256")
              .update("grogu-protected-test-client\0")
              .update(testClient)
              .update("\0")
              .update(clientSecret!)
              .digest("hex")
          : createHash("sha256").update(token).digest("hex"),
        assertCurrent,
        revalidate,
      };
    } catch {
      // Fetch errors can retain the token. Never propagate their cause or message.
      return denied();
    }
  };
  // Verifies the new assertion locally only; remote revalidation here would recurse.
  const answerProof = async (request: Request) => {
    try {
      const challenge = new URL(request.url).searchParams.get("challenge");
      const token = request.headers.get("cf-access-jwt-assertion");
      if (
        !proofUrl ||
        request.method !== "GET" ||
        !challenge ||
        !/^[\w-]{43}$/u.test(challenge) ||
        token === null ||
        !(await verifyToken(token)).testClient
      ) {
        return denied();
      }
      return Response.json({ challenge }, { headers: { "cache-control": "no-store" } });
    } catch {
      return denied();
    }
  };
  return Object.assign(verifier, {
    answerProof,
    startKeyRefresh() {
      const timer = setInterval(() => {
        if (keysUntil) {
          void refreshKeys().catch(() => {
            // Never include network details. Expired keys cannot authorize the next request.
            process.stderr.write("Protected Access key refresh failed.\n");
          });
        }
      }, keyLifetimeMs - 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
    invalidateSubject: (subject: string) => {
      boundEmails.delete(subject);
    },
  });
}

export async function resolveProtectedProfile(
  identity: VerifiedProtectedIdentity,
  options: { env: NodeJS.ProcessEnv; assertCurrent: () => void },
) {
  identity.assertCurrent();
  const profile = await ensureCanonicalUserProfileForVerifiedIdentity(
    {
      issuer: identity.issuer,
      subject: identity.subject,
      displayName: identity.displayName,
    },
    options,
  );
  options.assertCurrent();
  return profile;
}
