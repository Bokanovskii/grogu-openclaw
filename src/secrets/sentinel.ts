import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const SECRET_SENTINEL_PREFIX = "oc-sent-v2.";
export const SECRET_SENTINEL_SUFFIX = ".end";
const SECRET_SENTINEL_SOURCE = "oc-sent-v2\\.[A-Za-z0-9_-]+\\.end";
const SECRET_SENTINEL_CIPHER = "aes-256-gcm";
const SECRET_SENTINEL_NONCE_BYTES = 12;
const SECRET_SENTINEL_SCOPE_BYTES = 8;
const SECRET_SENTINEL_TAG_BYTES = 16;
const SECRET_SENTINEL_HEADER_BYTES =
  SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES + SECRET_SENTINEL_TAG_BYTES;
const REQUEST_SENTINEL_SCOPE = Buffer.alloc(SECRET_SENTINEL_SCOPE_BYTES);
// Shared-store secrets are capped at 64 KiB. The egress proxy uses this bound
// to keep only one maximum sentinel in memory while scanning streamed bodies.
export const SECRET_SENTINEL_MAX_LENGTH =
  SECRET_SENTINEL_PREFIX.length +
  Math.ceil(((SECRET_SENTINEL_HEADER_BYTES + 64 * 1024) * 4) / 3) +
  SECRET_SENTINEL_SUFFIX.length;

export const SECRET_SENTINEL_PATTERN = new RegExp(SECRET_SENTINEL_SOURCE, "g");

type SecretSentinelKeyState = { keys: Buffer };
const SECRET_SENTINEL_KEY_STATE = Symbol.for("openclaw.secretSentinel.keys");
// Bundled runtime chunks can instantiate this module independently. A process-global
// key keeps their sentinels interoperable without retaining a plaintext registry.
const secretSentinelKeys = resolveGlobalSingleton<SecretSentinelKeyState>(
  SECRET_SENTINEL_KEY_STATE,
  () => ({ keys: randomBytes(64) }),
).keys;
const secretSentinelCipherKey = secretSentinelKeys.subarray(0, 32);
const secretSentinelNonceKey = secretSentinelKeys.subarray(32);
const activeRequestSentinels = resolveGlobalSingleton(
  Symbol.for("openclaw.secretSentinel.activeRequests"),
  () => new Set<string>(),
);

function secretSentinelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.OPENCLAW_SECRET_SENTINELS?.trim().toLowerCase();
  return configured !== "off" && configured !== "0" && configured !== "false";
}

export function looksLikeSecretSentinel(value: string): boolean {
  return new RegExp(`^${SECRET_SENTINEL_SOURCE}$`).test(value);
}

export function containsSecretSentinel(value: string): boolean {
  return value.includes(SECRET_SENTINEL_PREFIX);
}

function secretSentinelScope(label: string): Buffer {
  const scope = createHash("sha256")
    .update(label)
    .digest()
    .subarray(0, SECRET_SENTINEL_SCOPE_BYTES);
  if (scope.equals(REQUEST_SENTINEL_SCOPE)) {
    scope[0] = 1;
  }
  return scope;
}

/** Masks provider auth unless its compatibility switch explicitly requests plaintext. */
export function mintSecretSentinel(value: string, meta: { label: string }): string {
  if (!secretSentinelsEnabled()) {
    registerSecretValueForRedaction(value);
    return value;
  }
  return sealSecretSentinel(value, meta);
}

/** Always seals protected egress values, independently of provider compatibility settings. */
export function sealSecretSentinel(value: string, meta: { label: string }): string {
  registerSecretValueForRedaction(value);
  return sealWithScope(value, secretSentinelScope(meta.label));
}

/** Seals a value for one request and revokes its sentinel on close. */
export function createRequestSecretSentinel(value: string): {
  sentinel: string;
  close: () => void;
} {
  const sentinel = sealWithScope(
    value,
    REQUEST_SENTINEL_SCOPE,
    randomBytes(SECRET_SENTINEL_NONCE_BYTES),
  );
  activeRequestSentinels.add(sentinel);
  let active: string | undefined = sentinel;
  return {
    sentinel,
    close() {
      if (active !== undefined) {
        activeRequestSentinels.delete(active);
        active = undefined;
      }
    },
  };
}

function sealWithScope(value: string, scope: Buffer, requestNonce?: Buffer): string {
  // A keyed nonce preserves the old stable-by-value-and-label behavior without
  // retaining a reverse plaintext map. Different plaintexts collide only at
  // the 96-bit HMAC truncation boundary.
  const nonce =
    requestNonce ??
    createHmac("sha256", secretSentinelNonceKey)
      .update(scope)
      .update(value)
      .digest()
      .subarray(0, SECRET_SENTINEL_NONCE_BYTES);
  const cipher = createCipheriv(SECRET_SENTINEL_CIPHER, secretSentinelCipherKey, nonce);
  cipher.setAAD(scope);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([scope, nonce, cipher.getAuthTag(), ciphertext]);
  return `${SECRET_SENTINEL_PREFIX}${sealed.toString("base64url")}${SECRET_SENTINEL_SUFFIX}`;
}

/** Opens a process-local sentinel and rejects malformed or tampered values. */
export function resolveSecretSentinel(
  sentinel: string,
  cipherKey: Uint8Array = secretSentinelCipherKey,
): string | undefined {
  if (!looksLikeSecretSentinel(sentinel)) {
    return undefined;
  }
  try {
    const encoded = sentinel.slice(SECRET_SENTINEL_PREFIX.length, -SECRET_SENTINEL_SUFFIX.length);
    const sealed = Buffer.from(encoded, "base64url");
    if (sealed.length < SECRET_SENTINEL_HEADER_BYTES) {
      return undefined;
    }
    const scope = sealed.subarray(0, SECRET_SENTINEL_SCOPE_BYTES);
    if (scope.equals(REQUEST_SENTINEL_SCOPE) && !activeRequestSentinels.has(sentinel)) {
      return undefined;
    }
    const nonce = sealed.subarray(
      SECRET_SENTINEL_SCOPE_BYTES,
      SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES,
    );
    const tagStart = SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES;
    const tag = sealed.subarray(tagStart, tagStart + SECRET_SENTINEL_TAG_BYTES);
    const ciphertext = sealed.subarray(SECRET_SENTINEL_HEADER_BYTES);
    const decipher = createDecipheriv(SECRET_SENTINEL_CIPHER, cipherKey, nonce);
    decipher.setAAD(scope);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!scope.equals(REQUEST_SENTINEL_SCOPE)) {
      registerSecretValueForRedaction(value);
    }
    return value;
  } catch {
    return undefined;
  }
}

/** Bootstrap the trusted egress Worker without resolving or copying plaintext values. */
export function copySecretSentinelDecryptionKey(): Uint8Array {
  return Uint8Array.from(secretSentinelCipherKey);
}

/** Swaps every known sentinel substring and reports unknown sentinel-shaped values. */
export function swapSecretSentinelsInText(text: string): { text: string; unknown: string[] } {
  if (!containsSecretSentinel(text)) {
    return { text, unknown: [] };
  }
  const unknown = new Set<string>();
  const swapped = text.replace(new RegExp(SECRET_SENTINEL_SOURCE, "g"), (sentinel) => {
    const value = resolveSecretSentinel(sentinel);
    if (value === undefined) {
      unknown.add(sentinel);
      return sentinel;
    }
    return value;
  });
  return { text: swapped, unknown: [...unknown] };
}
