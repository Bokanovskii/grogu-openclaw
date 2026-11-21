import { afterEach, describe, expect, it } from "vitest";
import {
  redactRegisteredSecretValues,
  registerSecretValueForRedaction,
} from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { resolveSecretSentinel } from "../secrets/sentinel.js";
import { swapSecretSentinelsForEgress } from "./provider-transport-secret-egress.js";
import {
  createRequestModelCredential,
  resolveRequestModelCredential,
} from "./request-model-credential.js";

const secret = 'request-only/"quoted"\ncredential';
const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
const redact = (value: string) => redactRegisteredSecretValues(value, () => "[redacted]");
const create = () =>
  createRequestModelCredential({
    provider: "openai",
    model: "test-model",
    accessToken: secret,
    assertCurrent: () => {},
  });

describe("request model credential redaction", () => {
  afterEach(resetSecretRedactionRegistryForTest);

  it("protects every form through egress and releases it after the last request closes", () => {
    const first = create();
    const second = create();
    const sentinel = resolveRequestModelCredential(first.handle, "openai", "test-model").apiKey;
    if (!sentinel) {
      throw new Error("Missing request credential sentinel");
    }
    for (const form of forms) {
      expect(redact(form)).toBe("[redacted]");
    }
    const swapped = swapSecretSentinelsForEgress({ url: `https://example.test/?key=${sentinel}` });
    expect(swapped.url).toBe(`https://example.test/?key=${encodeURIComponent(secret)}`);
    first.close();
    first.close();
    expect(resolveSecretSentinel(sentinel)).toBeUndefined();
    const secondSentinel = resolveRequestModelCredential(
      second.handle,
      "openai",
      "test-model",
    ).apiKey;
    if (!secondSentinel) {
      throw new Error("Missing request credential sentinel");
    }
    expect(resolveSecretSentinel(secondSentinel)).toBe(secret);
    for (const form of forms) {
      expect(redact(form)).toBe("[redacted]");
    }
    second.close();
    for (const form of forms) {
      expect(redact(form)).toBe(form);
    }
    expect(resolveSecretSentinel(secondSentinel)).toBeUndefined();
    expect(() =>
      swapSecretSentinelsForEgress({ url: `https://example.test/?key=${sentinel}` }),
    ).toThrow();
    for (const form of forms) {
      expect(redact(form)).toBe(form);
    }
    expect(() => resolveRequestModelCredential(second.handle, "openai", "test-model")).toThrow();
    const later = create();
    expect(resolveSecretSentinel(sentinel)).toBeUndefined();
    later.close();
  });

  it("protects the token before model authentication resolves", () => {
    const request = create();
    for (const form of forms) {
      expect(redact(form)).toBe("[redacted]");
    }
    request.close();
  });

  it("keeps active request forms protected during registry eviction", () => {
    const request = create();
    resolveRequestModelCredential(request.handle, "openai", "test-model");
    for (let index = 0; index < 520; index++) {
      registerSecretValueForRedaction(`unrelated-fixture-${index}`);
    }
    for (const form of forms) {
      expect(redact(form)).toBe("[redacted]");
    }
    request.close();
  });

  it("protects short request credentials alongside longer overlapping values", () => {
    registerSecretValueForRedaction("abc-longer-secret");
    const request = createRequestModelCredential({
      provider: "openai",
      model: "test-model",
      accessToken: "abc",
      assertCurrent: () => {},
    });
    expect(redact("abc-longer-secret abc-other")).toBe("[redacted] [redacted]-other");
    request.close();
    expect(redact("abc-other")).toBe("abc-other");
  });

  it("does not keep a sentinel valid for another token's encoded form", () => {
    const make = (accessToken: string) =>
      createRequestModelCredential({
        provider: "openai",
        model: "test-model",
        accessToken,
        assertCurrent: () => {},
      });
    const first = make("value%2Fsecret");
    const second = make("value/secret");
    const sentinel = resolveRequestModelCredential(first.handle, "openai", "test-model").apiKey;
    if (!sentinel) {
      throw new Error("Missing request credential sentinel");
    }
    first.close();
    expect(resolveSecretSentinel(sentinel)).toBeUndefined();
    expect(redact("value%2Fsecret")).toBe("[redacted]");
    second.close();
  });

  it("preserves an independent registration when the request closes", () => {
    const request = create();
    registerSecretValueForRedaction(secret);
    const sentinel = resolveRequestModelCredential(request.handle, "openai", "test-model").apiKey;
    if (!sentinel) {
      throw new Error("Missing request credential sentinel");
    }
    request.close();
    expect(resolveSecretSentinel(sentinel)).toBeUndefined();
    for (const form of forms) {
      expect(redact(form)).toBe("[redacted]");
    }
  });
});
