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

## Repository history

`main` carries the real upstream history (about 7 GiB packed at `v2026.10.7`),
so each stable release merges with a true merge base and keeps its canonical
commit ID. On a new machine, clone with `git clone --filter=blob:none` to skip
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

## Commands

Run from a checkout with the toolchain in `toolchain.json`:

```sh
node --import ./scripts/tsx.mjs grogu/maint.mts --profile <profile> <command>
```

Release builds install the same CLI as `dist/grogu-maint.js`.

| Command                         | Effect                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                        | Native service status plus a read-scope `health` call; no model calls.                                                                                        |
| `policy-check`                  | Reads native config and all jobs; exits 1 if any automatic selector, fallback or job route leaves `automaticModel`, or a required channel queue mode drifted. |
| `backup`                        | Complete native online archive, verified, with a private digest receipt.                                                                                      |
| `verify-archive <archive>`      | Native archive and SQLite inventory verification.                                                                                                             |
| `restore-stage <archive> <dir>` | Restores into an empty staging directory; never activates or starts channels.                                                                                 |
| `bootstrap [--apply]`           | Revision-checked metadata reconcile for bound jobs; preview by default.                                                                                       |
| `release-build <source>`        | Builds a source-pinned native package; never activates it.                                                                                                    |
| `release-verify <manifest>`     | Checks the package digest and platform.                                                                                                                       |
| `upstream-check --source <dir>` | Reads the designated stable upstream release; no mutation.                                                                                                    |

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

Gmail authorization verification stays separate from worker correctness. Use
the existing non-mutating verify-only command after consent includes the
read-only Gmail scope. For a forced refresh test, copy credential material into
an owner-only isolated state and expire only the copied access-token cache.
Production app audience avoids testing-mode seven-day expiry, but refresh
tokens can still be revoked; a low-frequency health check must distinguish
missing scope, revocation, and transient network/provider failure.

## Taking in upstream releases

1. `grogu-upstream.yml` runs daily (or on dispatch) in the private repository.
   It finds the newest stable OpenClaw release, merges it onto `main` in the
   rolling `grogu/upstream` branch, archives any new upstream workflows, updates
   `upstream.json`, and opens or refreshes one draft PR. It never enables
   auto-merge, deploys, or makes model requests.
   - It needs the `GROGU_UPSTREAM_TOKEN` secret: a fine-grained token limited to
     this repository with Contents, Pull requests, Actions, and Workflows write.
     The built-in `GITHUB_TOKEN` cannot push upstream commits that touch
     `.github/workflows`.
   - Install scripts are skipped and Git hooks are disabled, so no
     upstream-controlled code runs while that token is present.
2. It dispatches `grogu-ci.yml` for the exact prepared commit, so the CI
   evidence is pinned to that SHA.
3. If the merge conflicts, the run fails, lists the conflicting files, and
   leaves the remote branch unchanged. Resolve the merge locally on a branch
   from `main` and open the PR by hand.
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
