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
Choose an allow policy dedicated to this app. A reusable policy must be attached
only to this app. The token needs Cloudflare's `Access: Policies Write`
permission. The token's Cloudflare
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
inspection instead of being overwritten.

To update the previously installed helper, place the reviewed new
`protected-policy-helper.py` in the same private staging directory. Run:

```sh
sudo /bin/bash grogu/deploy/protected-bootstrap-macos.sh \
  --operator USER --staging-dir /absolute/private/staging --update-policy-helper
```

The update replaces only the Python helper when the installed and staged
digests match the installer's pins. It preserves the wrapper, configuration,
and sudoers file. It makes no Cloudflare request.

Before each policy write, the app
records a recovery barrier in its state database. A crash or an unknown outcome
blocks later policy writes until the owner requests reconciliation. The helper
reads the policy before it applies the current admission. Cloudflare does not
provide an atomic cross-system commit here. Its policy can temporarily disagree
with the app during repair. The app denies a removed person throughout.
The owner sees a pending policy state during an active write. The blocked status
means that the barrier needs reconciliation, not that a write is in progress.

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
free-space floor and takes one-sixteenth of the remaining space as the shared
member budget (`globalBytes`). The default member limit (`userBytes`) is
512 MiB, or the shared budget if that is smaller. The owner can set a different
limit for one member; see "Member storage limits" below. The owner has no member
limit and is not stopped by the shared budget, but the owner's data still counts
toward it, and the free-space floor applies to everyone. When the shared budget
is full, members get `413 quota_exceeded` with a message that names the server's
shared storage, not their own limit. The runtime counts canonical chat/transcript bytes and files in
each chat's directory, including widgets and fetched artifacts. It also counts
member memory notes, even after their chats are deleted, and counts
each saved automation definition against its owner profile and the global
budget. Automation storage uses its stored ciphertext bytes and the same 4 KiB
entry overhead as stored files. The runtime limits growth per operation and
reserves quota before writes so concurrent requests stay within the configured
limits. If a quota is reached, delete a chat or reduce a saved automation
definition to free space, or contact the server operator. The runtime does not
evict chats or keep backups. A volume below its floor stops accepting writes
until space is available. Chat deletion remains available.

Member removal retires deleted response ratings, sharing links and grants in the warmed quota
ledger as part of committed removal publication, including grants charged to
other members. Clearing a whole-chat report reference releases its ciphertext
charge immediately; its retained consent row keeps the existing entry overhead.
Report descriptions and retention are unchanged. No restart or rescan is needed.

An answer can finish with a widget and no closing text. When the native agent
confirms successful terminal tool execution, Alcove saves a completion receipt
in the canonical transcript. The receipt completes the existing reply after
reload and does not become another chat bubble or provider message. An ordinary
tool call or saved widget alone does not prove completion. If the final widget
provides a closing note, Alcove saves the note in its completion receipt and
delivers it once after the widget, without another model request. Tool-only
turns without a receipt retain their recorded status.

A model's explicit completion or a qualified terminal receipt also completes
earlier visible tool-call fragments in the same user turn. A child result or
a later user turn does not complete unfinished parent output. Saved errors
and interrupted replies keep their failure or interruption status.

`GET /api/protected/v1/artifacts` lists saved widgets, fetched files, and
generated files for the signed-in member. Send the current profile ID in
`X-Grogu-Profile`. Each page contains at most 100 entries and an optional
`nextCursor`. Pass that value as `cursor` to read the next page. Entries sort by
chat update time, newest first, then chat ID, kind, and artifact ID. The
`updatedAt` value is the chat update time, not the artifact creation time.
Concurrent chat changes can change the order between pages.

File entries use `id`, `name`, and `size`. Widget entries use `id` and `title`.
Both include `kind`, `chatId`, `chatTitle`, `updatedAt`, and `version`. `version`
is an opaque string that changes when the artifact's content changes: the
SHA-256 digest of a file's bytes, and the id of a widget (saved widget documents
are immutable, so a changed widget is a new id). Read files through
`GET /api/protected/v1/files/:id` and widgets through
`GET /api/protected/v1/chats/:chatId/widgets/:id`. These routes check chat
ownership again. File responses are downloads, not HTML pages.

`GET /api/protected/v1/chats/:chatId/artifacts` returns the same page shape for
one chat. It needs `X-Grogu-Profile`, returns the same 404 as the chat for a
foreign or missing chat, and also returns 404 for a side chat when the client
did not negotiate `side-chats-v1`. `GET /shared/chats/:owner/:chat/artifacts`
returns entries with `version` too, under the existing shared-chat checks.

A widget in a message and in the `widget` stream event may carry `replaces`, the
id of the newest earlier widget with the same title in that chat. The runtime
derives it; the model-facing `show_widget` tool is unchanged. A side chat's
chain starts after the forked prefix, so it never points at the parent's
widgets. The `child-widget` stream event has no `replaces`; clients use the same
title rule for those.

`GET /api/protected/v1/storage/chats` lists the signed-in member's chats by
estimated size, largest first. Each estimate uses the same transcript, file,
and overhead charges as the quota. `usedBytes` also counts saved automation
definitions and transient child work. Neither is listed as a chat. `limitBytes`
is the member's effective limit, not the host's free disk space. It is `null`
for the owner, who has no limit. To delete a
reviewed chat, send its `version` in `If-Match` to the existing
`DELETE /api/protected/v1/chats/:id` route. Read storage again after deletion to
show the new total.

### Member storage limits

The owner reads a member's limit with
`GET /api/protected/v1/admin/people/:id/storage-limit`, where `:id` is the
person ID from `/admin/people`. The response has `usedBytes` (`null` before the
member's first sign-in), the effective `limitBytes` (`null` when `exempt`),
`defaultLimitBytes`, `customLimitBytes` (`null` for the default), `exempt`
(`true` for the owner), `minLimitBytes` (16 MiB), `maxLimitBytes` (the shared
budget), and an opaque `version`.

To set a limit, send `PUT` with the current `version` in `If-Match` and the JSON
body `{ "limitBytes": N }`. To restore the default, send `DELETE` with
`If-Match`. Both return the new state. The server checks the owner's live grant
again just before the write. Errors: `428 version_required`,
`409 version_conflict` (reload and retry), `409 limit_exempt` (the owner),
`400 invalid_limit` (the message names the allowed range), and
`404 person_not_found`. The value is stored in the shared state database and is
deleted when the person is removed. A limit below current use deletes nothing;
it stops further growth with `413 quota_exceeded`.

Existing installs keep the limits that `init` measured. To apply the current
policy (512 MiB default, no 256 MiB shared cap), run the following command and
then restart the listener:

```sh
sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run refresh-storage-limits
```

### Remove legacy `web_fetch` spill files

Older runtimes saved truncated `web_fetch` output under each chat's
`web-fetch/` directory. The artifacts API discovers files directly from the
member file owner and skips missing files; it has no spill manifest to repair.
Chat transcripts remain unchanged.

Stop the listener before updating the protected runtime. Before restarting it,
preview matching paths with:

```sh
sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run cleanup-web-fetch-spills --dry-run
```

Run the same command without `--dry-run` to delete only files named
`web-fetch-<uuid>.log` with a canonical lowercase UUID v4 under
`chats/<chat-uuid>/web-fetch/` for every member. Other files and nonmatching
directories survive. An emptied `web-fetch/` directory is removed
non-recursively. Removal is immediately reflected in the live file-based quota;
no transcript, chat, shared database, or artifact manifest is modified. The
operation is idempotent and needs no schema migration or backup. The installed
maintenance helper dispatches to the updated runtime source, so no helper
reinstallation is needed after `update`; restart the listener after the
operation.

### Member memory

Grogu and Travel chats can save and search the signed-in member's memory. Notes
are shared across that member's chats, not with other members or personal Grogu.
The service encrypts notes as member-owned files; the running service and its
administrator can read them. Search uses a temporary in-memory keyword index,
not a paid embedding service. Existing chats are not backfilled.

Ordinary chats, itineraries, automation instructions, and run details do not
need memory notes. Grogu saves short personal context only when it can help
future chats. The memory tool rejects entries over 500 characters and skips
exact duplicates. Existing notes remain unchanged.

Clients opt in with `x-alcove-capabilities: memory-v1`; `/me` then reports
`capabilities.memory.review`. To review notes, send `x-grogu-profile` with the
current profile ID to `GET /api/protected/v1/memory`, then read a listed note at
`GET /api/protected/v1/memory/:id`. List entries contain `id`, `name`, `bytes`,
and `updatedAt` in epoch milliseconds; reads return `{ note, text }`. Note IDs
are opaque and change when the service restarts. Refresh the list after a 404.
An account mismatch returns 403 `profile_mismatch`; an unavailable review owner
returns 503 `unavailable`.

Clients that support deletion opt in with `memory-v2`. The memory capability
also includes `delete`, and note reads include an opaque `revision`. Send that
revision in `If-Match` to `DELETE /api/protected/v1/memory/:id`. The service
returns 204 when it removes the selected file. It returns 428
`precondition_required` without a revision and 409 `memory_changed` when the
file changed. Reload the note before trying again. A legacy daily file can
contain several memories. Deleting it removes the whole file, not just one
entry. Notes do not record a reliable source chat, and deleting a note does
not delete a chat. The accepted design is recorded in
[the maintainer discussion](https://github.com/Bokanovskii/grogu-openclaw/issues/180#issuecomment-7108651602).

`PATCH /api/protected/v1/chats/:id/title` renames the signed-in member's chat.
Send the current chat `version` in `If-Match` and a JSON body with `title`.
The title must be a nonblank string of at most 160 UTF-16 code units before
trimming. The server saves the trimmed title in the canonical session display
name and returns `{ chat }` with its new version. Messages and the selected
agent remain unchanged. A later chat read, list, export, or storage view uses
the saved title.

The route returns 428 without `If-Match`, 422 with code `invalid_title` for
an invalid title, 412 with code `version_conflict` for a stale version, and
409 with code `busy` while the chat runs or another mutation holds it.
Another member's chat returns 404. Clients without rename support remain
unchanged; the existing create, agent-selection, and delete contracts do not
change.

### Chat sharing

Clients opt in with `x-alcove-capabilities: sharing-v1`; `/me` then reports
`capabilities.sharing`, which is false for the development identity. Without the
capability every sharing route returns 404 and `/me` is unchanged. All routes
require `x-grogu-profile`.

The owner creates or reads a chat's single link with `POST` or `GET
/api/protected/v1/chats/:id/share`. The link `path` is `/s/<id>`, where the id is
32 random bytes in base64url and does not depend on the title. Another admitted
member opens it and the client calls `POST /api/protected/v1/shares/:id/claim`,
which records a durable read-only grant. Recipients list their grants with
`GET /api/protected/v1/shared/chats` and read the owner's live chat, artifacts,
files, and widgets under `/api/protected/v1/shared/chats/:ownerId/:chatId`.
They cannot write to, run, or pay for the chat.

`DELETE .../share/recipients/:personId` removes one recipient and rotates the
link, so the removed member cannot claim the old URL again. `DELETE
.../share` disables the link and revokes every grant. Renaming keeps the link.
Deleting the chat or removing either member from Alcove removes the link or
grants. Every shared read checks the grant, both members' admission, and that
the chat still exists, so a deleted chat is denied even before its grant rows are
gone. Grant rows for chats that no longer exist are removed on the next claim or
shared-chat list.

Links are charged to the owner and grants to the recipient as one 4 KiB storage
entry each. The tables store only profile, chat, and link ids, and no chat text.
`grogu/protected/sharing-store.ts` exports `canMemberReadChat` and
`canMemberReadChatArtifact` for other routes that need the same read authority.

### Side chats

Clients opt in with `x-alcove-capabilities: side-chats-v1`; `/me` then reports
`capabilities.sideChats: true`. Without the capability `POST .../side` returns
404, side chats are left out of `GET /chats`, export, artifacts, and files, and
chat reads omit `side`.

`POST /api/protected/v1/chats/:parentId/side` requires `x-grogu-profile` and a
body of `{requestId, title?, selectedAgentId?}`. It reads the parent through the
normal chat read authority, so another member's or a missing chat returns the
same 404. It returns 201 `{chat}`, where `chat.side` is
`{parentId, forkedAt: {messageId, messageCount}}`. A replayed `requestId` on the
same parent returns the same chat; on another parent it returns 409
`request_conflict`. Run chats, authoring chats, and parents with no completed
reply return 422 `side_unavailable`. Creating a side chat from a side chat
branches from the same parent, so depth stays one. A side chat counts as a
normal chat for the member's chat quota (413 `quota_exceeded`) and storage.
`selectedAgentId` defaults to the parent's agent.

The side chat is a fork of the parent: its transcript starts with the parent's
visible history up to its last completed reply, copied with the original entry
ids so the prefix stays byte-identical and prompt-prefix caching can reuse it.
Turns on the side chat continue that history. Only a real compaction can
rewrite it. `GET /chats/:sideId` returns just the side chat's own messages;
the client shows the shared prefix from the parent. Feedback reports that include
a side chat attach only its own transcript events, never the parent's. Isolated
automation runs never carry this history, because only chats created through
this route reference a parent.

`DELETE /chats/:parentId` also deletes its side chats and returns 409 `busy`
while the parent or any side chat has a run. Negotiating clients get 200
`{deletedSideChats: [ids]}`; others keep 204. Deleting a side chat deletes only
that chat.

`POST /chats/:sideId/side/return` is the only way a side chat reaches its
parent ("Send to main chat"). It requires `side-chats-v1` and `x-grogu-profile`,
and a body of `{requestId, messageIds: [1-3 ids], note?: up to 500 characters}`.
Each id must be a finished assistant reply of that side chat. The runtime makes
no model call: it appends one assistant message to the parent, with the optional
note first and the replies copied in transcript order. The copied replies are
capped at 12,000 characters and end with a marker when shortened (see
`side-return.ts`). The reply returns `{parent: {id, version}, message}`. The
message carries `sideNote: {chatId, title}` and lists the side chat's widgets
without `replaces`, since the widgets stay in the side chat. They are read
through `GET /chats/:sideChatId/widgets/:id` and disappear if the side chat is
deleted. The parent model sees the copied text on its next turn. A replayed
`requestId` returns the original message; from another side chat it returns 409
`request_conflict`. A chat that is not a side chat returns 422
`side_unavailable`, an unfinished or foreign message id returns 422
`invalid_message`, and a running or changing parent returns 409 `busy`. Clients
without the capability, and recipients of a shared chat, read the message as
plain parent text without `sideNote` or its widgets.

### Public automations

Automation definitions can record `contextAccess` as `isolated` or `member`.
Definitions without the field retain member access, including new definitions
created by existing clients. Isolated runs return 503 until the privacy boundary
is ready. Requests to create isolated definitions also return 503. The later
enablement must default new definitions to isolated access
without changing stored definitions that omit the field. Omitted access never
qualifies an automation for publication.
Only clients that send `automations-context-v1` receive the access field. Those
clients see `capabilities.automations.contextAccess: false` until activation.

Public automation is disabled until the automation origin and model-request
isolation boundary is verified. Clients that send
`x-alcove-capabilities: automations-public-v1` see all three capability flags
(`publish`, `follow`, and `notifications`) set to `false`; public listing,
publication, follow, and notification routes return 503. Existing publication,
follow, and notification rows are retained unchanged, but treated as private.
Only the owner can read automation definitions, runs, lifecycle history, and
inbox entries. Missing or legacy origin information never grants follower
access or delivery.

This restriction does not affect owner access to private automations or
explicit chat-sharing grants. Chat shares remain a separate, owner-granted
read-only permission and do not publish an automation.

## Automation discovery and draft validation

`GET /api/protected/v1/automations/catalog` is authenticated feature discovery.
It returns the public protected-agent catalog (in the `agents-v1` shape when
the request asks for it, as for `/agents`), the configured Sparky model and
its supported reasoning levels/default, and capabilities. `/me` remains
unchanged for strict older clients. If Sparky or its reasoning catalog is
unavailable, the automation catalog route returns 404; older servers also
return 404, so clients can keep the feature unavailable without breaking sign-in.
`catalog` and `draftValidation` are true when the model catalog is available.
`list` and `create` are true only when the protected storage budget is
configured. Without it, list and write routes return 404. Schedule control and
Run now require a running scheduler and the negotiated run capability.
Sharing and notification capabilities remain false.

`POST /api/protected/v1/automations/drafts/validate` accepts an in-memory draft:
`name`, `instructions`, `whenToNotify`, optional `doneWhen`, `agentId`,
`model: { provider: "sparky", id }`, optional `thinking`, and
either `schedule: { kind: "every", everyMs }` or the advertised fixed
`schedule: { kind: "cron", expr, tz }` shape. Saved automations can be enabled
and run when the scheduler is available. The stateless validator accepts only the daily,
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
does not enable scheduling or recommend a cadence. Validation itself does not
call a model or provider, save a draft, create a schedule, or produce a run.

`GET /api/protected/v1/automations` lists the automations the signed-in member
owns, including published ones. `GET /api/protected/v1/automations/:id` reads one owned record,
and `POST /api/protected/v1/automations` saves a validated draft. Creation
always starts paused; an `enabled` field is not accepted on create. `PATCH
/api/protected/v1/automations/:id` accepts partial draft fields and the
canonical optional `enabled` boolean, and requires the current `version` in
`If-Match`. Stale versions return 412. Paused definitions can be edited.
Clients that negotiate `automation-runs-v1` can enable scheduling after the
protected scheduler starts. Other clients cannot enable an automation.
The existing per-profile and global storage budgets cover both operations.
Creation charges the definition's stored UTF-8 bytes and the existing per-entry
overhead. An edit charges only positive definition growth, so an edit that
reduces storage can free budget. Enabling also reserves bounded run-metadata
capacity. A quota refusal returns `413 quota_exceeded` before the state worker
writes.

Clients that send `X-Alcove-Capabilities: automation-delete-v1` receive
`capabilities.automations.delete: true` when deletion is available.
`DELETE /api/protected/v1/automations/:id` requires the current version in
`If-Match`. It returns 428 without a version, 412 for a stale version, and
404 for a missing or foreign automation. A queued or active run or a native
job binding returns 409 `automation_busy`. On success, the server returns 204
and deletes the definition, its run history, results, inbox entries, and
run-chat binding. Deleting a published automation also unpublishes it and
removes its followers and their notification opt-ins in the same transaction,
retiring those follow entries from the followers' storage; a follower's delete
request returns 404. The member's run chat and authoring chat remain available
after deletion. The run chat remains read only.

Run chats are records of automation runs. Member turns, steering, and stop requests
return `409 run_chat_read_only`. Automation runs can still write to their
run chat. Clients that send `X-Alcove-Capabilities: automation-runs-v1`
receive `automationRun: { automationId }` in run-chat list and detail responses.
Deleting a run chat does not delete the automation. Its next run recreates the
chat with the same ID.

Member removal with automation history requires the storage-aware authority
adapter in `admission-store.ts`. Fence and stop the target profile's writers,
and settle enrolled automation publication before calling it. Supply the
current admission revision and accounting profile; worker transaction and commit
grants recheck current configured-owner authority and the writer fence. A changed
target snapshot refuses removal rather than applying a fence for another profile.

The same worker transaction revokes admission, deletes that member's follows and
notification preferences, and unpublishes the automations they own, which
removes every follower. It then deletes that member's private sole-owned
definitions (paused or enabled), lifecycle records, sealed results, run-chat
bindings, inbox entries, and memberships. Its committed receipt carries exact
storage and definition retirements, including follow entries charged to other
followers. Only then does the host settle quota and publish removal; uncertain outcomes stay with the shared recovery owner.
Other members' storage is untouched apart from those follow entries.
The same fenced adapter can retire leftovers for an already-removed admission
using its current revision. That recovery keeps the member removed; it never
grants member write permission or reactivates the account.

Calls without retirement authority support only save-only drafts or legacy
stores without retained automation data. Remaining shared, co-owned, or
native-job-bound automation custody must first be retired or transferred by its
existing owner; removal rolls back rather than leaving it orphaned. This
transaction does not delete actual chats, files, profiles, or native scheduler
jobs.

The internal state owner stores automation definitions, owners, followers,
visibility, the paused/enabled state, and native Cron job bindings in the
shared-state worker. A binding ties one native job to the current central owner
and definition revision. Reads and mutations require an active admission, and
only owners can edit definitions. Other members see published definitions only
through the public automation routes above.
Clients that send `X-Alcove-Capabilities: automation-results-v1` can read
existing finished results at `GET /automations/:id/runs` and
`GET /automations/:id/runs/:runId`. Only owners can read them; foreign and
unknown records return 404.
These routes do not start runs or enable scheduling.
Clients that also negotiate `automation-runs-v1` can enable and pause eligible
automations, start a run with `POST /automations/:id/run`, inspect lifecycle
history at `GET /automations/:id/run-history`, and read the owner's inbox at
`GET /automations/inbox`. Manual runs work while paused and leave the schedule
paused. Scheduled runs require an enabled automation. A first manual run reserves
the same bounded run-metadata capacity as enabling a schedule, within the existing
storage budgets. Runs use the owner's protected turn and one dedicated
chat per automation. At most 50 runs and results per automation and 200 inbox
entries per recipient are retained, oldest first. Push is not started; an inbox
delivery that cannot fit remains pending for retry.
The first release stores no Research Topics reference and does not give
automation turns the Research Topics tool. Automation IDs are canonical
lowercase UUID v4 values; the protocol's `ProtectedAutomationIdSchema` defines
the accepted form.

Unsaved automation chats appear in the member's `GET /chats` list with
`authoring.kind: "automation"` and no `authoring.automationId`. Clients that send
`automations-chat-v1, automations-authoring-v1, automations-draft-recovery-v1`
can use draft recovery when the catalog returns `capabilities.automations.chat.draftRecovery: true`.

Send `{draft}` to `POST /automations/authoring` to create the chat and its first
draft together. `GET /chats/:id` returns `authoringDraft: {draft, draftRevision}`
and `authoringBusy` for an unsaved authoring chat. Reopen the chat and poll this
route while `authoringBusy` is true. The reply and any draft update finish on
the server if the client disconnects. The existing `activeRun` still belongs
only to the sign-in session that started the turn.

To keep form edits without saving an automation, send `{baseDraftRevision, draft}`
to `PUT /chats/:id/authoring-draft`. Creation and checkpoint writes require
`X-Grogu-Profile` for the signed-in member. Use the returned `{draft, draftRevision}` for
the next turn. A chat from an older client can lack a checkpoint. Use `null` as
its first base revision, or start the first recovery turn with revision `"1"`.
A running turn returns `409 busy` for edits. A stale draft returns
`412 draft_mismatch`; reread before applying edits. An explicit save binds the
chat to the saved automation. If an interrupted save left a different saved
definition, the server keeps the newer draft in Chats and reports the conflict.
Older clients receive no new response fields.

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

List, detail, create, and patch responses use the full record shape: the draft
fields above plus `id`, opaque `version`, `enabled`, `state: "active" | "paused"`,
and `nextCheckAt: string | null`; records include the resolved effective
`thinking` level. `nextCheckAt` is the scheduler's armed wakeup in ISO format.
It is null when paused, when the scheduler is stopped, or while no wakeup is armed.
Omitted patch fields are retained; `doneWhen: null` clears
that rule and `thinking: null` resets to the catalog default.

Chat agents can search the public web with OpenClaw's `web_search` and fetch
public URLs with `web_fetch`; the stream shows the resulting sources. Search
uses only the keyless bundled DuckDuckGo provider. It needs no credential, and
no other search provider is enabled. The runtime loads that plugin from the
packaged `extensions/duckduckgo` source because it has no bundled build, so the
runtime archive must include that directory; startup stops without it. The
Sparky key is not a search credential, and Alcove does not inherit provider keys
or configuration from personal Grogu.

`GET /api/protected/v1/me` lists the fixed models and their supported reasoning
levels. A signed-in profile can send its Copilot access token to
`POST /api/protected/v1/providers/github-copilot/models` to list the chat models
available to that account. Clients can request the optional account-reported
`vendor` on models with `X-Alcove-Capabilities: model-vendor-v1`; an absent
vendor is unknown. Clients can request `model-context-v1` to receive
`contextSizes` for Copilot models with distinct provider-reported input limits.
The options include a default and a warning when the longer context can cost more
or cache pricing is unknown. The shorter budget is the default in either case.
Turns can send a listed `contextSize`. OpenClaw uses it as a local context budget,
with room reserved for output. It is not a provider mode or a billing guarantee.
An unavailable size returns `context_size_unavailable`. Omission retains the
existing budget. The token is used for that request only. Turns may
select a listed model and reasoning level; unavailable choices are rejected.
`thinking.nativeChoices` groups aliases for the same model effort.
`thinking.orchestrationLevels` lists harness modes such as `ultra` separately.
An absent native list means that the model's native choices are unknown.
The existing `levels` and `default` fields still control turn admission.
When context usage is available, the final stream includes a `usage` event and
the chat response includes the latest completed reply's usage.
With `model-context-v1`, usage also includes the effective `contextSize` for a
completed turn that selected one. Older replies can omit it.
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
completion. It contains only elapsed milliseconds: `admissionMs` counts from
request handling start; `providerRequestStartMs`, `firstProviderOutputMs`,
`firstClientVisibleOutputMs`, and `completionMs` count from the end of admission.
It also has `accessChecks`, `accessValidationMs`, and the fixed `complete`,
`failed`, or `interrupted` outcome. Missing phases are `null`. Provider start is model lifecycle dispatch,
not a wire-level fetch timestamp; provider output is the first SDK tool-call start
or nonempty text, reasoning, or tool delta, not headers or a keepalive. Client-visible output marks
the first content event successfully enqueued for an attached reader, not browser
receipt or paint. Detached completion therefore may have no client-output time.
`marks` lists fixed step names (for example `memberResolved`, `storageAdmitted`,
`runnerStarting`, `contextAssembled`) with the milliseconds from request handling
start at which the request first reached each step, in the order it reached them.
The gap between two steps is what the later one cost; a step that did not happen
is absent. `turnOrdinal` counts admitted turns since the listener started,
`activeTurns` counts the turns running when this one was admitted (including
itself), and `finishedAtSec` is the Unix time it finished. `storageQueueMs` is the
time the turn waited behind other storage admissions, which share one queue, and
`storageScanMs` is the time it spent measuring stored data (zero when it reused
another admission's measurement); both fall between the `aliasesPrepared` and
`storageAdmitted` steps. They are present only when storage limits are configured.
`modelRequests` counts the turn's finished model requests (the turn itself plus
any specialist it started), and the other `model` fields add them up:
`modelWallMs`; `modelFirstOutputMs`, the time from request start to the first text,
reasoning, or tool output; `modelFirstTextMs`, the time to the first text, so the gap
between the two is time spent on reasoning or tool calls before any text; and the token
counts `modelInputTokens`, `modelOutputTokens`, `modelCacheReadTokens`, and
`modelReasoningTokens`. A total is absent when no request measured it, and requests that
run side by side overlap, so a total can exceed the turn's wall time. When a member-memory
flush makes a model request of its own, these fields do not include it. `toolCalls` and
`toolMs` count the tool calls that finished, from their start to their result, across the turn
and its specialists; calls that run in parallel overlap. `searchMs` and `fetchMs` are the
parts spent in web search and web fetch. Tool names, arguments, and results are not recorded.
`loopBusyMs` is the time the server's main thread spent running code during the turn, and
`loopMaxStallMs` is the longest delay of a 50 ms timer on it (delays under 100 ms count as
zero, and a stall that began before the turn counts from the turn's start). `sqliteWrites`,
`sqliteWriteQueueMs`, and `sqliteWriteMs` count the SQLite writes that finished, the time they
waited for the writer, and the time they took, including each write's wait for the main thread
to admit it, so a long write next to a long stall points at a busy main thread. `transcriptTasks`,
`transcriptQueueMs`, and `transcriptMs` give the same three totals for the transcript worker,
and `workerTasks`, `workerQueueMs`, and `workerMs` for every other worker (for example state
reads, read-only snapshots, and memory). These eleven fields cover the whole server, not only
the turn: they include other members' work in the same period, and requests that overlap add
up, so a total can exceed the turn's wall time. A request's wait counts for the turn in which it
starts and its count and time for the turn in which it finishes; events reach the totals a moment
after the request ends, so the last request before a turn finishes can count toward the next turn.
The worker totals come from the server's diagnostic events, so they stay at zero when the server
config sets `diagnostics.enabled` to `false`.
The record has no content, credentials, provider/model names, or user/session/run
identifiers. Protected model-request telemetry remains disabled. Reasoning and
provider startup are separate from publication overhead; these timings do not
change the model or its reasoning defaults.

On the macOS host, the operator can read up to 20 recent timing records with
`sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run turn-timings`.
The command returns only the numeric timing fields, the fixed outcome, and the
fixed step names. It prints nothing when no recent records are available.

When the runtime fails to start, it writes two lines to its stderr log. The first is
the fixed guidance. The second starts with `Startup failure:`. It names each error in
the `cause` chain (up to four causes) with its class, error code, message (up to 300
characters), and first two stack frames. Credentials are redacted, the input quoted by
JSON parse errors is withheld, and the line has at most 4,000 characters. The operator
cannot read the service account's log directly. To read the last 64 KiB of it, run
`sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run startup-log`.
This command drops a partial first line, redacts credentials, and removes control
characters other than tabs and newlines. It prints nothing when the log is missing or
empty, and it refuses a symlinked or hard-linked log. Apart from that redaction, it
shows the raw log text. This also includes crashes that happen before the runtime can
write its own line, such as module load failures.

`GET /api/protected/v1/chats/:id` includes `activeRun: { id }` while a turn runs,
but only for the profile and Access session that started it. Clients can read
the chat again to find the saved reply. This does not replay the stream or start
another model request. Another Access session can read its user's chat, but it
does not receive the run ID. Active runs do not survive a listener restart.
Updates drain or interrupt them before the new listener starts.
Saved terminal model failures appear in the chat as a failed assistant message
with fixed, classified guidance. Provider error text is never returned.

## Encrypted storage

The protected runtime requires the host-owned 32-byte key at
`$SERVICE_HOME/secrets/storage-key`, outside the state directory and readable
only by the `groguProtected` service account. The bootstrap creates it with mode
`0600`; protected runtime startup and initialization refuse a missing or invalid
key. Never replace an existing key to recover access. Losing the key makes
encrypted chats and files unrecoverable.

The protected shared-state database encrypts stored automation definitions,
secret-store values, and retained Cron content, including job definitions,
state, history, scratch, receipt errors, and diagnostic quarantine payloads.
Storage metadata needed for routing and scheduling remains readable. Personal
Grogu shared state remains plaintext at the upstream schema version.

The service encrypts chat transcript events, session titles and summaries,
session snapshots, queued messages and completion results, trajectories, ACP
parent-stream events, and archived transcripts. Each value uses AES-256-GCM
with its own fresh data key, wrapped by the service key and bound to its owner.
Widgets and other per-user files use the same per-file data-key design. The
server admin can read chats; this protects copied storage files, not a running
service or its administrator.

Subagent task and terminal-result text are excluded from this encryption path:
the companion transient-run lifecycle repair removes their durable retention
and keeps only cleanup identity in `subagent_runs`.

Protected transcript search decrypts a bounded window in the existing reader
worker. It never saves a plaintext search index. Each search reads at most 4,000
recent active message rows and 4 MiB of transcript payloads from permitted chats.
Matches return newest first, without full-text relevance scores. If the scan
reaches a limit, `truncated: true` signals that older matches can be missing.
Narrow to one chat or use `sessions_history` to read older text.
Session reference lookup and deletion safety still use the non-content
projection. User-requested exports can be readable to the user who requested them.

The forward migration verifies encrypted read-back before replacing plaintext
user files. It keeps only a transient encrypted staging copy, atomically
replaces the plaintext file after verification, and removes the staging
directory before startup completes. It checkpoints and vacuums SQLite after
conversion, but this cannot promise forensic erasure from filesystem snapshots,
storage-device remapping, or copies outside the managed state. Grogu keeps no
backups. Interrupted migration can be retried; missing or wrong keys and
unsupported schema versions fail closed rather than reopening the store as
plaintext. Shared-state migration verifies the stored ciphertext within the
transaction before committing it and removing the committed plaintext. If
cleanup is interrupted, startup resumes it before admitting readers.
Secret-store values must fit the existing 64 KiB limit after encryption. A
large plaintext value can prevent migration; the transaction rolls back without
removing it. Reduce the value before retrying.
Protected runtime startup requires an existing encrypted agent database with a
valid key and encryption marker. It refuses a missing or plaintext database
instead of creating or migrating it. Stop the listener and use the maintenance
command below to provision or migrate plaintext state.
Protected encrypted agent databases use schema version 26 so older builds
refuse them. Protected shared-state databases use schema version 21. Ordinary
personal Grogu databases keep the upstream schemas and versions. When merging
this fork with upstream, select unused protected versions above the updated
upstream versions. Update the protected-version contracts, migration checks,
and tests together. Never reuse an upstream number.

### Upgrade an existing installation

Stop the protected listener before running maintenance. The installed
service-owned helper can provision the key and migrate existing plaintext
shared state, the agent database, and per-user files without replacing the root
launcher:

```sh
sudo -n -u groguProtected \
  /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run provision-storage-key
```

The command derives the key path from the validated service home when an older
launcher does not export `OPENCLAW_PROTECTED_STORAGE_KEY_FILE`. It preserves an
existing key, verifies encrypted files before changing the database, and
migrates through the shared-state, agent database, and user-file owners. If the
key is missing but encrypted database or user-file data exists, the command
refuses to create a replacement; restore the original key instead. An interrupted plaintext
migration can be retried with the same key. Startup resumes shared-state cleanup
and repeats the idempotent file migration before opening the listener. Start the
listener again only after maintenance succeeds.

## Protected chat agents

`grogu/protected/agents.ts` owns the agent catalog. Agents share member-scoped
access and a prompt header. Their available skill reader, intent instructions,
packaged skills, example prompts, and presentation hints can differ.

- **Grogu** (`grogu`) is the default for new chats. It is the generic Alcove
  agent with no specialty. Its prompt lists the other selectable agents, and it
  can hand a request to one of them (see routing below).
- **Travel** (`travel`) plans trips. Its `travel-dashboard` skill gives planning
  guidance and an HTML dashboard template for `show_widget`.
- `general` ("Just chat") and `research` are retired. They are not selectable
  for new chats, mentions, or routing, but saved chats that use them keep
  working. Chats saved before agent selection was recorded still use Travel.

Shared tools are `web_search`, `web_fetch`, `show_widget`, `sessions_list`,
`sessions_search`, `sessions_history`, and `sessions_send`. They reach only the
signed-in member's own chats, the public web, and widgets in the current chat.
Session tools recheck the profile and exact chat incarnation, so another
member's chats are unavailable. `sessions_send` can steer only an active
permitted chat while the current request remains authorized; it cannot start an
idle or detached run. Tools that need credentials the service does not hold,
such as image, PDF, speech, video, and music generation, stay off.

Protected turns restrict their tools, so OpenClaw builds its minimal system
prompt and puts the shared Alcove header in its `## Subagent Context` section.
Then it adds `## Current agent:` with the agent's intent, then each `## Skill:`
with its guidance. Main-turn requests with the same date and reasoning level
have the same tool list and the same system text up to `## Current agent:`, for
every member and agent. That makes the header part of a shared prefix that
providers can cache. A shared prefix does not guarantee a cache hit; check
provider usage metrics for that. Mentioned and routed agents run as native
children with fewer tools, so their prefix differs from main turns.

The service sets `agents.defaults.skipBootstrap`, so child runs do not create
`BOOTSTRAP.md` in the shared workspace. Members cannot finish that onboarding.
An existing `workspace/BOOTSTRAP.md` from an older version adds a "Bootstrap
Pending" section to every member's main-turn prompt. To remove it, stop the
service and run:

```sh
sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run retire-bootstrap
```

The command removes the file only if it is the generated default. It keeps an
edited or linked file and refuses without printing its content. If the file is
missing, the command does nothing. It refuses while the listener is running.

To print a bounded metadata-only report of possible archive staging files, run:

```sh
sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run archive-residue
```

The command derives the configured archive and cold roots. It refuses while the
listener or another maintenance operation owns protected state. Every candidate
is reported as `unknown`; writer quiescence is not established, and the command
does not read transcript contents or delete files. This report does not authorize
cleanup.

Skills live in `grogu/protected/agent-skills/<id>/SKILL.md`, with frontmatter
`name` and `description`. A `{{template}}` marker is replaced with that
directory's `template.html`. The prompt includes only the agent's skill names
and descriptions; `skills_read` loads the selected skill's complete guidance
on request without granting general filesystem reads. The runtime archive must include
`grogu/protected/agent-skills/`; the catalog fails to load without it. The
service owner can add agents through the `agentExtensions` option to
`createProtectedHttp`. Extension IDs must be unique.

`GET /api/protected/v1/agents` returns the catalog. Its shape depends on the
`X-Alcove-Capabilities` request header, parsed by `client-capabilities.ts`:

- Without `agents-v1`, the response keeps the exact legacy shape for shipped
  strict clients: only selectable agents, each with `id`, `name`,
  `description`, and the legacy tool list.
- With `agents-v1`, it returns every agent with `selectable`, `examplePrompts`,
  public skill names and descriptions, and `presentation` (`icon`,
  `reasoningIndicator`, and `widgetWidth`). Grogu uses the `grogu-eater`
  reasoning indicator; Travel uses wide widgets.

Both shapes send `Vary: X-Alcove-Capabilities` and never include instructions
or skill guidance. The capability header changes only the response shape; it
grants no access.

`POST /api/protected/v1/chats` accepts an optional `selectedAgentId`.
`PATCH /api/protected/v1/chats/:id/agent` accepts the same field and requires
the current chat version in `If-Match`. Both accept only selectable agents and
otherwise return 422 `agent_unavailable`. Selection changes are rejected while
the chat is running. The selected ID is persisted in the canonical session
entry and returned as `selectedAgentId`; changing it updates the chat version.
If a later deployment removes an agent that a chat selected, turns fail closed
until the user selects an agent still present in the catalog. The selection
does not change the protected OpenClaw agent identity or grant permissions
beyond the protected runtime's existing policy.

A main turn also offers the client tool `route_to_agent` with a selectable
`agentId` and a `brief` of at most 2,000 characters. When the agent calls it
once, its reply ends and the chosen agent runs as a native child with the
member's request and the brief, like a mention. That result is saved below the
reply with the chosen agent's ID. More than one call, an unknown or retired
agent, a route to itself, or an empty or oversized brief fails the turn with
502 `agent_failed`. A routed or mentioned child cannot route again, and core
child policy withholds `sessions_send` from it, so only the chat's own agent
can add messages to another chat.

Clients that send `X-Alcove-Capabilities: specialist-stream-v1` receive child
start, text, widget draft, widget, and error events keyed by child run ID.
Text events replace the child's current text snapshot. A `child-result` follows
the saved result. Chat reads include the same run ID on saved child messages.
Widget references resolve through the parent chat's widget endpoint. Legacy
clients do not receive the new events or the saved run ID.
If a started child ends without a saved result, the turn owner saves a failed
entry with its agent and run ID. Stop and timeout cancel execution, but do not
remove this failure record. The write still requires current member access
and the original parent session generation.

`POST /api/protected/v1/chats/:id/turns` accepts an optional `mentions` array of
up to four distinct, selectable agent IDs other than the selected agent. Each
mention runs as a native child of that turn, using the same profile, admitted
provider credential, file boundary, and deadline. Child work is not detached:
child transcript and file bytes count against the initiating profile while
present. These temporary children do not count as retained chats or change
the reported last retained chat activity. The turn saves each completed result as an assistant message with its
agent ID, removes the child's exact file directory, then lets native cleanup
delete the child without archiving it. Stopping, revoking access, timing out, or
shutting down also cancels the child. Chat deletion returns `409 busy` while a
specialist child of the chat or one of its side chats still needs cleanup.
A listener restart does not resume children. It removes a child and its files
if its generation and registry ownership match and the original parent still
belongs to the same profile, or the parent key is gone and the child's spawn record
confirms both the parent and profile. A reset parent, retained parent history
without a chat entry, or conflicting ownership still stops
startup. Run this cleanup before rolling back to an
older service version, which does not recognize the transient-child
classification.

### Private browser

The browser is off by default. Set `"browser": "fresh"` in `protected.json` to
give interactive member turns four read-only tools: `browser_open`,
`browser_snapshot`, `browser_follow_link`, and `browser_back`. Each turn gets a new,
empty headless Chromium context that the turn closes when it ends. No cookies,
storage, or history survive the turn or are shared between members or chats.

Automation runs, protected automation runs, authoring turns, and routed or
mentioned children never get the tools. The gate uses server-owned turn
context, not client input, and missing context means no browser.

Chromium reaches the web only through a loopback proxy that requires a
per-session secret, allows ports 80 and 443 only, and pins each connection to
an address checked by core SSRF policy, so loopback, private, link-local, and
metadata addresses are refused. Only http and https URLs without embedded
credentials open. Downloads, service workers, popups, permissions, dialogs,
and raw Chrome DevTools access are unavailable. Snapshots are bounded, have
every form field value removed, and reach the model as untrusted external
content. At most four browser sessions run at once, and Chromium exits
after a minute without sessions. Page text and frames are not logged. A listener restart
closes every browser.

The agent cannot type into pages, sign in, or ask the member to take control.
Sites that need a password, one-time code, or passkey are unsupported. There
is no persistent or owner profile in this version.

Prerequisite: install Chromium as the service account with
`npx playwright-core install chromium` (about 150 MB). If Chromium is missing,
browser tools report that the page could not be loaded and the turn continues.

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
That subject gets its own profile and storage, like any other user. Sharing
excludes it. At startup the listener records an approved admission for that
subject when it is missing, so the test user can own automations and has a
storage limit like other members. The owner's People list shows this row.
Removing it there revokes the test profile like any member, and startup never
re-approves it; only a new client ID can test again. `test-client none` does not
delete the row; remove it from People if the credential is retired. To revoke the test user, delete
the service token or its Access policy, or run `test-client none` and restart.
For owner-driven revocation, stop the listener before invoking
`revoke-profile PROFILE_ID` and restart after it succeeds; the canonical denial
survives the restart. `GET /healthz` reports listener readiness without user data.

## Accounts and people

`GET /api/protected/v1/account` returns the signed-in person's profile and
directory settings. `PUT /api/protected/v1/account/name` saves a `displayName`
of 1 to 40 characters. `PUT /api/protected/v1/account/directory-settings`
saves a `description` of up to 140 characters. The request keeps the `hidden`
field for installed clients. Human members must send `false`. Sending `true`
returns `400 directory_visibility_required` without changing the description.
These are separate saves. Neither endpoint accepts another person's ID.

`GET /api/protected/v1/people` returns eligible people with their ID, display
name, and description. It returns up to 100 people and a `nextCursor`. If the
cursor is not null, pass it as the `cursor` query parameter for the next page.
The directory does not include email addresses or identity claims. All eligible
members appear by name. A description saved under the former Hide me setting
stays unpublished until the member saves a public description. The development identity is always hidden and receives an
empty directory, even if its stored settings say otherwise.

Directory membership follows current canonical admissions, not later edits to
the legacy `allowedSubjects` configuration. Names use the canonical profile store. Directory settings use the existing
profile preferences store. They remain after logout or access revocation and
follow the existing profile merge and deletion rules. A revoked or no longer
allowed identity is not listed.
