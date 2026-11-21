# Protected Alcove runtime

The Alcove API listens on loopback. It is not a Gateway or an administrator
endpoint. Run it under the dedicated unprivileged `groguProtected` account,
with a private `HOME` and state directory. Forward the hostname's traffic to
loopback port 19789. Cloudflare Access protects the private app and API; Cloudflare
owns `/cdn-cgi/access/*`. When the approved public policy is activated, only
`/request-access` and its necessary descendants bypass Access. The listener serves
the public entry and its assets separately from the private app shell.

For the public request route, the loopback listener uses a single valid
`CF-Connecting-IP` value for rate limiting only. Cloudflare Tunnel supplies
this header for external traffic. A local process or a same-zone Worker can
spoof it, so it is not authorization. Missing or invalid values share a
conservative limit. Global submission and stored-request limits also apply.

## Fixed policy helper

The policy helper is a separate, root-owned installation. In a private
operator-owned staging directory (mode 0700), place the reviewed
`protected-policy-helper.py` and `protected-policy-config.json` as regular,
operator-owned files with mode 0600. The JSON configuration contains exactly
`accountId`, `appId`, `policyId`, `policyName`, `ownerEmail`, and `token`.
Choose an application-specific allow policy dedicated to this app; the token
needs Cloudflare's `Access: Policies Write` permission. The token's Cloudflare
scope is not restricted to one application: the fixed helper supplies that
restriction. Never put the token in command arguments or logs.

On the protected Mac, with the reviewed system Python and Command Line Tools
installed, the administrator provisions the helper with:

```sh
sudo /bin/bash grogu/deploy/protected-bootstrap-macos.sh \
  --operator USER --staging-dir /absolute/private/staging --install-policy-helper
```

The installer checks the helper's pinned digest, installs root-owned code and
root-only configuration, and removes the staged configuration after verifying
the copy. It makes no Cloudflare request. Existing helper paths require
inspection instead of being overwritten. Before each policy write, the app
records a recovery barrier in its state database. A crash or an unknown outcome
blocks later policy writes until the owner requests reconciliation. The helper
reads the policy before it applies the current admission. Cloudflare does not
provide an atomic cross-system commit here. Its policy can temporarily disagree
with the app during repair. The app denies a removed person throughout.

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

`install` accepts only an empty `service/`. Later releases use `update`, which
runs as the service account with no added privilege. Stop the runtime, then run
`receive`, `update`, `dependencies`, and `restart runtime`. `update` extracts
`inbox/runtime.tar` into a fresh staging directory under the service home. It
checks for the runtime entry point, `scripts/tsx.mjs`, `pnpm-lock.yaml`, and
`protected-client/index.html`. It then swaps the staged tree into `service/`
and removes the previous tree and the archive. Nothing durable lives in
`service/`, so no backup is kept. Leftover `service-update.*` staging state
stops the next update until someone inspects it.

The configuration is a non-writable-by-group/others JSON file with these keys:

| Key               | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `stateDir`        | Existing absolute private state directory; identical to `OPENCLAW_STATE_DIR`.                     |
| `origin`          | Exact HTTPS client origin, without a trailing slash.                                              |
| `port`            | Unprivileged loopback listener port.                                                              |
| `accessIssuer`    | Exact `https://<team>.cloudflareaccess.com` issuer origin.                                        |
| `accessAudience`  | Access application audience.                                                                      |
| `allowedSubjects` | Legacy subjects imported once into admission storage; not a runtime allowlist.                    |
| `ownerSubject`    | Optional verified Access subject permitted to administer access. Admin is unavailable without it. |
| `testClientId`    | Optional Access service-token client ID for the hidden test user.                                 |
| `sparkySecret`    | `{"source":"env","provider":"default","id":"SPARKY_API_KEY"}`.                                    |
| `storageLimits`   | Integer byte limits: `userBytes`, `globalBytes`, and `freeFloorBytes`.                            |

Provision the Sparky key from the isolated service secret source. Never put a
key, token, or refresh credential in this JSON file. Do not copy personal Grogu
state or configuration. The profile/session stores are OpenClaw's canonical
stores inside this isolated state directory.

Initialization measures free space on the state volume. It reserves a 512 MiB
free-space floor and takes at most one-sixteenth of the remaining space, capped
at 256 MiB, for the Alcove budget. Each profile is limited to one-quarter of
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
own `BRAVE_API_KEY`). The Sparky key is not a search credential, and Alcove does
not inherit provider keys or configuration from personal Grogu.

A turn can run for up to 15 minutes, because Sparky with Ultra reasoning can
take several minutes to write a widget. While a turn runs, the turn stream sends
a blank line every 15 seconds. The blank line keeps the Cloudflare tunnel from
closing a quiet response, and clients skip it. A provider failure reaches the
client as a code and a fixed message, without provider text: `provider_busy`,
`rate_limit`, `provider_timeout`, `provider_rejected`, `plan_limit`,
`chat_too_long`, `model_unavailable`, or `provider_failed`. Sparky limits
concurrent requests for each key. If Alcove uses the same Sparky key as personal
Grogu, the two services share that limit, and Alcove reports `provider_busy`
while personal Grogu is busy. Give Alcove its own Sparky key.

After admission, a turn continues if the browser disconnects or the phone sleeps.
The runtime saves the reply without an attached reader. Request credentials stay
in memory for that turn, never in the saved chat. Stop, logout, revoked access,
session expiry, the turn timeout, and listener shutdown still interrupt work.

`GET /api/protected/v1/chats/:id` includes `activeRun: { id }` while a turn runs,
but only for the profile and Access session that started it. Clients can read
the chat again to find the saved reply. This does not replay the stream or start
another model request. Another Access session can read its user's chat, but it
does not receive the run ID. Active runs do not survive a listener restart.
Updates drain or interrupt them before the new listener starts.

## File encryption API

The internal `createProtectedHttp` API accepts a host-owned `encryption` handle
from `createStorageValueEncryption`. With that handle, authorized user files use
AES-256-GCM and a fresh data key for each write. The service key wraps each data
key. Both the wrapped key and the content are bound to the canonical profile.
Moving a file within that profile does not require re-encryption.

The file owner preserves its path, directory-identity, link, and authority checks.
Reads reject plaintext, damaged content, the wrong key, and content copied from
another profile. File limits and returned sizes describe plaintext bytes. Quotas
include the encrypted size, which adds 96 bytes per file. The caller must retain
the handle until requests settle, then dispose it.

This API does not enable encryption in `main.ts`. The deployed service still
stores plaintext. Key provisioning, migration, and encryption of canonical chats
remain separate work. Do not enable a managed-encryption indicator or point an
encrypted file scope at existing plaintext files.

## Verification and release gates

The focused HTTP boundary fixture uses loopback HTTP, synthetic identities, and
real profile and chat storage. Run it from the checkout with Node 26.12.1:

```sh
env -i PATH="$PATH" HOME=/absolute/isolated-home \
  OPENCLAW_STATE_DIR=/absolute/isolated-home/state \
  OPENCLAW_CONFIG_PATH=/absolute/isolated-home/openclaw.json \
  /usr/bin/sandbox-exec -p \
  '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))' \
  node --import ./scripts/tsx.mjs --test --test-concurrency=1 \
  grogu/protected/access-http.test.ts grogu/protected/policy-sync.test.ts \
  grogu/protected/usage-retention.test.ts
```

This example uses macOS network isolation; elsewhere, use an equivalent
network sandbox. Use a task-owned isolated HOME and state. Do not run the broader HTTP fixture
until its provider interception and network isolation are in place.
This proves neither a real provider nor the Access identity response. The
authoritative client DTOs are exported from `@openclaw/gateway-protocol/protected`.

The isolated listener may be installed and checked with an empty admission
store. Keep admission deny-all until the Cloudflare
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
adds an exact subject to canonical admission storage. Stop the protected listener
before this maintenance and restart it afterward; active turns can be interrupted.
The deployment wrapper performs this stop and restart for `--add-subject`.
`test-client CLIENT_ID` admits one Access service token as a hidden
development user, and `test-client none` removes it. Both take effect after a
protected listener restart. The runtime accepts that token only when the Access
token names the exact client ID and the live identity response confirms it. The
user gets the subject `service-token:CLIENT_ID`, which cannot match a person.
That subject gets its own profile and storage, like any other user. The future
account directory and sharing must exclude it. To revoke the test user, delete
the service token or its Access policy, or run `test-client none` and restart.
For owner-driven revocation, stop the listener before invoking
`revoke-profile PROFILE_ID` and restart after it succeeds; the canonical denial
survives the restart. `GET /healthz` reports listener readiness without user data.
