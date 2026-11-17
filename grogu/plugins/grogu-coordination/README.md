# Grogu shared instructions

This plugin supplies stable instructions to selected Grogu agents, including
lightweight jobs. The [shared policy](policy/AGENTS.md) covers topic intake and
evidence. The [Main role](policy/main.md) owns automatic text decisions and
formatting. Jobs carry focused briefs rather than copies of either policy.

The plugin only injects instructions. It does not scan conversations, forward
side-chat events, or wake Main after every successful job. Producers explicitly
offer useful findings through native conversation delivery. A quiet successful
run stays quiet.

## Configure

Configure `plugins.entries.grogu-coordination.config` with:

- `agentIds`: agents that receive the shared policy.
- `mainAgentId`: the one selected agent whose canonical Main receives the Main
  role. Set this explicitly for new installations.
- `jobs`: job metadata with unique `id`, `agentId`, `label`, and a focused `role`.
  An optional `sourceSessionKey` identifies its originating subject.
- `quietHours`: optional local `start`, `end` (`HH:mm`), and IANA `timeZone`.
  Store the owner's selection in private configuration, not in a policy file.

Role names are descriptive and extensible, such as `intake`, `research`, or
`snow-forecast`. They do not grant tools or permissions. Adding a producer uses
the common [producer contract](../../templates/workers/producer.md), a source
brief, admitted tools, and a native schedule.

Existing configurations without `mainAgentId` use their single `intake` job's
agent. Multiple intake jobs require an explicit Main selection. With no
selection, the plugin supplies shared instructions only. Private IDs remain
in the installation configuration.

Enable conversation access for prompt injection through
`plugins.entries.grogu-coordination.hooks.allowConversationAccess: true`.
The plugin uses `before_prompt_build` and `before_model_resolve`, preserves
tools and conversation bytes, and reads policies once per registration. It
rejects missing or oversized policies. It adds no changing activity table to
ordinary prompts. The live reads are Main's owner text route (see Research and
delivery) and the agent's configured model (see Models).

## Research and delivery

Every relevant chat and source producer uses `research_topics` to look up,
merge, and update goals. Routine bookkeeping stays internal. Producers make
bounded passes over new evidence. The continuous researcher develops recorded
questions and returns useful findings to their originating threads.

Main combines explicit candidates with recent worker inputs, text decisions,
sent-message outcomes, and owner replies. Repetition avoidance is contextual
and best effort. Completion requires an acknowledgment, but nonurgent texts
wait during the configured quiet hours. A queued request is not
confirmed delivery.

Keep normal native thread delivery, source permissions, and session visibility.
The plugin does not create a new transport, hidden transcript operation, or
notification database. A session reference never grants access.

Automatic Main runs, such as scheduled reviews, have no owner conversation to
infer a destination from, and a conversation compaction can drop the route from
Main's history. So each Main turn carries one line with the owner text route,
read from `plugins.entries["research-topics"].config.delivery` when the prompt
is built. A changed route applies to the next turn, and the line appears only
when `delivery.agentId` is the Main agent. Without it, Main sends nothing and
keeps the finding pending. The route is installation configuration and never
part of this repository.

An automatic Main run ends with one plain status line after a send, a hold, or no
text, and that line is never delivered. A silent ending (`NO_REPLY`) after tool
calls in a candidate handoff run makes core run an extra text-only pass and keep
its "tools are unavailable" note in Main's history. That happens after a send too,
because a send from a run with no source conversation does not count as a
delivered reply. The policy tells Main to ignore such a note, and job prompts
leave the ending to the policy.

## Models

The owner can choose a different model for one chat. That choice is for the
owner's own messages. Runs that the system starts in that chat use the agent's
configured model instead, for that run only. The chat keeps its saved choice.

A run counts as system-started when its input came from another session (for
example `sessions_send` or a subagent result) or from an internal system source
(for example a heartbeat, a restart notice, or a background event). These
internal sources continue the owner's own turn or request, so they keep the
chat's model: `openclaw_agent_consult`, `session-companion`, `sessions.recover`,
`session_goal_resume`, `exec_approval_followup`, and `stalled-turn-recovery`.

Core owns some models, and this plugin does not change them: scheduled jobs
(set on the job and checked by the native policy check), memory flushes, and
heartbeats when a heartbeat model is configured. Plugin subagent runs carry no
input source, so the plugin that starts them must pass the model itself.

The configured model is `agents.entries.<id>.model`, or `agents.defaults.model`
when the agent sets no primary. It is read live and must be a
`provider/model` reference. A missing or unqualified model reports a hook error
instead of guessing the provider.
Requires core with input provenance in model hooks (2026.10.7 builds after
Grogu PR 92).
This hook covers native provider execution. External CLI backends bypass these
hooks and are not covered by this model policy.

Main's normal `message` send is restricted to the configured owner route.
The tool hook fills omitted channel, target, and configured account fields.
It blocks conflicting routes, broadcasts, and reply/thread modifiers instead of
guessing a recipient. Missing delivery configuration also blocks the send.
This applies to Main, including manual messages there; other chats retain their
normal messaging behavior. It adds no tool and sends no text itself.

## Update

Install the reviewed package with the native installer, then reload through
`openclaw plugins reload grogu-coordination`. Preserve an active generation if
reload cannot settle admitted work. Existing turns retain their prepared
instructions; new admitted turns receive the installed policy.

Version 1.1 removes implicit side-chat and successful-job nudges. Install the
explicit worker handoff prompts and tools in the same cutover. Keep native
event wakes, but do not count them as evidence of a delivered finding.

## Check

```sh
node --import ./scripts/tsx.mjs --test grogu/plugins/grogu-coordination/src/index.test.mjs
node scripts/run-vitest.mjs test/grogu-coordination.test.ts --maxWorkers=1
openclaw plugins inspect grogu-coordination --runtime --json
```

Runtime inspection in a separate CLI process does not prove that the serving
Gateway activated the new generation. Verify the actual installed cutover.
