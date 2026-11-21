import { describe, expect, it } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { looksLikeSecretSentinel, mintSecretSentinel } from "../secrets/sentinel.js";
import {
  applyPreparedRuntimeAuthToModel,
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import { unwrapModelHeaderSentinelsForProviderEgress } from "./provider-secret-egress.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

describe("protectPreparedProviderRuntimeAuth", () => {
  it("keeps public provider identity out of transcript redaction while protecting headers", () => {
    const headerSecret = "runtime-custom-header-secret";
    const result = protectPreparedProviderRuntimeAuth({
      provider: "github-copilot",
      preparedAuth: {
        apiKey: "runtime-copilot-token",
        publicHeaders: { "Openai-Organization": "github-copilot" },
        request: {
          headers: { "x-custom-auth": headerSecret },
          auth: { mode: "header", headerName: "x-auth", value: "runtime-auth-header-secret" },
        },
      },
    });

    expect(isSecretValueRegisteredForRedaction("github-copilot")).toBe(false);
    const saved = redactTranscriptMessage(
      castAgentMessage({ role: "assistant", content: [], provider: "github-copilot" }),
      {},
    );
    expect(saved).toHaveProperty("provider", "github-copilot");
    expect(result?.request?.headers?.["Openai-Organization"]).toBe("github-copilot");
    expect(looksLikeSecretSentinel(result?.request?.headers?.["x-custom-auth"] ?? "")).toBe(true);
    expect(isSecretValueRegisteredForRedaction(headerSecret)).toBe(true);
    expect(looksLikeSecretSentinel(result?.apiKey ?? "")).toBe(true);
    const auth = result?.request?.auth;
    expect(auth?.mode === "header" && looksLikeSecretSentinel(auth.value)).toBe(true);
    expect(isSecretValueRegisteredForRedaction("runtime-auth-header-secret")).toBe(true);
    const inputModel: { provider: string; headers?: Record<string, string> } = {
      provider: "github-copilot",
    };
    const model = applyPreparedRuntimeAuthToModel(inputModel, result);
    expect(model.headers?.["Openai-Organization"]).toBe("github-copilot");
  });

  it("sentinels a real credential returned by the auth exchange and registers it for redaction", () => {
    const runtimeToken = "bedrock-api-key-egress-runtime-token";
    const result = protectPreparedProviderRuntimeAuth({
      provider: "amazon-bedrock-mantle",
      preparedAuth: {
        apiKey: runtimeToken,
        request: {
          auth: { mode: "authorization-bearer", token: runtimeToken },
        },
      },
    });

    expect(result?.apiKey).not.toBe(runtimeToken);
    expect(looksLikeSecretSentinel(result?.apiKey ?? "")).toBe(true);
    const auth = result?.request?.auth;
    const bearerToken = auth?.mode === "authorization-bearer" ? auth.token : "";
    expect(looksLikeSecretSentinel(bearerToken)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(runtimeToken)).toBe(true);
  });

  it("leaves non-secret auth markers untouched", () => {
    const result = protectPreparedProviderRuntimeAuth({
      provider: "ollama",
      preparedAuth: { apiKey: "ollama-local" },
    });

    expect(result?.apiKey).toBe("ollama-local");
    expect(isSecretValueRegisteredForRedaction("ollama-local")).toBe(false);
  });
});

describe("unwrapModelHeaderSentinelsForProviderEgress", () => {
  it("unwraps sentinels in visible headers and attached request transport overrides", () => {
    const headerSecret = "egress-visible-header-secret";
    const bearerSecret = "egress-runtime-bearer-secret";
    const overrideHeaderSecret = "egress-override-header-secret";
    const model = attachModelProviderRequestTransport(
      {
        id: "test-model",
        headers: {
          "x-api-key": mintSecretSentinel(headerSecret, { label: "egress-test:visible" }),
        },
      },
      {
        headers: {
          "x-extra": mintSecretSentinel(overrideHeaderSecret, { label: "egress-test:override" }),
        },
        auth: {
          mode: "authorization-bearer",
          token: mintSecretSentinel(bearerSecret, { label: "egress-test:bearer" }),
        },
      },
    );

    const unwrapped = unwrapModelHeaderSentinelsForProviderEgress(model, "egress test");

    expect(unwrapped.headers?.["x-api-key"]).toBe(headerSecret);
    const request = getModelProviderRequestTransport(unwrapped);
    expect(request?.headers?.["x-extra"]).toBe(overrideHeaderSecret);
    expect(request?.auth).toEqual({ mode: "authorization-bearer", token: bearerSecret });
    // Original model stays sentineled: unwrap must not mutate shared state.
    expect(model.headers["x-api-key"]).not.toBe(headerSecret);
    expect(getModelProviderRequestTransport(model)?.auth).not.toEqual(request?.auth);
  });

  it("unwraps header-mode auth values in attached request transport overrides", () => {
    const headerAuthSecret = "egress-header-auth-secret";
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: undefined },
      {
        auth: {
          mode: "header",
          headerName: "x-goog-api-key",
          value: mintSecretSentinel(headerAuthSecret, { label: "egress-test:header-auth" }),
        },
      },
    );

    const request = getModelProviderRequestTransport(
      unwrapModelHeaderSentinelsForProviderEgress(model, "egress test"),
    );

    expect(request?.auth).toEqual({
      mode: "header",
      headerName: "x-goog-api-key",
      value: headerAuthSecret,
    });
  });

  it("returns the same model instance when nothing is sentineled", () => {
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: { "x-plain": "plain-value" } },
      { auth: { mode: "provider-default" } },
    );

    expect(unwrapModelHeaderSentinelsForProviderEgress(model, "egress test")).toBe(model);
  });

  it("rejects unknown sentinel-shaped values in attached overrides", () => {
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: undefined },
      {
        auth: {
          mode: "authorization-bearer",
          token: "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
        },
      },
    );

    expect(() => unwrapModelHeaderSentinelsForProviderEgress(model, "egress test")).toThrow(
      /not registered in this process/,
    );
  });
});
