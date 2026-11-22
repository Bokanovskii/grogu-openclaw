// GitHub Copilot host allowlist. Kept as a dependency-free leaf so both the
// provider-auth SDK facade and the core GitHub Copilot OAuth runtime can share
// one canonical fail-closed check without importing each other.

export const DEFAULT_GITHUB_COPILOT_DOMAIN = "github.com";

// Matches a data-residency GHE tenant root (`<tenant>.ghe.com`, single label).
// GitHub defines a GHE.com enterprise as a dedicated `SUBDOMAIN.ghe.com` domain;
// nested hosts (`api.<tenant>.ghe.com`, `copilot-api.<tenant>.ghe.com`) are
// derived service endpoints, not tenants — accepting one would template broken
// hosts like `api.api.<tenant>.ghe.com` for the token exchange. Bare `ghe.com`
// is likewise excluded: it is not a tenant and hosts no Copilot endpoint.
const GHE_DATA_RESIDENCY_HOST = /^[a-z0-9-]+\.ghe\.com$/;

/**
 * Whether a host may be templated into a Copilot endpoint: the public host or a
 * data-residency GHE tenant (`*.ghe.com`). An absent value counts as supported
 * because callers fall back to the public default. Anything else (a scheme,
 * path, credentials, or an off-allowlist host) is not, so a persisted or
 * injected origin can be rejected before any token is sent to it.
 */
export function isSupportedGithubCopilotDomain(raw: string | undefined | null): boolean {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  return trimmed === DEFAULT_GITHUB_COPILOT_DOMAIN || GHE_DATA_RESIDENCY_HOST.test(trimmed);
}

/**
 * Coerce a user/config-supplied GitHub host to a safe bare lowercase hostname.
 *
 * Fails closed to public `github.com`: only the public host and data-residency
 * GHE tenants (`*.ghe.com`) are trusted. Any other value falls back to the
 * default rather than being used verbatim, because the resolved host becomes the
 * `api.<host>` endpoint that receives the GitHub OAuth token during exchange — a
 * typo or injected value like `evil.com` must never redirect that token.
 * (Classic self-hosted GHE Server uses arbitrary hostnames but does not host
 * Copilot, so it is deliberately out of scope.) Config-supplied hosts coerce
 * rather than throw; persisted credential origins are rejected upstream with
 * `isSupportedGithubCopilotDomain` before reaching a token request.
 */
export function normalizeGithubCopilotDomain(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed && isSupportedGithubCopilotDomain(trimmed)) {
    return trimmed;
  }
  return DEFAULT_GITHUB_COPILOT_DOMAIN;
}

// A device-flow token carries the host that minted it, so ambient domain
// settings cannot redirect it. Both Copilot plugins read this one format.
const BOUND_TOKEN_PREFIX = "openclaw-github-copilot-token:v1:";

export function bindGithubCopilotToken(token: string, githubDomain: string): string {
  return `${BOUND_TOKEN_PREFIX}${JSON.stringify({ token, githubDomain: normalizeGithubCopilotDomain(githubDomain) })}`;
}

/** Returns undefined for an unbound token; throws for a malformed bound token. */
export function parseGithubCopilotBoundToken(
  value: string,
): { token: string; githubDomain: string } | undefined {
  if (!value.startsWith(BOUND_TOKEN_PREFIX)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(BOUND_TOKEN_PREFIX.length));
  } catch {
    parsed = undefined;
  }
  const { token, githubDomain } = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (
    typeof token !== "string" ||
    !token.trim() ||
    typeof githubDomain !== "string" ||
    !githubDomain.trim() ||
    !isSupportedGithubCopilotDomain(githubDomain)
  ) {
    throw new Error("Invalid GitHub Copilot bound token; reconnect the account.");
  }
  return { token, githubDomain: normalizeGithubCopilotDomain(githubDomain) };
}
