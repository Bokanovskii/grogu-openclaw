import { randomUUID } from "node:crypto";
import type { ProtectedCredential } from "@openclaw/gateway-protocol/protected";
import { ProtectedError } from "./errors.js";

export type RelayProvider = "github-copilot" | "openai";
type RelayCredential = ProtectedCredential;
type Prompt = { verificationUrl: string; userCode: string; expiresInMs: number };
type Authority = {
  profileId: string;
  sessionHash: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};
type Flow = {
  id: string;
  provider: RelayProvider;
  profileId: string;
  sessionHash: string;
  controller: AbortController;
  expiresAt: number;
  credential?: RelayCredential;
  error?: ProtectedError;
};
function providerFailure() {
  return new ProtectedError(
    502,
    "provider_auth_failed",
    "The provider did not authorize this connection. Start again.",
  );
}

export function createProviderRelay() {
  const flows = new Map<string, Flow>();
  const renewing = new Set<string>();
  const drop = (flow: Flow) => {
    flows.delete(flow.id);
    flow.credential = undefined;
    flow.controller.abort();
  };
  const owned = (provider: RelayProvider, id: string, authority: Authority) => {
    const flow = flows.get(id);
    if (
      !flow ||
      flow.provider !== provider ||
      flow.profileId !== authority.profileId ||
      flow.sessionHash !== authority.sessionHash
    ) {
      throw new ProtectedError(404, "not_found", "Connection not found.");
    }
    return flow;
  };
  return {
    close() {
      for (const flow of flows.values()) {
        drop(flow);
      }
    },
    invalidate(match: { profileId?: string; sessionHash?: string }) {
      for (const flow of flows.values()) {
        if (
          (match.profileId && flow.profileId === match.profileId) ||
          (match.sessionHash && flow.sessionHash === match.sessionHash)
        ) {
          drop(flow);
        }
      }
    },
    async start(provider: RelayProvider, authority: Authority) {
      await authority.revalidate();
      if (
        flows.size >= 24 ||
        [...flows.values()].some(
          (flow) => flow.profileId === authority.profileId && flow.provider === provider,
        )
      ) {
        throw new ProtectedError(
          409,
          "provider_connect_busy",
          "Cancel the current connection before starting again.",
        );
      }
      const flow: Flow = {
        id: randomUUID(),
        provider,
        profileId: authority.profileId,
        sessionHash: authority.sessionHash,
        controller: new AbortController(),
        expiresAt: Date.now() + 15 * 60_000,
      };
      flows.set(flow.id, flow);
      const challenge = Promise.withResolvers<Prompt>();
      const disconnect = () => drop(flow);
      authority.signal.addEventListener("abort", disconnect, { once: true });
      const signal = flow.controller.signal;
      signal.addEventListener("abort", () => challenge.reject(providerFailure()), { once: true });
      const assertCurrent = () => {
        signal.throwIfAborted();
        authority.assertCurrent();
        if (Date.now() >= flow.expiresAt) {
          throw providerFailure();
        }
      };
      const show = async (prompt: Prompt) => {
        assertCurrent();
        await authority.revalidate();
        assertCurrent();
        flow.expiresAt = Math.min(flow.expiresAt, Date.now() + prompt.expiresInMs);
        challenge.resolve(prompt);
      };
      const timer = setTimeout(() => drop(flow), 15 * 60_000);
      timer.unref();
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      let validating = false;
      const liveCheck = setInterval(() => {
        if (validating) {
          return;
        }
        validating = true;
        void authority
          .revalidate()
          .catch(() => drop(flow))
          .finally(() => {
            validating = false;
          });
      }, 5000);
      liveCheck.unref();
      signal.addEventListener("abort", () => clearInterval(liveCheck), { once: true });
      void (async () => {
        try {
          if (provider === "github-copilot") {
            const { runGitHubCopilotDeviceFlow } =
              await import("../../extensions/github-copilot/api.js");
            const result = await runGitHubCopilotDeviceFlow({
              signal,
              assertCurrent,
              showCode: show,
            });
            if (result.status !== "authorized") {
              throw providerFailure();
            }
            assertCurrent();
            flow.credential = { accessToken: result.accessToken };
          } else {
            const { loginOpenAICodexDeviceCode } = await import("../../extensions/openai/api.js");
            const result = await loginOpenAICodexDeviceCode({
              signal,
              assertCurrent,
              onVerification: show,
            });
            assertCurrent();
            flow.credential = {
              accessToken: result.access,
              refreshToken: result.refresh,
              expiresAt: result.expires,
              generation: 1,
            };
          }
        } catch {
          flow.error = providerFailure();
          challenge.reject(flow.error);
        }
      })();
      try {
        const prompt = await challenge.promise;
        await authority.revalidate();
        assertCurrent();
        return {
          id: flow.id,
          verificationUrl: prompt.verificationUrl,
          userCode: prompt.userCode,
          intervalMs: 2000,
          expiresAt: flow.expiresAt,
        };
      } catch {
        drop(flow);
        throw providerFailure();
      } finally {
        authority.signal.removeEventListener("abort", disconnect);
      }
    },
    async poll(provider: RelayProvider, id: string, authority: Authority) {
      await authority.revalidate();
      const flow = owned(provider, id, authority);
      if (flow.error || Date.now() >= flow.expiresAt) {
        drop(flow);
        throw (
          flow.error ??
          new ProtectedError(
            410,
            "provider_connect_expired",
            "The connection expired. Start again.",
          )
        );
      }
      const credential = flow.credential;
      if (!credential) {
        return { status: "pending" as const };
      }
      drop(flow);
      return { status: "authorized" as const, credential };
    },
    async cancel(provider: RelayProvider, id: string, authority: Authority) {
      await authority.revalidate();
      drop(owned(provider, id, authority));
    },
    async renew(credential: RelayCredential & { refreshToken: string }, authority: Authority) {
      await authority.revalidate();
      if (renewing.has(authority.profileId)) {
        throw new ProtectedError(
          409,
          "provider_renew_busy",
          "Another renewal is active. Wait for it to finish.",
        );
      }
      renewing.add(authority.profileId);
      try {
        const { refreshOpenAICodexToken } = await import("../../extensions/openai/api.js");
        await authority.revalidate();
        const result = await refreshOpenAICodexToken(credential.refreshToken, {
          signal: authority.signal,
          assertCurrent: authority.assertCurrent,
        }).catch(() => {
          throw providerFailure();
        });
        await authority.revalidate();
        const accountId = typeof result.accountId === "string" ? result.accountId : undefined;
        return {
          credential: {
            accessToken: result.access,
            refreshToken: result.refresh,
            expiresAt: result.expires,
            generation: (credential.generation ?? 0) + 1,
            accountId,
          },
        };
      } finally {
        renewing.delete(authority.profileId);
      }
    },
  };
}
