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

## Commands

Run from a checkout with the toolchain in `toolchain.json`:

```sh
node --import ./scripts/tsx.mjs grogu/maint.mts --profile <profile> <command>
```

Release builds install the same CLI as `dist/grogu-maint.js`.

| Command                         | Effect                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                        | Native service status plus a read-scope `health` call; no model calls.                                                                                                                      |
| `policy-check`                  | Reads native config and all jobs; exits 1 if any automatic selector, fallback or job route leaves `automaticModel`, or a required channel queue mode drifted.                               |
| `compaction-stage`              | Writes a validated candidate configuration and a small original-configuration recovery copy. Apply checks exact configuration hashes, needs no full backup, and never restarts the Gateway. |
| `backup`                        | Retired. Exits with an error without creating a local full backup.                                                                                                                          |
| `verify-archive <archive>`      | Native archive and SQLite inventory verification.                                                                                                                                           |
| `restore-stage <archive> <dir>` | Restores into an empty staging directory; never activates or starts channels.                                                                                                               |
| `bootstrap [--apply]`           | Reconciles bound job metadata and installs the small-disk storage policy; preview by default.                                                                                               |
| `storage-bootstrap [--apply]`   | Disables local full-backup schedules and installs one hourly native cleanup job without a model call; preview by default.                                                                   |
| `storage-cleanup [--apply]`     | Disables local full-backup schedules and retires eligible temporary artifacts; preview by default.                                                                                          |
| `workers-bootstrap [--apply]`   | Preview or revision-check installation of private deterministic source triggers; writes private rollback facts and never invokes a model itself.                                            |
| `release-build <source>`        | Builds a source-pinned native package; never activates it.                                                                                                                                  |
| `release-verify <manifest>`     | Checks the package digest and platform.                                                                                                                                                     |
| `upstream-check --source <dir>` | Reads the designated stable upstream release; no mutation.                                                                                                                                  |

Native calls write owner-only receipts under the profile's `recoveryDir`.

### Small-disk storage policy

Grogu does not create routine local full backups or retain historical release
packages. Git preserves source, not conversations, credentials, or databases.
Removing recovery copies permanently loses the ability to restore those earlier
states.

After installing a Grogu release, run the normal bootstrap with the protected
profile. The installed release must include `dist/grogu-maint.js`.

```sh
node /path/to/installed/openclaw/dist/grogu-maint.js \
  --profile /path/to/private/profile.json bootstrap --apply
```

Bootstrap disables native full-archive backup jobs that target filesystem
storage and legacy Grogu backup workers. It preserves remote backup schedules,
Git snapshot jobs, unrelated automations, and running work. A running backup
is reported as deferred and must finish before the next cleanup disables it.
The old backup contract marker is retained only to identify installed legacy
workers during migration.

The hourly cleanup runs as a native command job, not an agent turn. It uses
the installed Node and maintenance CLI from the private profile, so it needs
no source checkout or machine-specific paths. Its run history records failures
and deferred work. No new operating-system scheduler or model-backed watcher
is required. Repeating bootstrap converges the same declaration-key job.

Completed Grogu backup archives, release packages, and failed package builds are temporary for at most
24 hours plus the next hourly sweep. Cleanup requires their producer receipts
and shares a lock with package builders and archive readers. It preserves the
running installation, state, credentials, active work, and unrecognized files.
The cleanup also retires native update captures and future standalone Doctor
captures after verified success and the same 24-hour recovery window.
Native update ownership and unfinished recovery always block removal.
Older Doctor captures without completion evidence remain protected.
Completed storage-maintenance receipts expire with the same window, so the
cleanup does not accumulate its own private logs.
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
