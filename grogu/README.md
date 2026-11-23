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
| State, sessions, temporary receipts   | OpenClaw state dir and the private recovery dir  | never   |

Upstream GitHub workflows are kept for reference under
`.github/upstream-workflows/`; only `grogu-ci.yml` and `grogu-upstream.yml` run.
Focused pull requests need `pnpm check:changed` and targeted tests for the
touched contract. Use full `pnpm check` for broad changes: dependencies, the
toolchain, shared config or tooling, or changes in several areas. Run one
focused review after the change is complete. Review later fixes only for what
they changed, and do not rerun checks when their inputs did not change.

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
- `bindings.sparkyQueue.maxActive`: optional positive integer limit for active
  Sparky requests. Omit `sparkyQueue` to let the provider schedule requests without
  a local provider cap. See [Provider concurrency](#provider-concurrency).
- `native.jobs`: logical-name bindings for native jobs whose metadata bootstrap
  may reconcile. Bootstrap never changes schedules, models, delivery or pauses.

The runtime reads the same file through `GROGU_PROFILE_FILE`.
Fixed-command helpers that validate research checkpoints use the maintained
`dist/research-checkpoint-guard.runtime.js` entrypoint; they must not import a
hashed chunk or an operator-created dist patch.

## Interrupt active work for maintenance

Approved maintenance can interrupt active Grogu work. A busy schedule may never
go quiet, so do not wait for automation runs to finish. Run these steps on the
Gateway host:

1. Record the active work. Run `openclaw gateway call health --json` and
   `openclaw cron list --json`, and note the running jobs and chats.
2. Request a bounded graceful restart with
   `openclaw gateway restart --preserve-definition --wait 2m --json`. The
   Gateway waits up to two minutes for active work, then interrupts it and
   restarts. Do not use `--wait 0` or `--safe`. Both can keep admission closed
   behind cron work for a long time.
3. If the restart command fails or times out, run
   `openclaw gateway restart --force --preserve-definition --json`. For a command
   that needs the Gateway stopped, such as `openclaw doctor --fix` or
   `openclaw update repair`, use `openclaw gateway stop --force --json` instead,
   and run `openclaw gateway start --json` after the command.
4. Make sure that the Gateway recovered. `openclaw gateway call health --json`
   must report `ok`, connected channels and no plugin errors.
5. Report each interrupted run to the user. `openclaw cron runs --id <jobId>`
   shows `job interrupted by gateway restart` for each one. Scheduled jobs run
   again at their next slot. Interrupted chat turns need a new message.

Do not kill Gateway or child processes, and do not edit the SQLite databases to
clear work. The native shutdown owns checkpoints, aborts and run settlement. Do
not repeat a forced restart while one is in progress.

## Thinking defaults

Grogu's Sparky utility completions inherit the agent, model and global thinking
defaults from their admitted native configuration, unless a caller explicitly
selects an effort. Activity recaps no longer force thinking off. Other providers
and installations without a private Grogu profile keep their existing behavior.

`agents.defaults.thinkingDefault: "ultra"` selects the provider's highest
advertised effort, not a literal provider-native `ultra` value. For a model
advertising only none, low, medium and high, Ultra uses high. Explicit request,
session, model, agent and job choices remain in force.

## Provider concurrency

Only Sparky uses Grogu's provider-origin admission queue. By default, Grogu adds
no active-request cap and lets Sparky schedule concurrent requests. The provider
can queue requests or reject them when busy; no local setting guarantees unlimited
provider capacity.

To impose a local cap, set `bindings.sparkyQueue.maxActive` in the private profile
to a positive safe integer. Existing explicit limits remain in force. Remove
`bindings.sparkyQueue` to retire an old two- or four-request override. Install the
updated runtime and restart the Gateway after changing the profile, which is read
once per process.

When a local cap or provider cooldown makes requests wait, waiting human
requests run first in arrival order, so when a slot frees, a waiting person gets
it before waiting automation. Aging can promote background work only when no
human is eligible. Already-running requests are not preempted. An automation
therefore yields at its next request boundary: the response it already received
stays in its transcript and is not replayed, and its next model request waits
behind the person. When 32 requests are already waiting, new automation requests
are refused, but a person's request always joins the queue. A rejected
background request pauses only background work; a rejected human request
pauses all Sparky work for the cooldown.
Human, scheduled and utility requests share every idle slot when a local cap
is configured. Without that cap, priority applies only to local cooldown waits;
Sparky owns scheduling after dispatch.

The current run's trigger and typed input provenance determine priority. System
and inter-session handoffs do not gain human priority merely because they run in
a conversation with a session ID. Native plugin dispatch marks automatic
handoffs, including Research Topics notifications to Main, as internal input.

GitHub Copilot and other providers bypass the Sparky queue. While awaiting
Sparky admission or rejected-admission cooldown, a run yields only its global
execution capacity and reacquires it through the existing command queue. It
retains session serialization, run authority, and shutdown drain ownership.
Waiting Sparky runs therefore cannot occupy every execution slot ahead of
GitHub Copilot. Accepted streams retain their capacity and are not replayed.

Native bounded Gateway concurrency, child-session limits and automation limits
still apply. The old `agents.defaults.maxConcurrent: 2` applied Sparky's
limit to every provider. `bootstrap --apply` removes that exact legacy override
through native configuration, restoring the host-sized default; it preserves
other explicit limits and subagent settings. `policy-check` reports the retired
two-run override if it returns. Preview bootstrap first and apply only with
approval for a possible Gateway restart.

## Active-response budgets

Grogu uses `agents.defaults.timeoutSeconds: 0` and
`agents.defaults.subagents.runTimeoutSeconds: 0` to remove overall chat and
child-session execution caps without reducing Sparky/Ultra. Model-backed
automations also need an explicit `payload.timeoutSeconds: 0`; omitting it
retains OpenClaw's separate 60-minute automation watchdog. The
[shared assistant policy](plugins/grogu-coordination/policy/AGENTS.md#preserve-authority-and-evidence)
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

## Owner notification content

The [Main text policy](plugins/grogu-coordination/policy/main.md)
keeps deduplication decisions, suppressed topics and routine check commentary
out of owner messages, including when a genuine alert is being sent. The
[coordination plugin](plugins/grogu-coordination/README.md) supplies that policy
through the existing stable system-context hook, including lightweight jobs
that skip workspace bootstrap. Verify the installed cutover before removing
temporary saved-payload copies. Already-admitted turns keep their prior inputs.
Preserve source-backed findings and useful links. Unattended source runs end
quiet scans with a short status line, because native scheduling records a silent
`NO_REPLY` after a failed tool call as a failed run. Explicit owner requests
still receive useful answers.

## Alcove feedback and usage

Alcove members can rate their own saved replies and privately report a problem.
A report requires explicit evidence consent, sets the reply's rating to down,
and notifies the configured owner with only `{tag:"issue-report"}`. Submitting
the same report ID again returns the original report; a second report for the
same reply is rejected.

The runtime stores the report description with the existing protected-storage
codec. It stores evidence references, not copied prompts, replies, sources,
widgets, or files. The owner resolves evidence from the submitting member's
authorized saved reply; only file references, names, and sizes proven to belong
to that turn are included. This includes newly generated HTML files, using the
same IDs and display names as the artifact library. File HTML is not included;
widget evidence remains the saved reply's widget IDs and titles.
Descriptions and resolved evidence use the existing secret redactor. Ordinary
members cannot read other members' ratings, owner reports, report assets, or
cross-user telemetry.

Detailed telemetry currently covers protected chat turns and their observed
model requests, not automation or other feature runs. It records proven member,
agent, provider and model attribution, outcome, token/cache usage, supported
reasoning-summary character counts, and observed timing. Missing measurements
remain `null`; unattributed turns remain in totals. Routine telemetry does not
capture prompts, assets, credentials, or hidden reasoning. Historical data is
not reconstructed.

Feedback/report tables are created lazily through the existing state worker.
Reports and detailed telemetry expire after 90 days through native cleanup;
their storage counts toward the existing quota. Chat deletion removes ratings
and evidence references while retaining report descriptions/counts and
content-free run metadata until expiry. Member removal also removes ratings,
disables evidence, clears run references, and replaces the stored member label.
No separate cleanup scheduler or external issue/analytics service is used.

The feedback client opts in with `X-Alcove-Capabilities: feedback-v1`; `/me`
adds feedback and owner-only telemetry capabilities only for that opt-in.
Existing clients retain their original `/me` shape. All `/admin/reports` and
`/admin/telemetry` routes revalidate configured-owner authority server-side.

Full-chat reports additionally require `report-chat-v1` in that capability
header and explicit `includeChat:true` alongside `includeEvidence:true`.
`GET /admin/reports/<id>/chat?cursor=<opaque>` returns up to 128 items per page;
continue with `nextCursor` until it is `null`. The existing report-detail shape
does not change. `capturedAt` identifies server capture time; an encrypted
reference pins the exact transcript prefix and file metadata, excluding later
additions. A rewritten or unavailable prefix returns `not_retained`, never a
live-chat fallback. Reports without this consent return `not_included`.
Tool inputs/results and compaction summaries are included, but secrets, private
reasoning and replay fields are excluded. `redactions:null` means the exact
redaction count is unavailable. Files are produced-file metadata only with
`readable:false`; this does not add uploads or owner downloads. References count
toward storage quotas and clear on chat/member deletion; consent remains until
the report's existing 90-day expiry.

## Commands

Run from a checkout with the toolchain in `toolchain.json`:

```sh
node --import ./scripts/tsx.mjs grogu/maint.mts --profile <profile> <command>
```

Release builds install the same CLI as `dist/grogu-maint.js`.

| Command                         | Effect                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                        | Native service status plus a read-scope `health` call; no model calls.                                                                                                                      |
| `policy-check`                  | Reads native config and all jobs; exits 1 for automatic model, channel queue or legacy shared-concurrency policy drift.                                                                     |
| `compaction-stage`              | Writes a validated candidate configuration and a small original-configuration recovery copy. Apply checks exact configuration hashes, needs no full backup, and never restarts the Gateway. |
| `backup`                        | Retired. Exits with an error without creating a local full backup.                                                                                                                          |
| `verify-archive <archive>`      | Native archive and SQLite inventory verification.                                                                                                                                           |
| `restore-stage <archive> <dir>` | Restores into an empty staging directory; never activates or starts channels.                                                                                                               |
| `bootstrap [--apply]`           | Reconciles job metadata, storage policy, default widget isolation and the legacy shared concurrency cap; preview by default. Applying can restart the Gateway.                              |
| `storage-bootstrap [--apply]`   | Disables scheduled backups and installs one native cleanup job every five minutes without a model call; preview by default.                                                                 |
| `storage-cleanup [--apply]`     | Disables scheduled backups and retires completed backup artifacts without a retention window; preview by default.                                                                           |
| `plugins-bootstrap [--apply]`   | Previews or installs Grogu's pinned plugin packages with OpenClaw's native installer.                                                                                                       |
| `workers-bootstrap [--apply]`   | Preview or revision-check installation of private deterministic source triggers; writes private rollback facts and never invokes a model itself.                                            |
| `release-build <source>`        | Builds a source-pinned native package; never activates it.                                                                                                                                  |
| `release-verify <manifest>`     | Checks the package digest and platform.                                                                                                                                                     |
| `upstream-check --source <dir>` | Reads the designated stable upstream release; no mutation.                                                                                                                                  |

Native calls write owner-only receipts under the profile's `recoveryDir`.

### Widget hosting

Bootstrap enables `mcp.apps.sameOriginSandbox` only when the field is absent.
It preserves an explicit `false` or `true`. This Grogu default lets widgets use
the Gateway's existing HTTPS origin without another port or hostname.
Upstream OpenClaw keeps its dedicated-origin default.

Install a release that supports the option before running bootstrap.
Applying the change uses native, revision-checked configuration and requires
a Gateway restart. Bootstrap applies it last because the native patch can
schedule that restart. Reload the Control UI afterward.

Both sandbox frames remain isolated from the application DOM, cookies, and
storage. Saved widgets keep their original bytes and digests.
See [single-origin sandbox setup and limits](https://docs.openclaw.ai/cli/mcp/apps#single-origin-sandbox).

### Plugin setup

The optional [Research Topics plugin](plugins/research-topics/README.md) provides
a private SQLite ledger for chat intake and a scheduled research planner.
Its `research_topics` tool tracks priorities, due times, shared source limits,
and fetch outcomes without reading large workspace files on every run.
Installation alone does not migrate private topics or change running jobs.

### Ongoing research and instruction ownership

Behavior instructions contain no changing interest or shopping list.
The [automation architecture](automation-architecture.md) describes Grogu's
reusable design, ownership, and extension points. The repository owns code,
generic policies, and worker templates. Private configuration owns installation
choices, source accounts, job identities, notification routes, and quiet hours.

`research_topics` owns research details, categories, priorities, conversation
links, fair selection facts, and completion. Chats push context into that owner.
The [researcher](templates/workers/research-planner.md) advances a fair batch of
questions. [Source producers](templates/workers/producer.md) make bounded passes
over new evidence. Main reviews explicit candidates and owns automatic texts.

Inbox uses independent Gmail and Messages metadata polls, so each source keeps
its existing cursor and failure handling. Daily prep reads calendar and weather.
News runs every thirty minutes around the clock. Native event wakes remain,
but an empty periodic heartbeat is not a research worker.

Reconcile useful old facts before deleting enumerated obsolete research lists
and duplicate policy copies. Preserve current owner edits and original chats.
Do not create archives or backups of the retired copies.

The deployment owner applies the reviewed contracts with current configuration
revisions. Reconcile source templates, rendered triggers, exact tool caps, and
schema/hash pins together. A merge changes no live job. Prove the actual
job/tool flow after cutover before claiming working intake or delivery.

Run `plugins-bootstrap` with the protected profile on the new host. The command
previews the approved plugins and their exact versions. Add `--apply` to install
them with OpenClaw. OpenClaw installs the declared dependencies and keeps its
source, security, and capability checks. Set up plugins before starting the new
Gateway; applying while it is running can reload its plugins.

The list includes the `duckduckgo` web-search plugin and the community
`openclaw-icloud-calendar` plugin. Review the calendar plugin's capabilities
before you add `--accept-capabilities`. The command does not install local
dictation or copy browser, Keychain, or npm cache data. Set up dictation on
each new host with the [local voice plugin guide](plugins/grogu-local-voice/README.md).

The command leaves a matching installation with its required direct dependencies
in place. It uses the native installer to repair a missing package or direct
dependencies, or to pin an existing matching package. It preserves existing
enablement and access lists; update those separately if a plugin should be
enabled. It stops if an existing installation has a different or unverifiable
source, package, or version, or OpenClaw reports an unresolved error. If an
installation fails, read the private native receipt. Fix the reported problem
and run the command again.

### Main review and completion settle jobs

Main sends every automatic text, and it sends each one through the `message`
tool. Main holds a finding during quiet hours. Two small jobs wake the Main
conversation, so held findings and stalled completions do not wait for a new
event. The [Main policy](plugins/grogu-coordination/policy/main.md) owns the
text rules, so each job only says when to look.

Grogu setup does not create these jobs. Before you start, install the Research
Topics and coordination plugins, and let the Main agent use the `message` tool
for the owner's route. Run these steps once on each Gateway host. Replace each
value in angle brackets with the installation's own choice. The examples assume
quiet hours from midnight to 06:00.

1. Create the morning review. It runs once a day when quiet hours end. Add
   `browser` to `--tools` only on a host that has a browser.

   ```sh
   openclaw cron add \
     --name "Main: morning text review" \
     --description "Reviews held findings and pending topic completions using Main's recent phone context and text policy." \
     --notification-description "Main reviews worthwhile findings before sending an automatic text." \
     --cron "0 6 * * *" \
     --tz "<IANA time zone>" \
     --agent <main-agent-id> \
     --session session:agent:<main-agent-id>:main \
     --model "<provider/model>" \
     --thinking <thinking level> \
     --timeout-seconds 0 \
     --tools read,research_topics,message \
     --no-deliver \
     --declaration-key grogu-main-morning-review \
     --message "Review worthwhile findings held in this Main conversation during quiet hours. Read current topics where their details matter, and list completion_pending topics through research_topics to settle due acknowledgments. Apply Main's text policy using recent inputs, confirmed sends, and owner replies. Preserve uncertain outcomes."
   ```

2. Create the completion settle job. It checks every 20 minutes from the end of
   quiet hours to the end of the day, so it never wakes Main during quiet hours.
   The trigger script starts a run only when a topic stays in
   `completion_pending`.

   ```sh
   openclaw cron add \
     --name "Main: completion settle" \
     --description "Settles completion acknowledgments that stayed pending after Main's first handoff." \
     --notification-description "Main settles a stalled completion acknowledgment before it sends a text." \
     --cron "*/20 6-23 * * *" \
     --tz "<IANA time zone>" \
     --agent <main-agent-id> \
     --session session:agent:<main-agent-id>:main \
     --model "<provider/model>" \
     --thinking <thinking level> \
     --timeout-seconds 0 \
     --tools read,research_topics,message \
     --no-deliver \
     --declaration-key grogu-main-completion-settle \
     --message "Some topic completions are still waiting for Main's acknowledgment. List completion_pending topics through research_topics, read each one, and settle it with Main's completion rules." \
     --trigger-script - <<'JS'
   const result = await research_topics({ action: "list", status: "completion_pending", limit: 20 });
   if (!result || !Array.isArray(result.topics)) throw new Error("Completion check failed");
   const prior = trigger.state && trigger.state.tries ? trigger.state.tries : {};
   const tries = {};
   let fire = false;
   for (const topic of result.topics) {
     const seen = prior[topic.id];
     if (seen === undefined) {
       tries[topic.id] = 0;
       continue;
     }
     if (seen < 3) {
       tries[topic.id] = seen + 1;
       fire = true;
     } else {
       tries[topic.id] = seen;
     }
   }
   return { fire, state: { tries } };
   JS
   ```

3. Turn off the native failure alert for both jobs, so a failed run cannot send
   its own text outside Main's rules. Each `cron add` command printed the job
   `id`. Use those two values here.

   ```sh
   openclaw cron edit <review-job-id> --no-failure-alert
   openclaw cron edit <settle-job-id> --no-failure-alert
   ```

The declaration key makes a second run of the same `cron add` command update
that job and not create another one.

The settle trigger records each pending topic on its first sighting and does not
start Main. If the same topic is still pending on the next check, the trigger
starts Main, up to three times for each topic. A trigger that finds nothing
leaves no run history, so `openclaw cron runs <job-id>` stays empty until a
completion stays pending. Both jobs deliver nothing themselves. Main sends any
text through `message`.

### Small-disk storage policy

Automation detail expires after seven days by default through
`cron.runDetailRetention`. The hourly sweep preserves personal chats and active
runs. Mixed chats require explicit cron provenance and matching reply run IDs.
Uncorrelated legacy replies remain intact. Runtime completions retain message
counts rather than repeated full message snapshots.
Pending or uncertain work remains protected. A running cron receipt defers
detail cleanup for the whole agent until a later sweep.

Existing owners also bound audit events to 30 days and 100,000 rows, retain
plugin captures while native code needs them, and reclaim free SQLite pages
incrementally. Terminal non-cron task records expire after seven days only when
delivery and lifecycle owners no longer reference them. These policies do not
delete durable research topics or sources.

Older protected Alcove runtimes also left unreadable `web_fetch` spill files in
members' chat storage. Stop the protected listener before updating its runtime,
then run the fixed maintenance command below before restarting it. It deletes
only UUID-named `web-fetch-<uuid>.log` files under each chat's `web-fetch/`
directory, removes that directory only when empty, and leaves chat transcripts
and other files untouched. The artifact library discovers current files, so
removed spills no longer appear there; no manifest needs updating. Use
`--dry-run` to list the exact stored paths without changing them.

```sh
sudo -n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run cleanup-web-fetch-spills
```

The existing maintenance helper dispatches into the updated runtime tree, so it
needs no separate helper installation or schema migration. The cleanup makes
no backup and adds no scheduler.

After large logical deletions, offline Doctor compaction can repack SQLite files.
The deployment owner stops the Gateway and runs
`openclaw doctor --session-sqlite compact --session-sqlite-all-agents --json`,
then `openclaw doctor --state-sqlite compact --json`.
Do not run online `VACUUM` or create a routine full backup for this cleanup.
Compaction does not restore expired detail.

Grogu must not retain backups. Updates and standalone Doctor runs with an
admitted `GROGU_PROFILE_FILE` skip optional full-state copies for manual recovery.
Configuration writes also skip the rotating `.bak` copies for the root and included
files. The `.pre-update` configuration copy remains available to update recovery.
Temporary snapshots required for transactional rollback remain under their
update or repair owner until that operation finishes. Already-admitted recovery
lineage remains valid when an older installed updater starts the operation.
Git preserves source, not conversations, credentials, or databases.
Removing recovery copies permanently loses the ability to restore those earlier
states.

After installing a Grogu release, run the normal bootstrap with the protected
profile. The installed release must include `dist/grogu-maint.js`.

```sh
node /path/to/installed/openclaw/dist/grogu-maint.js \
  --profile /path/to/private/profile.json bootstrap --apply
```

Bootstrap disables native full-archive backup jobs, including remote targets,
Git snapshot jobs, and legacy Grogu backup workers. It preserves unrelated
automations and running work. A running backup
is reported as deferred and must finish before the next cleanup disables it.
The old backup contract marker is retained only to identify installed legacy
workers during migration.

Cleanup runs every five minutes as a native command job, not an agent turn. It uses
the installed Node and maintenance CLI from the private profile, so it needs
no source checkout or machine-specific paths. Its run history records failures
and deferred work. No new operating-system scheduler or model-backed watcher
is required. Repeating bootstrap converges the same declaration-key job.

Completed Grogu backup archives, failed package builds, and completed maintenance
receipts are eligible for the next sweep without a retention window.
Unactivated release packages are installation candidates, not state backups.
They expire after 24 hours so cleanup cannot delete a newly built candidate
before the operator installs it. Cleanup requires producer receipts
and shares a lock with package builders and archive readers. It preserves the
running installation, state, credentials, active work, and unrecognized files.
The same sweep removes the root configuration's native `.bak` through `.bak.4`
ring under native update ownership and the configuration writer lock.
Active updates and unfinished recovery block removal. It preserves aliased files,
manual backup names, existing `.pre-update` copies, and temporary write files.
Active configuration rollback uses the writer's original bytes, not this ring.
The cleanup also retires native update captures and future standalone Doctor
captures after verified success without an extra recovery window.
Grogu also retires unsealed manual copies after their recorded update finishes
and every recorded writer exits. Only numbered payload files and empty database
staging directories qualify. Later payload writes and unknown content block removal.
Finder metadata does not make an otherwise completed capture permanent.
Failed manual originals qualify only when native history records restart-safe
package state and no recovery capture reference or unresolved outcome remains.
Native update ownership and unfinished recovery always block removal.
Older Doctor captures without completion evidence remain protected.
Retained updater code and copies without matching native history remain protected.
Missing metadata does not authorize deleting an active writer's files.
The `setup` directory contains operator deployment and recovery artifacts without
a shared completion contract. Its owner must settle each operation before a
reviewed cleanup. Session archives can contain retained conversation history.
Full-output `web_fetch` files preserve fetched text that tool results reference.
Neither category is a disposable backup based on its name or age.
Workspace documents and research artifacts remain intact.
Preview cleanup before the first removal:

```sh
node /path/to/installed/openclaw/dist/grogu-maint.js \
  --profile /path/to/private/profile.json storage-cleanup
```

Add `--apply` to permanently remove eligible artifacts. A merge alone does not
deploy this policy or change an existing private service. Install the release
and run bootstrap on each host, including a new Mac mini. Legacy backups outside
the profile's recovery directory need a separate, reviewed one-time cleanup.

Worker prompt contracts live under `grogu/templates/workers/`. Private job
definitions may consume them after review. They keep unchanged polls
deterministic and model-free, distinguish authorization failures from empty
sources, and require privacy-preserving bounded research plus useful
candidates for Main to review. Add each private job id and
its required template marker to `bindings.modelPolicy.workerContracts`;
`policy-check` then reports missing jobs or markers without printing prompts.
Each `native.workerTriggers` entry selects a tracked template from
`worker-trigger-templates.ts`, an approved MCP server/tool plus its live
catalog schema hash, private bounded arguments, fixed metadata-only decoding,
and continuation limits. Each binding has one Gmail or Messages collector.
Several bindings can feed the same Inbox role. Keep each payload's complete,
ordered, reviewed `toolsAllow` list. The renderer calls only its selected
collector. Bootstrap patches only `trigger`, rejects wildcard
or `exec`/`message` broadening, and receipts a hash proving the remaining job
definition stayed unchanged. Daily prep uses a separate bounded calendar and
weather schedule. The collector bootstrap does not create that job or change
any schedule, source permission, or role payload.

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

### Keep Seaglass search current

Seaglass answers topical searches from its own index, not from the Messages
database. Recent-message and conversation lookups read the Messages database
directly, so they stay current. The `sync_index` tool refreshes the index only
while the Seaglass app runs. A Gateway host usually does not run the app.
Without a refresh, `index_status` reports `stale: true` and topical search
misses every message that arrived after the last refresh.

A native cron command job can refresh the index every day without a model call.
Each run copies the live Messages database to `~/.seaglass/chat_snapshot.db`.
Then it adds only new chunks (groups of messages) to `~/.seaglass/index.db`. The
copy is overwritten in place, so it does not grow with each run. Do not
schedule the job more than once a day. Each run rewrites a file as large as the
Messages database.

Before you create the job, make sure that these conditions are true on the
Gateway host:

- Seaglass is installed and registered as the MCP server `seaglass`.
- The process that runs the Gateway has Full Disk Access.
- `jq` is installed.

Grogu setup does not create this job. Run these steps once on each Gateway host:

1. Store the path of the Python program that Seaglass uses. It is next to the
   `seaglass-mcp` command.

   ```sh
   PYTHON_BIN="$(dirname "$(openclaw config get mcp.servers.seaglass.command)")/python"
   ```

2. Build the JSON array of arguments for the job. The code calls `run_build`, the
   function that the Seaglass app uses to build its index.

   ```sh
   ARGV="$(jq -Rsc --arg py "$PYTHON_BIN" '[$py, "-c", .]' <<'PY'
   import json
   import sys
   from pathlib import Path

   from seaglass.app.config import load_config
   from seaglass.app.indexstate import IndexBuildState, run_build

   config = load_config()
   state = IndexBuildState()
   run_build(
       state,
       chat_db_source=config.chat_db_source,
       chat_db_snapshot=config.chat_db,
       index_db=config.index_db,
   )
   result = state.snapshot()
   wal = Path(config.chat_db + "-wal")
   print(
       json.dumps(
           {
               "stage": result["stage"],
               "error": (result["error"] or "")[:200] or None,
               "elapsed_s": round(result["elapsed_s"]),
               "chunks_before": result["chunks_before"],
               "chunks_now": result["chunks_now"],
               "snapshot_wal_bytes": wal.stat().st_size if wal.exists() else 0,
           }
       )
   )
   sys.exit(0 if result["stage"] == "done" else 1)
   PY
   )"
   ```

3. Create the job. The flag `--timeout-seconds 3600` ends a run after one hour.
   The command prints JSON. The job `id` is in the `job` object.

   ```sh
   openclaw cron add \
     --name "Seaglass index refresh" \
     --description "Refresh the Seaglass message index. No model calls." \
     --notification-description "Does not text you." \
     --cron "30 4 * * *" \
     --session isolated \
     --no-deliver \
     --timeout-seconds 3600 \
     --declaration-key grogu-seaglass-refresh-v1 \
     --command-argv "$ARGV"
   ```

4. Run the job once and wait for it to finish. The flag `--wait-timeout 1h`
   matches the job timeout. The command exits with code 0 when the run succeeds.

   ```sh
   openclaw cron run <job-id> --wait --wait-timeout 1h
   ```

A successful run prints one JSON line with `"stage": "done"` and the chunk
counts. The run summary shows that line under `stdout:`. A progress line from
the model library can also appear under `stderr:`. A failed run records
`error`, and topical search stays stale until a later run succeeds. If the
Gateway process lacks Full Disk Access, the error text says so. To read the run
history, run `openclaw cron runs <job-id> --limit 5`.

The job uses the default Seaglass file locations. If `mcp.servers.seaglass.env`
sets `SEAGLASS_CHAT_DB_SOURCE`, `SEAGLASS_CHAT_DB`, or `SEAGLASS_INDEX_DB`, add
each value to the command in step 3 with `--command-env KEY=VALUE`.

The code depends on the internal function `run_build`. A Seaglass update can
change it, and then every run records `error`. If that happens, copy the call
from the `/api/index/build` handler in `seaglass/app/server.py` into the code in
step 2. Then run steps 1 to 3 again. Because the declaration key is the same,
`openclaw cron add` updates the existing job and does not create a second job.

## Local microphone input

The [local voice plugin](plugins/grogu-local-voice/README.md) uses an installed
whisper.cpp executable and model through the existing transcription relay.
Tap the microphone, speak, stop, edit the transcript, and send it to the same chat.
Sparky remains the reasoning model. The plugin does not upload audio or download a model.
No speech model stays loaded. Each Stop starts one short `whisper-cli` process.
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
creating the unsigned-in Grogu profile and installing a separate Grogu app.
If the approved UI tool cannot reach that profile without opening a personal
profile, stop and have the owner expose the profile chooser.
Do not bypass the tool with shell launch, focus commands, or browser debugging.

After that confirmation, use the supported Chrome UI:

1. Create a new profile through Chrome's profile chooser.
2. Name the profile `Grogu` without enabling Google sign-in or synchronization.
3. In that profile, open the same credential-free Control UI URL as the old app.
4. Use Chrome's web-app installation UI to install the app.
5. If an app shortcut is needed, open `chrome://apps` in that profile.
6. Select **Create shortcut** for the installed app.
7. Make sure that the shortcut opens a separate window in the Grogu profile.

If Chrome offers a name field, use `Grogu Chrome`.
Otherwise, keep Chrome's installed name, such as `OpenClaw Control`, and record that name.
Do not edit generated app metadata or replace the Safari app to force a name.

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
5. Deploy deliberately: `release-build`, `release-verify`, stage and check,
   cut over through the native service, then `status`, `policy-check`, and
   `bootstrap --apply`. The native updater owns temporary migration recovery
   copies. Release manifests are never certified for rollback because state
   migrations can be one-way. No routine local full backup is required.

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
