# Shared Grogu policy and cooperating jobs

This optional plugin supplies one complete assistant policy to configured Grogu
agents, including lightweight automation runs. Each job keeps its own brief.
The policy owner is [policy/AGENTS.md](policy/AGENTS.md); do not copy it into
workspace files or saved job messages.

The plugin uses the public `before_prompt_build` system-context contract. It
does not replace the base prompt, change tools, read transcripts or private
sources, execute tasks, send messages, or write state. Its small in-memory view
contains only configured team roles and observed native cron activity. Changing
observations go in request context, not the stable system prefix. Scheduler
identity, reconciliation and plugin disposal retire observations. Removed
bindings reject late terminal acknowledgments; only a current matching addition
or reconciliation re-admits them. Missing observations are explicitly unknown.

## Configure the existing roles

Install reviewed retained source with the native plugin installer. Enable
`grogu-coordination` and grant only its documented conversation/prompt-hook
access. Configure `agentIds` and `jobs` inside
`plugins.entries.grogu-coordination.config`; personal agent/job/session bindings
belong in the protected installation configuration, never this repository.
Set `plugins.entries.grogu-coordination.hooks.allowConversationAccess: true`
and do not disable its prompt injection. The Grogu workspace template assumes
this plugin is installed and enabled.

Each job has `id`, `agentId`, a short `label`, and a `role`: `intake`, `personal`,
`financial`, `purchase-watch`, `research`, `review`, or `reminder`. An optional
`sourceSessionKey` identifies the originating subject, not permission to send
there. Intake and personal roles receive related shopping-subject references
only for their own agent; unrelated agents do not receive those private keys.
Every job agent must be in `agentIds`; ids must be unique. Preserve
existing activation, schedules, source scopes, delivery routes, Sparky/Ultra and
zero execution budgets.

On policy/config changes use `openclaw plugins reload grogu-coordination` or the
native hybrid config-reload owner. Already-admitted turns keep their prepared
input. Do not restart a Gateway or cancel a productive job just to refresh policy.

The shared policy holds unsolicited notifications during the owner's default
00:00-06:00 quiet window, including delayed or long-running jobs. Explicit owner
requests still receive answers. This is a prompt policy, not a transport timer:
the existing research/delivery owner preserves pending findings and confirms
delivery. The plugin does not create a queue or certify a hard quiet-hours gate.

## Cut over without losing instructions

Prove the installed hook and complete policy on full and lightweight run paths
before removing temporary payload copies. Keep job-specific source rules and
work state. The shared policy points eligible workers at the existing task,
purchase, intake and confirmed-delivery owners; it grants no new read or write
authority and introduces no parallel store.

A verified purchase must close the matching decision, reconcile an existing
task, acknowledge the purchase once and update the originating same-owner
conversation through a supported delivery operation. Those are separate outcomes.
This plugin does not pretend that a prompt creates a missing task mutation or
conversation-delivery capability; that capability must be wired at its owner.

## Check

```sh
node --import ./scripts/tsx.mjs --test grogu/plugins/grogu-coordination/src/index.test.mjs
node scripts/run-vitest.mjs test/grogu-coordination.test.ts --maxWorkers=1
openclaw plugins inspect grogu-coordination --runtime --json
```

Package/runtime proof must use the installation's pinned host and an isolated
configuration with synthetic bindings. Runtime inspection in a separate CLI
process is not proof that the serving Gateway has activated the hook.
The source test command uses the repository's SDK-aware loader; an installed
plugin with its `openclaw` peer available can use its package test script.
