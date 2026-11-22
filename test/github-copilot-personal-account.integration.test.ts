import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import githubCopilotPlugin from "../extensions/github-copilot/index.js";
import { resolveSharedMainAuthAgentDir } from "../src/agents/auth-profiles/shared-main-dir.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../src/agents/auth-profiles/store-runtime.js";
import { createModelAccountConnectService } from "../src/gateway/model-account-connect.js";
import type { fetchWithSsrFGuard } from "../src/infra/net/fetch-guard.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { readUserModelAuthProfile } from "../src/state/user-model-accounts.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { registerSingleProviderPlugin } from "../src/test-utils/plugin-registration.js";

type GuardedFetchParams = Parameters<typeof fetchWithSsrFGuard>[0];

const network = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: string; headers: string }>,
  handle: undefined as
    | ((params: { url: string; signal?: AbortSignal }) => Promise<Record<string, unknown>>)
    | undefined,
  handleFetch: undefined as ((signal?: AbortSignal | null) => Promise<Response>) | undefined,
}));
const childProcesses = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../src/infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: async (params: GuardedFetchParams) => {
    params.beforeRequest?.();
    network.requests.push({
      url: params.url,
      body: String(params.init?.body ?? ""),
      headers: JSON.stringify(params.init?.headers ?? {}),
    });
    if (!network.handle) {
      throw new Error(`unexpected network request: ${params.url}`);
    }
    const json = await network.handle({ url: params.url, signal: params.signal });
    return {
      response: Response.json(json),
      finalUrl: params.url,
      release: async () => {},
    };
  },
}));

// Keychain and CLI-login readers shell out; this path must never start a process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record =
    <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      childProcesses.calls.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  return {
    ...actual,
    exec: record("exec", actual.exec),
    execFile: record("execFile", actual.execFile),
    execFileSync: record("execFileSync", actual.execFileSync),
    execSync: record("execSync", actual.execSync),
    spawn: record("spawn", actual.spawn),
    spawnSync: record("spawnSync", actual.spawnSync),
  };
});

// The Gateway loads bundled providers with its isolated module loader. Register the
// same plugin entry here so the network boundary above also applies to its imports.
const provider = vi.hoisted(() => ({ current: undefined as ProviderPlugin | undefined }));
vi.mock("../src/plugins/providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugins/providers.runtime.js")>()),
  resolvePluginProvidersCore: () => (provider.current ? [provider.current] : []),
}));

const HOST_TOKEN = "ghp_host-sentinel-never-used";
const MEMBER_TOKEN = "gho_synthetic-member-token";
const DEVICE_CODE = "synthetic-device-code";
const USER_CODE = "SYNT-1234";

afterEach(() => {
  network.requests.length = 0;
  network.handle = undefined;
  network.handleFetch = undefined;
  childProcesses.calls.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function deviceCodeResponse() {
  // Later poll sleeps use controlled time; earlier Gateway work keeps real timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return {
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 1,
  };
}

async function withMemberSignIn(
  run: (params: {
    service: ReturnType<typeof createModelAccountConnectService>;
    member: { owner: string; assertCurrent(): void };
    other: { owner: string; assertCurrent(): void };
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    provider.current = {
      ...(await registerSingleProviderPlugin(githubCopilotPlugin)),
      pluginId: "github-copilot",
    };
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "github-copilot:github": { type: "token", provider: "github-copilot", token: HOST_TOKEN },
      },
    });
    vi.stubEnv("COPILOT_GITHUB_TOKEN", HOST_TOKEN);
    vi.stubEnv("GH_TOKEN", HOST_TOKEN);
    vi.stubEnv("GITHUB_TOKEN", HOST_TOKEN);
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "enterprise.example.test");
    // Starter-model discovery uses global fetch; keep it offline and observable.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        network.requests.push({
          url: String(input instanceof Request ? input.url : input),
          body: String(init?.body ?? ""),
          headers: JSON.stringify(init?.headers ?? {}),
        });
        if (network.handleFetch) {
          return await network.handleFetch(init?.signal);
        }
        throw new Error("offline");
      }),
    );
    const config = {};
    const service = createModelAccountConnectService({ getConfig: () => config });
    const member = { owner: ensureProfileForEmail("copilot-member@example.test").id };
    const other = { owner: ensureProfileForEmail("copilot-other@example.test").id };
    const configBefore = await fs.readFile(state.configPath, "utf8");
    const sharedBefore = ensureAuthProfileStoreWithoutExternalProfiles(
      resolveSharedMainAuthAgentDir(),
      { readOnly: true },
    );
    try {
      await run({
        service,
        member: { ...member, assertCurrent() {} },
        other: { ...other, assertCurrent() {} },
      });
    } finally {
      vi.useRealTimers();
      await service.stop();
    }
    expect(
      ensureAuthProfileStoreWithoutExternalProfiles(resolveSharedMainAuthAgentDir(), {
        readOnly: true,
      }).profiles,
    ).toEqual(sharedBefore.profiles);
    await expect(fs.readFile(state.configPath, "utf8")).resolves.toBe(configBefore);
    for (const request of network.requests) {
      expect(JSON.stringify(request)).not.toContain(HOST_TOKEN);
    }
    expect(childProcesses.calls).toEqual([]);
  });
}

async function startAtDeviceCode(
  service: ReturnType<typeof createModelAccountConnectService>,
  member: { owner: string; assertCurrent(): void },
) {
  const started = await service.start(member, "github-copilot", "device");
  const intro = await vi.waitFor(async () => {
    const status = await service.statusAsync(member, started.connectId);
    expect(status).toMatchObject({
      status: "pending",
      step: { type: "note", message: expect.stringContaining("GitHub device login") },
    });
    return status;
  });
  if (intro.status !== "pending" || !intro.step) {
    throw new Error("expected the device-login note");
  }
  await service.answer(member, started.connectId, intro.step.id, true);
  await vi.waitFor(async () =>
    expect(await service.statusAsync(member, started.connectId)).toMatchObject({
      status: "pending",
      step: {
        type: "progress",
        deviceCode: { code: USER_CODE },
        externalUrl: "https://github.com/login/device",
      },
    }),
  );
  return started.connectId;
}

it("offers only public GitHub device sign-in as a personal account method", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const service = createModelAccountConnectService({ getConfig: () => ({}) });
    const action = {
      owner: ensureProfileForEmail("catalog@example.test").id,
      assertCurrent() {},
    };
    const copilot = service
      .catalog(action)
      .providers.find((entry) => entry.id === "github-copilot");
    expect(copilot?.methods.map((method) => method.id)).toEqual(["device"]);
    await service.stop();
  });
});

it("connects a member-owned Copilot account without host credentials", async () => {
  await withMemberSignIn(async ({ service, member, other }) => {
    const approved = createDeferredCore();
    network.handle = async ({ url }) => {
      if (url === "https://github.com/login/device/code") {
        return deviceCodeResponse();
      }
      if (url === "https://github.com/login/oauth/access_token") {
        await approved.promise;
        return { access_token: MEMBER_TOKEN, token_type: "bearer", scope: "read:user" };
      }
      throw new Error(`unexpected network request: ${url}`);
    };
    const connectId = await startAtDeviceCode(service, member);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    approved.resolve();
    await vi.waitFor(async () =>
      expect(await service.statusAsync(member, connectId)).toMatchObject({
        status: "connected",
      }),
    );

    const accounts = await service.listAsync(member);
    expect(accounts.accounts).toEqual([
      expect.objectContaining({ provider: "github-copilot", authType: "token" }),
    ]);
    expect(JSON.stringify(accounts)).not.toContain(MEMBER_TOKEN);
    expect(readUserModelAuthProfile(accounts.accounts[0]?.authProfileId ?? "")).toMatchObject({
      credential: { type: "token", provider: "github-copilot", token: MEMBER_TOKEN },
    });
    expect((await service.listAsync(other)).accounts).toEqual([]);
    expect(await service.statusAsync(other, connectId)).toEqual({ status: "expired" });
    expect(network.requests.slice(0, 2).map((request) => request.url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
    ]);
    expect(network.requests[1]?.body).toContain(DEVICE_CODE);
    // Any later discovery is best effort and may carry only the member's own token.
    for (const request of network.requests.slice(2)) {
      expect(new URL(request.url).hostname).not.toBe("enterprise.example.test");
    }
  });
});

it("cancels at the device-code step without polling or storing an account", async () => {
  await withMemberSignIn(async ({ service, member }) => {
    let providerSignal: AbortSignal | undefined;
    network.handle = async ({ url, signal }) => {
      if (url === "https://github.com/login/device/code") {
        providerSignal = signal;
        return deviceCodeResponse();
      }
      throw new Error(`unexpected network request: ${url}`);
    };
    const connectId = await startAtDeviceCode(service, member);
    expect(await service.cancelAsync(member, connectId)).toEqual({ status: "cancelled" });
    expect(providerSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    expect(network.requests.map((request) => request.url)).toEqual([
      "https://github.com/login/device/code",
    ]);
    expect((await service.listAsync(member)).accounts).toEqual([]);
  });
});

it("cancels during starter discovery without storing the exchanged account", async () => {
  await withMemberSignIn(async ({ service, member }) => {
    network.handle = async ({ url }) => {
      if (url === "https://github.com/login/device/code") {
        return deviceCodeResponse();
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return { access_token: MEMBER_TOKEN, token_type: "bearer", scope: "read:user" };
      }
      throw new Error(`unexpected network request: ${url}`);
    };
    const discovery = createDeferredCore<AbortSignal | null | undefined>();
    network.handleFetch = (signal) => {
      discovery.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const connectId = await startAtDeviceCode(service, member);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    const discoverySignal = await discovery.promise;
    expect(await service.cancelAsync(member, connectId)).toEqual({ status: "cancelled" });
    expect(discoverySignal?.aborted).toBe(true);
    await vi.waitFor(async () =>
      expect(await service.statusAsync(member, connectId)).toMatchObject({ status: "cancelled" }),
    );
    expect(network.requests.map((request) => request.url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/copilot_internal/user",
    ]);
    expect((await service.listAsync(member)).accounts).toEqual([]);
  });
});
