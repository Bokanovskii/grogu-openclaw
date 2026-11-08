# Grogu maintenance

Grogu is a private downstream of OpenClaw. Git is the record of every change:
`main` starts at the pinned stable upstream release in `upstream.json`, and all
Grogu behavior lands through reviewed pull requests. Nothing here is deployed by
merging; production keeps running its installed release until an explicit,
verified cutover.

## What lives where

| Kind                                  | Location                                         | Tracked |
| ------------------------------------- | ------------------------------------------------ | ------- |
| Runtime and UI changes                | normal source paths (`src/`, `packages/`, `ui/`) | yes     |
| Maintenance tooling and policy        | `grogu/`                                         | yes     |
| Pinned upstream release and toolchain | `grogu/upstream.json`, `grogu/toolchain.json`    | yes     |
| Personal paths, IDs, model refs, jobs | protected profile (example below)                | never   |
| Secrets                               | native OpenClaw secret refs only                 | never   |
| State, sessions, backups, receipts    | OpenClaw state dir and the private recovery dir  | never   |

Upstream GitHub workflows are kept for reference under
`.github/upstream-workflows/`; only `grogu-ci.yml` and `grogu-upstream.yml` run.
The free private runner uses `pnpm check --skip-lint`, which skips the whole
`pnpm lint` stage; ordinary `pnpm check` remains the required local pre-merge gate.

## Repository history

`main` carries the real upstream history (about 7 GiB packed at `v2026.10.7`),
so each stable release is recorded as a merge parent and keeps its canonical
commit ID. Upstream cuts every stable release on its own release branch, so
consecutive releases diverge (v2026.10.10 is 842 commits behind v2026.10.7). The
integration therefore merges with the pinned release as the explicit merge base:
only Grogu's own changes since that release are carried onto the new one. On a new machine, clone with `git clone --filter=blob:none` to skip
historical file contents. GitHub rejects single pushes over 2 GB, so seeding a
new private origin means pushing `main` in first-parent steps that each stay
under that limit (`git rev-list --objects --disk-usage <next> ^<previous>`
sizes a step), then pushing the Grogu branches.

## Private profile

Copy `profile.example.json` to an owner-only file outside every repository
(for example `~/.config/grogu/profile.json`, directory `0700`, file `0600`).
The loader rejects symlinks, hardlinks, group/world access and files over 1 MiB.

- `operator`: the pinned Node, the immutable OpenClaw CLI, state/config paths,
  recovery and release directories, and the loopback Gateway URL and port.
- `bindings.modelPolicy.automaticModel`: the only model automatic work may use.
  `ownerOverrides` lists config paths or job IDs the owner deliberately routed
  elsewhere.
- `bindings.researchCheckpoint`: research workspace, tracks and artifact prefix.
- `native.jobs`: logical-name bindings for native jobs whose metadata bootstrap
  may reconcile. Bootstrap never changes schedules, models, delivery or pauses.

The runtime reads the same file through `GROGU_PROFILE_FILE`.
Fixed-command helpers that validate research checkpoints use the maintained
`dist/research-checkpoint-guard.runtime.js` entrypoint; they must not import a
hashed chunk or an operator-created dist patch.

## Thinking defaults

Grogu's Sparky utility completions inherit the agent, model and global thinking
defaults from their admitted native configuration, unless a caller explicitly
selects an effort. Activity recaps no longer force thinking off. Other providers
and installations without a private Grogu profile keep their existing behavior.

`agents.defaults.thinkingDefault: "ultra"` selects the provider's highest
advertised effort, not a literal provider-native `ultra` value. For a model
advertising only none, low, medium and high, Ultra uses high. Explicit request,
session, model, agent and job choices remain in force.

## Active-response budgets

Grogu uses `agents.defaults.timeoutSeconds: 0` and
`agents.defaults.subagents.runTimeoutSeconds: 0` to remove overall chat and
child-session execution caps without reducing Sparky/Ultra. Model-backed
automations also need an explicit `payload.timeoutSeconds: 0`; omitting it
retains OpenClaw's separate 60-minute automation watchdog. The
[workspace guidance](templates/workspace-grogu/AGENTS.md#active-response-budgets)
requires this when Grogu creates or edits a model-backed automation, unless the
owner requests a finite budget. Other OpenClaw installations and clients keep
their existing defaults.

These settings leave provider idle/no-model-progress protection, tool deadlines,
settlement deadlines and cancellation intact. They apply to newly admitted runs;
changing defaults does not rescue a run admitted with an earlier deadline.

Administrative payload edits can retire a job's recorded local-origin provenance.
For a job that requires that access, re-save its unchanged tool cap through a
fresh authenticated local creator turn. Do not restore provenance directly from
a backup or manufacture requester identity.
When [Tool Search](../docs/tools/tool-search.md#structured-controls) is active,
discover and invoke the scheduler through its catalog; a failed direct call to
the deferred tool name does not establish that the capability is unavailable.

## Commands

Run from a checkout with the toolchain in `toolchain.json`:

```sh
node --import ./scripts/tsx.mjs grogu/maint.mts --profile <profile> <command>
```

Release builds install the same CLI as `dist/grogu-maint.js`.

| Command                         | Effect                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                        | Native service status plus a read-scope `health` call; no model calls.                                                                                                    |
| `policy-check`                  | Reads native config and all jobs; exits 1 if any automatic selector, fallback or job route leaves `automaticModel`, or a required channel queue mode drifted.             |
| `compaction-stage`              | Writes a validated private candidate config plus apply, rollback, and recovery scripts. Apply requires a verified complete-backup receipt and never restarts the Gateway. |
| `backup`                        | Complete native online archive, verified, with a private digest receipt.                                                                                                  |
| `verify-archive <archive>`      | Native archive and SQLite inventory verification.                                                                                                                         |
| `restore-stage <archive> <dir>` | Restores into an empty staging directory; never activates or starts channels.                                                                                             |
| `bootstrap [--apply]`           | Revision-checked metadata reconcile for bound jobs; preview by default.                                                                                                   |
| `workers-bootstrap [--apply]`   | Preview or revision-check installation of private deterministic source triggers; writes private rollback facts and never invokes a model itself.                          |
| `release-build <source>`        | Builds a source-pinned native package; never activates it.                                                                                                                |
| `release-verify <manifest>`     | Checks the package digest and platform.                                                                                                                                   |
| `upstream-check --source <dir>` | Reads the designated stable upstream release; no mutation.                                                                                                                |

Every command writes owner-only receipts to a new directory under the profile's
`recoveryDir`.

The backup receipt records archive bytes and separate capture, verification,
and digest timings. It preserves the complete online archive and workspace
contract; phase facts identify the slow owner without publishing paths or
inventory.

Worker prompt contracts live under `grogu/templates/workers/`. Private job
definitions may consume them after review. They keep unchanged polls
deterministic and model-free, distinguish authorization failures from empty
sources, and require privacy-preserving bounded research plus one useful
owner-only update for each material private signal. Add each private job id and
its required template marker to `bindings.modelPolicy.workerContracts`;
`policy-check` then reports missing jobs or markers without printing prompts.
Each `native.workerTriggers` entry selects a tracked template from
`worker-trigger-templates.ts`, an approved MCP server/tool plus its live
catalog schema hash, private bounded arguments, fixed metadata-only decoding,
and continuation limits. Bind exactly the two existing jobs: one Gmail
primary and one Messages primary. Both multi-source payloads retain their
complete, ordered, already-approved `toolsAllow` lists, including both
collector permissions and existing Calendar/research tools; the renderer calls
only its selected primary. Bootstrap patches only `trigger`, rejects wildcard
or `exec`/`message` broadening, and receipts a hash proving the remaining job
definition stayed unchanged. Calendar remains the existing payload tool and is
requested only by bounded `native_source_sweep` trigger intent. No Calendar MCP
trigger template or new job is installed.

Capture the supported effective input-schema pins without invoking a source
tool:

```sh
openclaw mcp probe gmail --json |
  jq -er '.toolSchemas.gmail__gmail_search.schemaSha256'
openclaw mcp probe seaglass --json |
  jq -er '.toolSchemas.seaglass__recent_messages.schemaSha256'
```

The probe also publishes `schemaFormat:
openclaw-effective-input-schema/v1` and the normalized `inputSchema`.
`workers-bootstrap` repeats both named probes and refuses preview or apply when
either private pin differs from the live catalog. The Gmail adapter parses the
configured wrapper's `structuredContent.stdout`; the Messages adapter parses
the single JSON text block in `content`. Gmail has no page-token input, so
`has_more` or `nextPageToken` records valid truncated bounded-head coverage
with the configured limit and discards the token; Messages `has_more` is
truncated coverage only for an offset-0 page. Only a truncated page must be
newest-first with readable numeric timestamps (and offset 0 for Messages),
otherwise the observation is a typed `incomplete` or `schema` failure; complete
pages keep the earlier generic non-empty timestamp check. Messages ids are
positive safe integers and timestamps may be fractional. Only a successful
non-truncated zero result is authoritative empty coverage. Both adapters reject
write/body options, malformed wrappers, and structured source failures rather
than fabricating an empty source. A failing Gmail result is classified by gog's
documented exit code first (4 `auth`, 6 `permission`, 10 `config`, and 7, 8, 11
or 130 `transient`, so a rate limit is retried); any other or unreadable code
keeps the generic classification, and only the kind is returned, never error
text. Run `workers-bootstrap` in preview mode before activation.
The rendered trigger owns source polling and `fire: false` for unchanged data.
It stores a bounded identity list plus the oldest timestamp of a truncated head
(its floor, taken over every observed row) and fires for an unseen identity
unless it is positively older than that floor, so removals and older items
exposed below the floor do not fire (except an exact equal-timestamp tie, and
an identity whose timestamp cannot be read always fires). Earlier full-item
state is still read. A stored v2 fingerprint whose identity keys, coverage kind
or truncation flag, or floor are unusable is silently rebaselined instead of
fired on; its other fields are trusted as the trigger wrote them. Only
`fire: true` admits the existing agent-turn payload for bounded research.
`policy-check` compares each collector contract's pinned `triggerSha256` with
the installed script, so a renderer change needs that pin updated together with
`workers-bootstrap --apply`.
`--apply` uses the live job's configuration revision and stores the prior
trigger in the owner-only plan receipt for rollback.

Gmail authorization verification stays separate from worker correctness. Use
the existing non-mutating verify-only command after consent includes the
read-only Gmail scope. For a forced refresh test, copy credential material into
an owner-only isolated state and expire only the copied access-token cache.
Production app audience avoids testing-mode seven-day expiry, but refresh
tokens can still be revoked; a low-frequency health check must distinguish
missing scope, revocation, and transient network/provider failure.

## Local microphone input

The [local voice plugin](plugins/grogu-local-voice/README.md) uses an installed
whisper.cpp executable and model through the existing transcription relay.
Tap the microphone, speak, stop, edit the transcript, and send it to the same chat.
Sparky remains the reasoning model. The plugin does not upload audio or download a model.
The operator must approve its live installation and configuration after source review.

The [Apple News skill](templates/workspace-grogu/skills/apple-news/SKILL.md) guides
bounded research through normal app controls and the existing subscription.
It distinguishes articles read in News from public-source evidence and blocked app access.
It creates original source-linked notes, not an article archive.

## Prepare a separate Grogu browser app

Chrome owns profile creation, web-app installation, and app shortcuts.
Keep the existing Safari `Grogu.app` and Safari as the OS default browser.
Use Chrome's maintained app owner instead of building a replacement launcher.

A Chrome profile keeps its browser data separate from other profiles.
Use a new Grogu-only profile without Google sign-in or synchronization.
Do not attach automation to a personal Chrome profile or copy browser credentials.
Do not register the app to start at login.

Source approval does not authorize profile creation, app installation, or
persistent account access. Before those actions, obtain one confirmation for
creating the unsigned-in Grogu profile and installing `Grogu Chrome`.
If the approved UI tool cannot reach that profile without opening a personal
profile, stop and have the owner expose the profile chooser.
Do not bypass the tool with shell launch, focus commands, or browser debugging.

After that confirmation, use the supported Chrome UI:

1. Create a new profile through Chrome's profile chooser.
2. Name the profile `Grogu` without enabling Google sign-in or synchronization.
3. In that profile, open the same credential-free Control UI URL as the old app.
4. Use Chrome's web-app installation UI to name the app `Grogu Chrome`.
5. If an app shortcut is needed, open `chrome://apps` in that profile.
6. Select **Create shortcut** for the installed app.
7. Make sure that the shortcut opens a separate window in the Grogu profile.

A website shortcut alone does not prove standalone app installation.
If Chrome does not offer web-app installation for that URL, report the missing
action instead of creating a script wrapper. Sign in or pair with Grogu through
its normal flow only after account-access approval.
Keep that authorization separate from Google account sign-in.

Make sure that relaunch reaches the same Gateway and preserves the dedicated
profile. Make sure that external links follow the intended browser behavior.
Chrome can keep external links in Chrome even when Safari is the OS default.
Rollback uses the unchanged Safari app. Do not delete profiles with owner data.
Browser choice does not change the reasoning model. Sparky remains unchanged.

Compare scrolling before selecting a browser workaround. Use the same served
build, conversation, widget, and window size in Safari and dedicated Chrome.
Test inner widget scrolling, outer transcript scrolling, resize, focus changes,
returning from a hidden window, and relaunch. Record exact disappearing or
returning content before changing overflow, resize, or visibility code.
A UI tool's refusal to scroll is a tool limit, not proof of a browser defect.
Do not claim Chromium-only support from a Chromium test lane.

See [Chrome's profile guide](https://support.google.com/chrome/answer/2364824),
[web-app guide](https://support.google.com/chrome/answer/9658361),
[website-shortcut guide](https://support.google.com/chrome/answer/15085120),
and the [Control UI guide](../docs/web/control-ui.md).

## Taking in upstream releases

1. `grogu-upstream.yml` runs daily (or on dispatch) in the private repository.
   It finds the newest stable OpenClaw release, applies Grogu's delta to it with
   `git merge-tree --merge-base=<pinned release>`, commits the result with `main`
   and the release as parents in the rolling `grogu/upstream` branch, archives any new upstream workflows, updates
   `upstream.json`, and opens or refreshes one draft PR. It never enables
   auto-merge, deploys, or makes model requests.
   - It needs the `GROGU_UPSTREAM_TOKEN` secret: a fine-grained token limited to
     this repository with Contents, Pull requests, Actions, and Workflows write.
     The built-in `GITHUB_TOKEN` cannot push upstream commits that touch
     `.github/workflows`.
   - Install scripts are skipped and Git hooks are disabled, so no
     upstream-controlled code runs while that token is present.
   - Checkout and the named upstream remote use `blob:none` partial clones.
     Merge analysis retains full commit/tree ancestry and fetches only blobs
     needed for the candidate tree. Disk and Git object-size checkpoints make
     runner pressure visible without printing repository content.
2. It dispatches `grogu-ci.yml` for the exact prepared commit, so the CI
   evidence is pinned to that SHA.
3. If the merge conflicts, the run fails, lists the conflicting files in the
   job summary, and leaves the remote branch unchanged. Resolve it locally on a
   branch from `main` with the same base:
   `git merge-tree --write-tree --name-only -z --merge-base=<pinned commit> main <release commit>`
   shows the conflicts; resolve them, record the release as the second parent,
   update `upstream.json`, and open the PR by hand.
4. Review the PR and CI. Merge only when green.
5. Deploy deliberately: `backup`, `release-build`, `release-verify`, stage and
   check, cut over through the native service, then `status` and
   `policy-check`. Release manifests are never certified for rollback, because
   state migrations may be one-way; recover from the verified backup if needed.

## Invariants checked in code

- Automatic work routes only to `bindings.modelPolicy.automaticModel`
  (`policy.ts`). Owner-picker catalogs and allowlists are not selectors.
- Telegram uses ordered `followup` queueing so back-to-back messages each get an
  answer (`REQUIRED_CHANNEL_QUEUE_MODES` in `policy.ts`).
- Maintenance only targets the canonical loopback Gateway and never prints
  credentials (`operator.ts`).
- Sparky requests keep at most two images without rewriting conversation history.
  Images attached to the latest user message take priority; remaining slots keep
  the newest historical or tool images. Older images are replaced with an
  explicit omission notice in the request only. Browser research can therefore
  continue after multiple screenshots. Attaching more than two images to one
  user message still returns an actionable validation error.
