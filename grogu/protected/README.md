# Protected Family runtime

The Family API listens on loopback. It is not a Gateway or an administrator
endpoint. Run it under the dedicated unprivileged `groguProtected` account,
with a private `HOME` and state directory. Forward the hostname's traffic to
loopback port 19789. Cloudflare Access protects both the app and API; Cloudflare
owns `/cdn-cgi/access/*`. The listener serves the app and its compiled assets
without routing API, Access, or unknown paths to the app shell.

## Entrypoint

Place the reviewed client build output in `protected-client/` at the installed
service root, alongside `grogu/` and `scripts/`. Install only the compiled
`dist` contents there, not the separate client checkout. The listener requires
`protected-client/index.html` before it starts. Then use Node 26.12.1:

```sh
OPENCLAW_STATE_DIR=/absolute/private/state \
OPENCLAW_CONFIG_PATH=/absolute/private/config/openclaw.json \
node --import ./scripts/tsx.mjs grogu/protected/main.ts /absolute/private/config/protected.json
```

The fixed macOS maintenance helper runs pinned pnpm 12.15.0 through its
`bin/pnpm.mjs` Node fallback. Its install scripts are disabled, so do not assume
that the package's top-level native launcher was installed or use the older
`bin/pnpm.cjs` path. An already provisioned service needs only the root-owned
maintenance helper corrected, not another account bootstrap or source install.

The configuration is a non-writable-by-group/others JSON file with these keys:

| Key               | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| `stateDir`        | Existing absolute private state directory; identical to `OPENCLAW_STATE_DIR`. |
| `origin`          | Exact HTTPS client origin, without a trailing slash.                          |
| `port`            | Unprivileged loopback listener port.                                          |
| `accessIssuer`    | Exact `https://<team>.cloudflareaccess.com` issuer origin.                    |
| `accessAudience`  | Access application audience.                                                  |
| `allowedSubjects` | Explicit subject strings from that issuer; `[]` denies all.                   |
| `sparkySecret`    | `{"source":"env","provider":"default","id":"SPARKY_API_KEY"}`.                |
| `storageLimits`   | Integer byte limits: `userBytes`, `globalBytes`, and `freeFloorBytes`.        |

Provision the Sparky key from the isolated service secret source. Never put a
key, token, or refresh credential in this JSON file. Do not copy personal Grogu
state or configuration. The profile/session stores are OpenClaw's canonical
stores inside this isolated state directory.

Initialization measures free space on the state volume. It reserves a 512 MiB
free-space floor and takes at most one-sixteenth of the remaining space, capped
at 256 MiB, for the Family budget. Each profile is limited to one-quarter of
that budget. The runtime counts canonical chat/transcript bytes and files in
each chat's directory, including widgets and fetched artifacts, and conservatively
limits growth per turn. The pilot allows one storage-growing request at a time.
If a quota is reached, export or delete a chat to free admission; the runtime
does not evict chats or keep backups. A volume below its floor stops accepting
writes until space is available. Chat deletion remains available.

The default Sparky route can fetch known public URLs with OpenClaw's `web_fetch`
and display the resulting sources. It does not have a search provider;
`web_search` is disabled. Managed search would require a separately approved
search plugin and isolated credential or endpoint (for example, Brave with its
own `BRAVE_API_KEY`). The Sparky key is not a search credential, and Family does
not inherit provider keys or configuration from personal Grogu.

## Verification and release gates

The focused HTTP boundary fixture uses loopback HTTP, synthetic identities, and
real profile and chat storage. Run it from the checkout with Node 26.12.1:

```sh
proof="$PWD/.artifacts/protected-proof-$$"
mkdir -m 700 -p "$proof/home" "$proof/state"
trap 'rm -rf "$proof"' EXIT
env -i PATH="$PATH" HOME="$proof/home" TMPDIR="$proof" \
  OPENCLAW_STATE_DIR="$proof/state" OPENCLAW_CONFIG_PATH="$proof/state/openclaw.json" \
  "$HOME/.local/bin/heavy" -- node --import ./scripts/tsx.mjs \
  --test --test-timeout=90000 grogu/protected/http.test.ts
```

This proves neither a real provider nor the Access identity response. The
authoritative client DTOs are exported from `@openclaw/gateway-protocol/protected`.

The isolated listener may be installed and checked with an empty
`allowedSubjects` list. Keep admission deny-all until the Cloudflare
issuer/audience, live identity response, and reverse proxy have been verified.
Personal provider use additionally requires the user's consent and entitlement;
synthetic fixtures do not prove either. The GitHub Copilot and OpenAI
device relays use the respective provider plugins; the service hands tokens
back only once and keeps them neither in an account store nor in chat history.
OpenAI renewal is explicit: the device submits a refresh credential and must
replace its local record with the newly returned generation. A lost response
or revoked grant can require signing in again. No fallback to a host provider
account is allowed.

Run `maintain.ts` under the isolated service account and environment.
`init --deploy-json FILE` creates the deny-all configuration; `add-subject UUID`
adds an exact subject, which takes effect after a protected listener restart.
For owner-driven revocation, stop the listener before invoking
`revoke-profile PROFILE_ID` and restart after it succeeds; the canonical denial
survives the restart. `GET /healthz` reports listener readiness without user data.
