import { createHash, createPublicKey, verify, type webcrypto } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ensureCanonicalUserProfileForVerifiedIdentity } from "../../src/state/user-profile-writes.js";
import { ProtectedError } from "./errors.js";

type JsonWebKey = webcrypto.JsonWebKey;

export type VerifiedProtectedIdentity = {
  issuer: string;
  subject: string;
  displayName?: string;
  expiresAt: number;
  sessionId: string;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};

export type ProtectedIdentityVerifier = (request: Request) => Promise<VerifiedProtectedIdentity>;

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

const testSubjectPrefix = "service-token:";

/**
 * Uses only the pinned Access issuer, never a URL supplied by a token. An Access service token
 * has an empty `sub`; only the one configured test client maps to a fixed, separate test subject.
 */
export function createCloudflareAccessVerifier(options: {
  issuer: string;
  audience: string;
  isAllowed: (identity: { issuer: string; subject: string }) => boolean;
  testClientId?: string;
  fetchImpl?: typeof fetch;
}): ProtectedIdentityVerifier {
  const issuer = new URL(options.issuer);
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".cloudflareaccess.com") ||
    issuer.origin !== options.issuer ||
    !options.audience
  ) {
    throw new TypeError("Configure an exact Cloudflare Access issuer origin and audience.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let keys: Array<JsonWebKey & { kid: string }> = [];
  let keysUntil = 0;
  let pendingKeys: Promise<void> | undefined;
  const loadKeys = async () => {
    if (Date.now() < keysUntil) {
      return;
    }
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
      keysUntil = Date.now() + 5 * 60_000;
    })().finally(() => {
      pendingKeys = undefined;
    });
    await pendingKeys;
  };
  return async (request) => {
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
      if (token.length > 16 * 1024 || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) {
        return denied();
      }
      const [encodedHeader, encodedPayload, signature] = token.split(".") as [
        string,
        string,
        string,
      ];
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
        !Array.isArray(claims.aud) ||
        !claims.aud.includes(options.audience) ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== "number" || claims.nbf * 1000 > Date.now()))
      ) {
        return denied();
      }
      await loadKeys();
      const key = keys.find((candidate) => candidate.kid === header.kid);
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
      const testClient = claims.sub.trim() ? undefined : options.testClientId;
      const subject = testClient ? `${testSubjectPrefix}${testClient}` : claims.sub;
      const expiresAt = claims.exp * 1000;
      const assertCurrent = () => {
        if (
          Date.now() >= expiresAt ||
          (!testClient && !options.isAllowed({ issuer: issuer.origin, subject }))
        ) {
          denied();
        }
      };
      const revalidate = async () => {
        assertCurrent();
        const identity = await boundedJson(
          await fetchImpl(`${issuer.origin}/cdn-cgi/access/get-identity`, {
            headers: { Cookie: `CF_Authorization=${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          }),
          64 * 1024,
        );
        assertCurrent();
        if (
          !isRecord(identity) ||
          (testClient
            ? identity.service_token_status !== true ||
              // Cloudflare does not document whether service_token_id is the client ID or the token UUID.
              (identity.service_token_id !== testClient && identity.common_name !== testClient)
            : identity.user_uuid !== subject && identity.sub !== subject)
        ) {
          denied();
        }
      };
      await revalidate();
      return {
        issuer: issuer.origin,
        subject,
        expiresAt,
        sessionId: createHash("sha256").update(token).digest("hex"),
        assertCurrent,
        revalidate,
      };
    } catch {
      // Fetch errors can retain the token. Never propagate their cause or message.
      return denied();
    }
  };
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
