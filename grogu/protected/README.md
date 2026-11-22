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

The owner can see when each person last made an admitted app request. Automatic
app refreshes also count as activity. The timestamp remains with the admission
record and contains no message or file content.

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
`dist` contents there, not the separate client checkout. Keep the build's hashed
entry and shared asset names unchanged; they do not have to start with `index-`.
The listener requires
`protected-client/index.html` before it starts. Then use Node 26.12.1:

```sh
OPENCLAW_STATE_DIR=/absolute/private/state \
OPENCLAW_CONFIG_PATH=/absolute/private/config/openclaw.json \
node --import ./scripts/tsx.mjs grogu/protected/main.ts /absolute/private/config/protected.json
```

For production, run `pnpm build` from the exact source revision being packaged.
Include the complete generated root `dist/` and workspace package build outputs
in the runtime archive, alongside that source and the client build. The source
entrypoint uses the production workers when `dist/` is present; an incomplete
build stops startup. If `dist/` is absent, source-only development continues to
use TypeScript workers. Never combine workers and source from different builds.
The installed launcher does not need to change.

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

`GET /api/protected/v1/storage/chats` lists the signed-in member's chats by
estimated size, largest first. Each estimate uses the same transcript, file,
and overhead charges as the quota. `usedBytes` also counts transient child work,
which is not a separate cleanup item. `limitBytes` is the member's configured
limit, not the host's free disk space. To delete a reviewed chat, send its
`version` in `If-Match` to the existing `DELETE /api/protected/v1/chats/:id`
route. Read storage again after deletion to show the new total.

## Automation discovery and draft validation

`GET /api/protected/v1/automations/catalog` is authenticated feature discovery.
It returns the public protected-agent catalog, the configured Sparky model and
its supported reasoning levels/default, and capabilities. `/me` remains
unchanged for strict older clients. If Sparky or its reasoning catalog is
unavailable, the automation catalog route returns 404; older servers also
return 404, so clients can keep the feature unavailable without breaking sign-in.
At this stage only `catalog` and `draftValidation` are true; list, create,
schedule control, run, sharing, and notification capabilities are false. The
catalog advertises interval and fixed calendar schedules for draft validation
only. This does not enable listing, saving, starting, pausing, or running
automations.

`POST /api/protected/v1/automations/drafts/validate` accepts an in-memory draft:
`name`, `instructions`, `whenToNotify`, optional `doneWhen`, `agentId`,
`model: { provider: "sparky", id }`, optional `thinking`, and
either `schedule: { kind: "every", everyMs }` or the advertised fixed
`schedule: { kind: "cron", expr, tz }` shape. The protocol also defines
saved-record DTOs for the future owner-enabled surface, but these types do not
enable or mount automation routes. A catalog advertises only schedules
supported by draft validation; its schedule kinds do not indicate that a
schedule can be saved or run. The stateless validator accepts only the daily,
weekdays, and Saturday cron forms advertised in the catalog. Names are limited
to 80 JavaScript
string code units; instructions to 16,384 UTF-8 bytes; notification rules to
4,096 UTF-8 bytes; completion rules to 2,000 code units; and the normalized
definition to 32,768 UTF-8 bytes. The request body is capped at 48,000 bytes.
Agents, Sparky model ID, and thinking levels must match the live catalogs.
Omitted thinking uses the catalog's actual default.

Valid input returns `{ valid: true, draft }`, including the resolved thinking
level. Invalid input returns `{ valid: false, errors }` with field, code, and
message entries. Schedule intervals are checked against the native Cron
schema's technical range of 1 through 8,640,000,000,000,000 milliseconds; this
does not enable scheduling or recommend a cadence. This route does not call a
model or provider, save a draft, create a schedule, or produce a run. There is
no automation list or persistence route yet.

The fixed calendar draft-validation contract uses schedules of
`{ kind: "cron", expr, tz }`. The currently designed choices map to
`m h * * *` (daily), `m h * * 1-5` (weekdays), and `m h * * 6` (Saturday), in
`America/Los_Angeles`, at minute precision with `staggerMs: 0`. Nonexistent
spring-forward local times are skipped; repeated fall-back local times run
once at the first occurrence. “Every week” and “Twice a day” remain
unsupported until their semantics are defined. The catalog nests
`cron: { format: "5-field", repeats, timeZones, timePrecision: "minute",
staggerMs: 0, daylightSaving }` under `schedule`; this is validation metadata,
not evidence that an automation can be saved or dispatched. Native Cron owns
the DST behavior, and its isolated schedule tests cover the advertised
`America/Los_Angeles` zone.

The inactive owner-operation DTOs use one full record shape for list rows,
detail reads, and every `{ automation }` mutation response: the draft fields
above plus `id`, opaque `version`, `enabled`, `state: "active" | "paused"`, and
`nextCheckAt: string | null`; records include the resolved effective
`thinking` level. Create uses the full draft body; patch uses its partial form
and does not change enabled state. Omitted patch fields are retained;
`doneWhen: null` clears that rule and `thinking: null` resets to the catalog
default. The proposed owner routes are
`GET /automations`, `GET /automations/:id`, `POST /automations`,
`PATCH /automations/:id`, `POST /automations/:id/start`,
`POST /automations/:id/pause`, and `POST /automations/:id/run`. Mutations use
`If-Match`; create starts paused. None is mounted until the protected-to-Gateway
trust and native durable ownership boundary are approved and implemented.

The default Sparky route can fetch known public URLs with OpenClaw's `web_fetch`
and display the resulting sources. It does not have a search provider;
`web_search` is disabled. Managed search would require a separately approved
search plugin and isolated credential or endpoint (for example, Brave with its
own `BRAVE_API_KEY`). The Sparky key is not a search credential, and Alcove does
not inherit provider keys or configuration from personal Grogu.

`GET /api/protected/v1/me` lists the fixed models and their supported reasoning
levels. A signed-in profile can send its Copilot access token to
`POST /api/protected/v1/providers/github-copilot/models` to list the chat models
available to that account. The token is used for that request only. Turns may
select a listed model and reasoning level; unavailable choices are rejected.
`thinking.nativeChoices` groups aliases for the same model effort.
`thinking.orchestrationLevels` lists harness modes such as `ultra` separately.
An absent native list means that the model's native choices are unknown.
The existing `levels` and `default` fields still control turn admission.
When context usage is available, the final stream includes a `usage` event and
the chat response includes the latest completed reply's usage.
Both include optional `inputTokens` and `outputTokens` for the latest parent
turn, summed from its saved provider calls. The existing `contextTokens` remains
the latest call's context size. Unknown counters and adapter-default zeros are
omitted, as in native run usage. Admin usage totals do not change.

Reasoning is streamed as append-only `reasoning` text events when the provider
exposes it. Tool activity uses `activity` events with a safe label and a running,
done, or failed status. Saved replies include available reasoning, tool activity,
and duration. Chat summaries include `activeRun` only for the Access session
that started the active turn.

A turn can run for up to 15 minutes, because Sparky with Ultra reasoning can
take several minutes to write a widget. While a turn runs, the turn stream sends
a blank line every 15 seconds. The blank line keeps the Cloudflare tunnel from
closing a quiet response, and clients skip it. A provider failure reaches the
client as a code and a fixed message, without provider text: `provider_busy`,
`rate_limit`, `provider_timeout`, `provider_rejected`, `plan_limit`,
`chat_too_long`, `model_unavailable`, `thinking_unavailable`, or `provider_failed`.
Sparky schedules concurrent requests and can queue them or reject them when busy.
If Alcove and personal Grogu share a Sparky key, they also share its provider-side
scheduling and quotas. A busy Grogu does not by itself mean that Alcove requests
will fail. Alcove reports `provider_busy` when the provider rejects admission.

After admission, a turn continues if the browser disconnects or the phone sleeps.
The runtime saves the reply without an attached reader. Request credentials stay
in memory for that turn, never in the saved chat. Redaction protects request
credentials while a turn is active and releases their entries when the last
turn using them ends, unless another owner registered them. Stop, logout,
revoked access, session expiry, the turn timeout, and listener shutdown still
interrupt work.

One run-owned authority gates every published text, source, widget, and widget
draft with synchronous expiry, local revocation, logout, and cancellation checks.
Remote Access validation and its canonical SQLite access-record check run at the
existing five-second lifecycle interval and explicit run boundaries, not once
per chunk. Overlapping validations share one pending operation. A failed remote
validation aborts the run; completion still requires a remote validation. Remote
revocation is detected at the next lifecycle check, including its bounded network
request, while locally published invalidation takes effect immediately.

Each admitted turn writes one `[protected-turn-timing]` console record on
completion. It contains only elapsed milliseconds from request handling start:
`admissionMs`, `providerRequestStartMs`, `firstProviderOutputMs`,
`firstClientVisibleOutputMs`, and `completionMs`, plus `accessChecks`,
`accessValidationMs`, and the fixed `complete`, `failed`, or `interrupted`
outcome. Missing phases are `null`. Provider start is model lifecycle dispatch,
not a wire-level fetch timestamp; provider output is the first SDK tool-call start
or nonempty text, reasoning, or tool delta, not headers or a keepalive. Client-visible output marks
the first content event successfully enqueued for an attached reader, not browser
receipt or paint. Detached completion therefore may have no client-output time.
The record has no content, credentials, provider/model names, or user/session/run
identifiers. Protected model-request telemetry remains disabled. Reasoning and
provider startup are separate from publication overhead; these timings do not
change the model or its reasoning defaults.

On the macOS host, the operator can read up to 20 recent timing records with
`sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run turn-timings`.
The command returns only the numeric timing fields. It prints nothing when no
recent records are available.

`GET /api/protected/v1/chats/:id` includes `activeRun: { id }` while a turn runs,
but only for the profile and Access session that started it. Clients can read
the chat again to find the saved reply. This does not replay the stream or start
another model request. Another Access session can read its user's chat, but it
does not receive the run ID. Active runs do not survive a listener restart.
Updates drain or interrupt them before the new listener starts.
Saved terminal model failures appear in the chat as a failed assistant message
with fixed, classified guidance. Provider error text is never returned.

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

## Protected chat agents

`GET /api/protected/v1/agents` returns the runtime-owned catalog. `travel` is the
default for new chats and for older chat entries without a selection. Choose
`general` ("Just chat") for a generic conversation with the same protected tool
ceiling; this does not change existing selections or the Travel default. The
catalog also includes the narrow `research` role, which can fetch and summarize
user-selected sources. The response includes public names, descriptions, and
tool ceilings, never the server-owned instructions. The service owner can add
entries through the `agentExtensions` option to `createProtectedHttp`; extension
IDs must be unique, and their tools can only be chosen from the protected
runtime's existing tool ceiling.

`POST /api/protected/v1/chats` accepts an optional `selectedAgentId`.
`PATCH /api/protected/v1/chats/:id/agent` accepts the same field and requires
the current chat version in `If-Match`. Selection changes are rejected while
the chat is running. The selected ID is persisted in the canonical session
entry and returned as `selectedAgentId`; changing it updates the chat version.
If a later deployment removes an extension that a chat selected, turns fail
closed until the user selects an agent still present in the catalog.
The selection supplies only server-owned prompt instructions and a restrictive
tool ceiling. It does not change the protected OpenClaw agent identity or grant
permissions beyond the protected runtime's existing policy. Travel can also
list and read chats owned by the same profile, and steer an active permitted
chat while the current request remains authorized. Session tools recheck the
profile and exact chat incarnation; another profile's chats are unavailable.
Steering cannot start an idle or detached run.

`POST /api/protected/v1/chats/:id/turns` accepts an optional `mentions` array of
up to four distinct, available agent IDs other than the selected agent. Each
mention runs as a native child of that turn, using the same profile, admitted
provider credential, file boundary, and deadline. Child work is not detached:
child transcript and file bytes count against the initiating profile while
present. These temporary children do not count as retained chats or change
the reported last retained chat activity. The turn saves each completed result as an assistant message with its
agent ID, removes the child's exact file directory, then lets native cleanup
delete the child without archiving it. Stopping, revoking access, timing out, or
shutting down also cancels the child. A listener restart does not resume
children; it removes files and sessions only when the exact parent, profile, and
session generation still match. Run this cleanup before rolling back to an
older service version, which does not recognize the transient-child
classification.

## Verification and release gates

The focused HTTP boundary fixture uses loopback HTTP, synthetic identities, and
real profile and chat storage. On macOS, run it from the checkout with Node
26.12.1:

```sh
PATH="$HOME/.local/share/fnm/node-versions/v26.12.1/installation/bin:$PATH" \
  caffeinate -ims "$HOME/.local/bin/heavy" -- bash grogu/protected/test-http-isolated.sh
```

The launcher denies non-loopback network traffic for the entire test process,
including work that outlives a test. Direct and unsupported invocations fail
before the fixture runs.

Run the administration boundaries with separate isolated state:

```sh
proof="$PWD/.artifacts/protected-proof-$$"
node26="$HOME/.local/share/fnm/node-versions/v26.12.1/installation/bin"
mkdir -m 700 -p "$proof/home" "$proof/state"
trap 'rm -rf "$proof"' EXIT
caffeinate -ims "$HOME/.local/bin/heavy" -- env -i \
  PATH="$node26:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$proof/home" TMPDIR="$proof" \
  OPENCLAW_STATE_DIR="$proof/state" OPENCLAW_CONFIG_PATH="$proof/state/openclaw.json" \
  /usr/bin/sandbox-exec -p \
  '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))' \
  node --import ./scripts/tsx.mjs --test --test-concurrency=1 --test-timeout=90000 \
  grogu/protected/access-http.test.ts grogu/protected/policy-sync.test.ts \
  grogu/protected/usage-retention.test.ts
```

This example uses macOS network isolation; elsewhere, use an equivalent
network sandbox. Use a task-owned isolated HOME and state.
This proves neither a real provider nor the Access identity response. The
authoritative client DTOs are exported from `@openclaw/gateway-protocol/protected`.

`grogu/protected/http-streaming.test.ts` is a network-free owning-boundary proof
with real isolated profile/chat storage and deterministic stub output. Run it
with the same isolated Node environment above instead of the full provider
fixture. It proves chunk publication and durable completion, immediate local
invalidation, coalesced validation, five-second remote revocation, and the timing
record's privacy boundary. Its synthetic identity-latency accounting is a model
of delivery overhead, not a measured Cloudflare or Copilot response time.

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
The protected admission and usage tables are first-use state. Normal startup
accepts prior-version state without these tables or their indexes, then the
protected admission worker creates them before it migrates configured subjects.
Access session and denial tables follow the same first-use contract. Doctor
accepts older personal Gateway stores without them; the access worker creates
them when the feature first runs.
This upgrade keeps the shared schema version and existing state unchanged.
`init --deploy-json FILE` creates the deny-all configuration; `add-subject UUID`
adds an exact subject to canonical admission storage. Stop the protected listener
before this maintenance and restart it afterward; active turns can be interrupted.
The deployment wrapper performs this stop and restart for `--add-subject`.
The command holds the native state-owner lock while it changes admission.
It refuses the change if the listener or another process owns that state.
`test-client CLIENT_ID` admits one Access service token as a hidden
development user, and `test-client none` removes it. Both take effect after a
protected listener restart. Strict Access gives a service token no cookie,
strips its `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, and
refuses its assertion at `get-identity`. The test harness therefore sends those
headers to the exact protected origin together with test-only copies,
`X-Grogu-Test-Client-Id` and `X-Grogu-Test-Client-Secret`. The copies never
authenticate alone. The runtime accepts the request only when a valid Access
assertion names the configured client ID and the copied ID matches it. To check
that Access still accepts the credential, the runtime sends a new request to
`/api/protected/v1/access-proof` on that origin, with a random challenge and only
the standard credential headers. That route checks the newly issued assertion
locally and echoes the challenge with `no-store`. A redirect, a cacheable reply,
a different challenge, or a missing or different assertion denies the request.
The test session ID is a hash of the client ID and secret, so it stays the same
across assertions and changes when the secret is rotated. Signing out lasts
until the secret is rotated. The raw secret is
kept only in memory for the request. The
user gets the subject `service-token:CLIENT_ID`, which cannot match a person.
That subject gets its own profile and storage, like any other user. The future
sharing feature must exclude it. To revoke the test user, delete
the service token or its Access policy, or run `test-client none` and restart.
For owner-driven revocation, stop the listener before invoking
`revoke-profile PROFILE_ID` and restart after it succeeds; the canonical denial
survives the restart. `GET /healthz` reports listener readiness without user data.

## Accounts and people

`GET /api/protected/v1/account` returns the signed-in person's profile and
directory settings. `PUT /api/protected/v1/account/name` saves a `displayName`
of 1 to 40 characters. `PUT /api/protected/v1/account/directory-settings`
saves a `description` of up to 140 characters and a Boolean `hidden` value.
These are separate saves. Neither endpoint accepts another person's ID.

`GET /api/protected/v1/people` returns eligible people with their ID, display
name, and description. It returns up to 100 people and a `nextCursor`. If the
cursor is not null, pass it as the `cursor` query parameter for the next page.
The directory does not include email addresses or identity claims. People are
listed by default. Hide me removes a person from the directory. It does not
revoke a share. The development identity is always hidden and receives an
empty directory, even if its stored settings say otherwise.

Directory membership follows current canonical admissions, not later edits to
the legacy `allowedSubjects` configuration. Names use the canonical profile store. Directory settings use the existing
profile preferences store. They remain after logout or access revocation and
follow the existing profile merge and deletion rules. A revoked or no longer
allowed identity is not listed. Older versions ignore the directory settings
and do not provide this API. They cannot enforce Hide me for a separate
directory implementation.
