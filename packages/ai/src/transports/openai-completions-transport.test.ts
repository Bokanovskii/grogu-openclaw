import { createServer } from "node:http";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import type { Context, Model } from "../types.js";
import { modelRequestBodyState, serializeModelRequestBody } from "./model-request-body.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsModel,
  neverYieldsStream,
} from "./openai-completions.test-support.js";
import { buildOpenAISdkRequestOptions } from "./openai-transport-params.js";
import { log } from "./openai-transport-shared.js";

async function captureTransportRequest(
  model: Model<"openai-completions">,
  tools: Context["tools"] = [],
  options: OpenAICompletionsOptions = {},
  mode: "direct" | "managed" = "managed",
  message = "hello",
) {
  const previousHost = getAiTransportHost();
  let captured: Request | undefined;
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (input, init) => {
      captured = new Request(input, init);
      return new Response(
        `data: ${JSON.stringify(makeCompletionsChunk({ content: "ok" }, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const streamFn =
      mode === "direct"
        ? streamSimpleOpenAICompletions
        : createOpenAICompletionsTransportStreamFn();
    const stream = streamFn(
      model,
      { messages: [{ role: "user", content: message, timestamp: 1 }], tools } as never,
      { apiKey: "test-key", ...options } as never,
    );
    if (stream instanceof Promise) {
      throw new Error("OpenAI Chat transport must return its event stream synchronously");
    }
    for await (const event of stream) {
      // Consume the request through transport finalization.
      void event;
    }
    if (!captured) {
      throw new Error("Expected the transport to issue a request");
    }
    return captured;
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("openai completions transport", () => {
  it.each(["managed", "direct"] as const)(
    "reports final encoded tool names without request content in %s mode",
    async (mode) => {
      vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", "tools");
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      const redact = vi
        .spyOn(getAiTransportHost(), "redactToolPayloadText")
        .mockImplementation((name) =>
          name.replaceAll("synthetic-sensitive-name", "[host-redacted]"),
        );
      const message = "synthetic-private-message";
      const description = "synthetic-private-tool-description";
      const model = makeCompletionsModel({
        provider: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        reasoning: false,
        headers: { "x-synthetic-private-header": "synthetic-private-header-value" },
      });
      const tools = [
        "read",
        "prefix-test-key-suffix",
        "synthetic-sensitive-name",
        "web_search",
        "web_fetch",
      ].map((name) => ({
        name,
        description,
        parameters: { type: "object" as const, properties: {} },
      }));
      const options: OpenAICompletionsOptions = {};
      let encodedAttempts = 0;
      let encodedBytes: Uint8Array | undefined;
      modelRequestBodyState(options).encode = async (payload) => {
        encodedAttempts += 1;
        const encoded = structuredClone(payload) as {
          tools: Array<{ function: { name?: string } }>;
        };
        encoded.tools = encoded.tools.filter((tool) => tool.function.name !== "web_search");
        encoded.tools.push({ function: {} });
        const body = serializeModelRequestBody(encoded);
        body.body = new TextEncoder().encode(` \n${new TextDecoder().decode(body.body)}\n`);
        encodedBytes = body.body;
        return body;
      };
      try {
        const request = await captureTransportRequest(model, tools, options, mode, message);
        expect(new Uint8Array(await request.clone().arrayBuffer())).toEqual(encodedBytes);
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        expect(request.headers.get("x-synthetic-private-header")).toBe(
          "synthetic-private-header-value",
        );
        const body = (await request.json()) as {
          tools: Array<{ function: { name?: string } }>;
        };
        expect(body.tools.map((tool) => tool.function.name)).toEqual([
          "prefix-test-key-suffix",
          "read",
          "synthetic-sensitive-name",
          "web_fetch",
          undefined,
        ]);
        expect(encodedAttempts).toBe(1);
        const diagnostics = info.mock.calls.map(([entry]) => entry);
        const expected =
          '[completions] tools count=5 names=["prefix-[redacted]-suffix","read","[host-redacted]","web_fetch","<unknown>"]';
        expect(diagnostics).toContain(expected);
        expect(diagnostics.join("\n")).not.toContain(message);
        expect(diagnostics.join("\n")).not.toContain(description);
        expect(diagnostics.join("\n")).not.toContain("test-key");
        expect(diagnostics.join("\n")).not.toContain("synthetic-sensitive-name");
        expect(diagnostics.join("\n")).not.toContain("synthetic-private-header");

        vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", "full-redacted");
        info.mockClear();
        const fullRedactedRequest = await captureTransportRequest(
          model,
          tools,
          options,
          mode,
          message,
        );
        expect(new Uint8Array(await fullRedactedRequest.arrayBuffer())).toEqual(encodedBytes);
        expect(info.mock.calls.map(([entry]) => entry)).toContain(expected);

        vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", "tools");
        info.mockClear();
        await captureTransportRequest(model, [], {}, mode, message);
        expect(info.mock.calls.map(([entry]) => entry)).toContain(
          "[completions] tools count=0 names=[]",
        );

        vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", undefined);
        info.mockClear();
        await captureTransportRequest(model, tools, options, mode, message);
        expect(info.mock.calls.map(([entry]) => entry).join("\n")).not.toContain(
          "[completions] tools",
        );
      } finally {
        redact.mockRestore();
        info.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    new TextEncoder().encode("synthetic-private-invalid-json"),
    new TextEncoder().encode('{"tools":"synthetic-private-invalid-tool-list"}'),
    new Uint8Array([0xff]),
  ])("reports an unreadable encoded request without logging or changing it", async (encoded) => {
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", "tools");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const options: OpenAICompletionsOptions = {};
    modelRequestBodyState(options).encode = async () => ({
      body: encoded,
      stream: true,
    });
    try {
      const request = await captureTransportRequest(
        makeCompletionsModel({
          provider: "synthetic",
          baseUrl: "https://synthetic.invalid/v1",
          reasoning: false,
        }),
        [],
        options,
      );
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(encoded);
      expect(warn.mock.calls.map(([entry]) => entry)).toContain(
        "[completions] unable to inspect encoded tool names; request unchanged",
      );
      expect(warn.mock.calls.map(([entry]) => entry).join("\n")).not.toContain("synthetic-private");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("re-encodes only rejected Sparky admission and never replays an accepted incomplete stream", async () => {
    vi.stubEnv("GROGU_PROFILE_FILE", "/synthetic/profile.json");
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", "tools");
    vi.useFakeTimers();
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const previousHost = getAiTransportHost();
    const bodies: string[] = [];
    let rejectAdmission = true;
    let incomplete = false;
    configureAiTransportHost({
      ...previousHost,
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.text());
        if (rejectAdmission) {
          rejectAdmission = false;
          return new Response(JSON.stringify({ error: { message: "Concurrency limit reached" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after-ms": "1" },
          });
        }
        return new Response(
          `data: ${JSON.stringify(makeCompletionsChunk({ content: "ok" }, incomplete ? null : "stop"))}\n\n${incomplete ? "" : "data: [DONE]\n\n"}`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    try {
      const run = async () => {
        const stream = createOpenAICompletionsTransportStreamFn()(
          makeCompletionsModel({
            provider: "sparky",
            id: "synthetic",
            baseUrl: "https://synthetic.invalid/v1",
          }),
          { messages: [{ role: "user", content: "public fixture", timestamp: 1 }] },
          { apiKey: "synthetic-key", timeoutMs: 1_000 },
        );
        if (stream instanceof Promise) {
          throw new Error("Expected synchronous stream");
        }
        for await (const event of stream) {
          void event;
        }
        return stream.result();
      };
      const pending = run();
      await vi.runAllTimersAsync();
      expect((await pending).stopReason).toBe("stop");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(
        info.mock.calls.filter(([entry]) => entry.startsWith("[completions] tools")),
      ).toHaveLength(2);
      incomplete = true;
      expect((await run()).stopReason).toBe("error");
      expect(bodies).toHaveLength(3);
      expect(
        info.mock.calls.filter(([entry]) => entry.startsWith("[completions] tools")),
      ).toHaveLength(3);
    } finally {
      configureAiTransportHost(previousHost);
      info.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
  it.each([
    {
      modelId: "gpt-6-astra",
      endpoint: "official OpenAI",
      baseUrl: "https://api.openai.com/v1",
      path: "/v1/responses",
      toolChoice: { type: "function", name: "read" },
      responsesEffort: "high",
    },
    {
      modelId: "gpt-5.2",
      endpoint: "official OpenAI",
      baseUrl: "https://api.openai.com/v1",
      path: "/v1/responses",
      toolChoice: { type: "function", name: "read" },
      responsesEffort: "high",
    },
    {
      modelId: "gpt-6-astra",
      endpoint: "OpenAI-compatible proxy",
      baseUrl: "https://proxy.example.com/v1",
      path: "/v1/chat/completions",
      toolChoice: { type: "function", function: { name: "read" } },
      responsesEffort: undefined,
    },
  ])(
    "sends $endpoint $modelId reasoning tool turns to $path",
    async ({ modelId, baseUrl, path, toolChoice, responsesEffort }) => {
      const request = await captureTransportRequest(
        makeCompletionsModel({ id: modelId, provider: "openai-api", baseUrl }),
        [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        { toolChoice: { type: "function", function: { name: "read" } } },
      );
      const body = await request.json();

      expect(new URL(request.url).pathname).toBe(path);
      expect(body.tool_choice).toEqual(toolChoice);
      // An unset reasoning selector keeps the managed Completions default (high).
      expect(body.reasoning?.effort).toBe(responsesEffort);
    },
  );

  it("passes provider request timeouts to OpenAI SDK per-request options", () => {
    const signal = new AbortController().signal;
    const model = {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      requestTimeoutMs: 900_000.7,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
      maxRetries: 0,
    });
    expect(
      buildOpenAISdkRequestOptions(
        { ...model, requestTimeoutMs: -1 } as Model<"openai-completions">,
        undefined,
      ),
    ).toBeUndefined();
  });
  it("streams OpenAI-compatible loopback requests with the configured SDK timeout", async () => {
    let captured: { path?: string; timeout?: string; model?: string; roles?: string[] } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ role?: string }>;
        };
        captured = {
          path: req.url,
          timeout: Array.isArray(req.headers["x-stainless-timeout"])
            ? req.headers["x-stainless-timeout"][0]
            : req.headers["x-stainless-timeout"],
          model: parsed.model,
          roles: parsed.messages?.map((message) => message.role ?? ""),
        };
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({}, "stop", {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const baseModel = {
        id: "mlx-community/Qwen3-30B-A3B-6bit",
        name: "Qwen3 MLX",
        api: "openai-completions",
        provider: "mlx",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
        requestTimeoutMs: 900_000,
      } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(captured.path).toBe("/v1/chat/completions");
      expect(captured.timeout).toBe("900");
      expect(captured.model).toBe("mlx-community/Qwen3-30B-A3B-6bit");
      expect(captured.roles).toEqual(["system", "user"]);
      expect(doneReason).toBe("stop");
      expect(text).toBe("OK");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses ModelStudio chat streams with no user or assistant payload turns", async () => {
    const model = makeCompletionsModel({
      id: "qwen-coder-plus",
      name: "qwen-coder-plus",
      provider: "qwen",
      baseUrl: "https://modelstudio.example/v1",
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 256,
    });
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      {
        systemPrompt: "runtime-only system prompt",
        messages: [],
        tools: [],
      } as never,
      { apiKey: "test-key" } as never,
    );

    let errorPayload: Record<string, unknown> | undefined;
    for await (const event of stream as AsyncIterable<{
      type: string;
      error?: Record<string, unknown>;
    }>) {
      if (event.type === "error") {
        errorPayload = event.error;
      }
    }

    expect(errorPayload).toMatchObject({ stopReason: "error" });
    expect(String(errorPayload?.errorMessage)).toContain(
      "contains no non-empty user or assistant messages",
    );
    expect(String(errorPayload?.errorMessage)).toContain("system/tool-only request");
  });

  it("allows generic OpenAI-compatible chat streams without the ModelStudio turn guard", async () => {
    let capturedRoles: string[] | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        capturedRoles = parsed.messages?.map((message) => message.role ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(`data: ${JSON.stringify(makeCompletionsChunk({}, "stop"))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "generic-openai-compatible",
        name: "Generic OpenAI Compatible",
        provider: "custom-openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 256,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "runtime-only system prompt",
          messages: [],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      for await (const event of stream as AsyncIterable<{ type: string; reason?: string }>) {
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(capturedRoles).toEqual(["system"]);
      expect(doneReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails OpenAI completions streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createDeepSeekCompletionsModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = processCompletionsStream(
        neverYieldsStream() as AsyncIterable<ChatCompletionChunk>,
        createAssistantOutput(model),
        model,
        { push: vi.fn() },
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves Azure OpenAI completions api-version headers into query params", async () => {
    const request = await captureTransportRequest({
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      api: "openai-completions",
      provider: "azure-custom",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini?existing=1",
      headers: {
        "api-key": "azure-key",
        "api-version": "2024-10-21",
        "X-Tenant": "acme",
      },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } as unknown as Model<"openai-completions">);
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(
      "https://example.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      existing: "1",
      "api-version": "2024-10-21",
    });
    expect(request.headers.get("api-key")).toBe("azure-key");
    expect(request.headers.get("x-tenant")).toBe("acme");
    expect(request.headers.has("api-version")).toBe(false);
  });

  it("preserves configured query params without moving non-Azure headers", async () => {
    const request = await captureTransportRequest(
      makeCompletionsModel({
        id: "proxy-model",
        name: "Proxy Model",
        provider: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1?tenant=acme",
        headers: {
          "api-version": "proxy-header",
          "X-Tenant": "acme",
        },
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
      }),
    );
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://proxy.example.com/v1/chat/completions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tenant: "acme" });
    expect(request.headers.get("api-version")).toBe("proxy-header");
    expect(request.headers.get("x-tenant")).toBe("acme");
  });
});
