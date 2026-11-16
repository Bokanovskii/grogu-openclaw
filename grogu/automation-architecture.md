# Continuous personal research

Grogu keeps useful questions active across conversations and new source
evidence. This design is part of the product. An installation supplies the
private facts and access that make the research useful to its owner.

## Tracked design and private data

The repository contains reusable code, schema migrations, generic instructions,
worker templates, and synthetic tests. Personal interests and examples from
real conversations never belong in those files.

| Owner                                  | Responsibility                                                                    | Storage                                    |
| -------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| Research Topics plugin                 | Current goals, details, source evidence, tags, conversation links, and completion | Private SQLite                             |
| Native scheduler                       | Schedules, source cursors, admitted runs, and run outcomes                        | Native SQLite                              |
| Native conversation and channel owners | Messages, access, pending input, and delivery outcomes                            | Native state                               |
| Grogu coordination plugin              | Shared behavior and Main-only text instructions                                   | Tracked policy files                       |
| Worker brief                           | A focused source or research task                                                 | Tracked template, private rendered payload |
| Installation configuration             | Source access, agent and job IDs, routes, models, quiet hours                     | Protected private configuration            |
| Owner fact files                       | Preferences, plans, and other facts outside the research ledger                   | Private workspace                          |

Markdown holds instructions or named user documents. It is not a second live
research database. JSON configuration selects runtime capabilities and bindings.
Neither a Markdown instruction nor a saved session ID grants access.

## One topic from several conversations

Chats push ongoing questions into `research_topics` while the context is
available. Source producers use the same intake path. An event, an email, and
a conversation can contribute evidence to the same goal.

Use a known topic ID directly. Otherwise, indexed title, alias, category, and
session lookup returns a small candidate list. The current conversation model
compares likely goals before creating another record. Full details are read
only for relevant matches. This avoids a large topic dump in every prompt or
an extra model call just to classify the request.

A topic records its purpose, known details, unfinished questions, category
tags, priority, source references, and relevant originating conversations.
The current conversation attaches its own identity. Model-supplied destination
IDs require authority before they can become a delivery path.

Routine bookkeeping stays in tool details. The final answer addresses the
owner's question. Recorded completion is different because the owner receives
an acknowledgment.

## Focused source producers

Every producer follows the [same bounded intake contract](templates/workers/producer.md).
It reads new evidence, gathers useful immediate context, updates the topic,
and offers a worthwhile text candidate to Main.

[Inbox](templates/workers/inbox.md) watches Gmail and Messages through separate
metadata polls. Each poll retains its own source cursor, continuation, and
failure state. Both feed the same role and topic owner.

[Daily prep](templates/workers/daily-prep.md) reads calendar and weather.
[News](templates/workers/news.md) contributes new reporting every thirty minutes,
including overnight. Collection schedules are independent of notification hours.

Ongoing deep research belongs to the continuous researcher. A producer can
update an existing topic from new evidence without repeating its full research.
An unchanged source is a recorded non-outcome. A failed read stays distinct
from a successful search with no matches.

To add a producer, supply a focused source brief, admitted tools, and a native
schedule. Reuse the existing metadata trigger when it fits. Otherwise, use a
bounded scheduled read. The producer reuses topic intake and Main handoff.
It needs neither a new coordinating agent nor a separate ledger.

## A fair continuous queue

The [researcher](templates/workers/research-planner.md) advances several useful
questions per pass. Every pass is a fresh isolated run, so the topic owner holds
the memory between passes and the stable policy prefix stays small and shared.
Changing details arrive through bounded tool results.

Fair rounds prevent recurring high-priority questions from taking every turn.
The topic owner stores service counts. Eligible topics sort by least service,
then priority and waiting order. A useful unit advances the service count.
New topics enter the next round, after work already waiting in the current round.
An empty queue starts at round zero. New high-priority arrivals cannot repeatedly
jump ahead of an older normal or low-priority topic.

Priority therefore affects order, not exclusive access to a small pool.
A category-focused pass can help related work, but the wider queue still needs
service. A blocked source cannot be treated as completed research.

General questions stay ready while useful work remains. Monitoring requires a
specific changing fact, a reason, and a next-read time. Waiting records what
the owner or an external event must resolve.

There are no exclusive topic claims. Two researchers can investigate the same
question. SQLite serializes writes, and content revisions prevent an older
read from overwriting newer details. A conflict requires a reread and merge.
Shared source limits remain separate from topic concurrency.

The researcher can merge equivalent goals discovered during work. The
transaction checks both revisions, reconciles details, unions relevant links,
and removes the duplicate. Affected conversations receive the correction.

## Main and useful conversation updates

Researchers use `post_update` to return findings to recorded source conversations.
The plugin uses the native transcript writer and broadcasts the stored message.
It checks the exact conversation identity and current invocation before commit.
This updates the original discussion without sending another phone text.
The native file lock spans topic selection through that write. Conflicting
topic changes wait, while lookup and other reads remain available. Its temporary
lock file contains owner metadata, not another research ledger.

Only worthwhile text candidates and required completion acknowledgments go to
Main through `notify_main`. The native session owner queues a real Main turn
and returns its run ID. A routine research pass saves its result and stays quiet.
Successful jobs do not automatically wake Main.
Automations that call `notify_main` use an isolated session target. A job that
reuses a stable `cron:` root session fences its web requests to that run. The
Main turn it starts inherits the fence and fails once the caller ends.

Main uses recent worker inputs, its text decisions, confirmed sends, and owner
replies to decide what to send. Repetition avoidance is contextual and best
effort. There is no separate strict notification ledger.

The [Main policy](plugins/grogu-coordination/policy/main.md) owns text style and
decision rules. The installation supplies quiet hours and the approved route.
Direct owner replies retain normal conversation behavior.

Route the owner's phone replies into the same Main conversation. For an
otherwise isolated installation, use a route binding with the exact channel,
account, and direct peer, plus `session.dmScope: "main"`. Preserve global DM
isolation, other bindings, and existing conversation history. Main then receives
new phone replies directly instead of polling another chat.

Main needs the native `message` tool for its approved owner route. A global
deny still blocks an agent allow. Keep other agents restricted when reconciling
that policy. Every producer and researcher needs an explicit tool cap without
`message`, `delivery.mode: "none"`, and no independent failure-alert text route.
Clear old delivery destinations when changing an existing job to `none`.
A producer or researcher ends a quiet run with one short status line, not
`NO_REPLY`. Admit `browser` only on a host that has one, because every call
to a missing browser fails.
Main's morning review can include `message` to revisit held findings and
`completion_pending` topics after quiet hours.

A queued handoff is not a delivered update. Native operation IDs identify
uncertain work for reconciliation. Do not resend merely because a wait expired.
Session access, current identities, and channel permissions remain authoritative.

## Purpose-based completion

Each topic has a completion rule. An answer can finish when its question is
resolved. A buying decision can wait for a purchase or an explicit decision
to stop. Monitoring can continue while the recorded goal remains active.

The model judges evidence against that rule. Research Topics is deterministic
code, not another model. Its transactions enforce revisions and completion
conditions.

Completion stops further research. A pending record retains the required
originating-thread updates and Main acknowledgment until they settle.
Main prepares the final completion text through `prepare_text`, then sends it
with the normal `message` tool. The plugin records the native successful send
receipt only for that text, Main incarnation, and configured owner route. The
receipt rules accept the host's delivery fact or, for a plugin-handled send
without one, the channel's success envelope with a message ID. If a receipt is
missing after a send, Main calls `confirm_completion`, which finds the send by
its prepared wording in Main's recent history. Main sends the wording again only
when that finds nothing.
Partial, simulated, and uncertain sends leave the acknowledgment pending.

Final removal follows the deterministic owner's conditions. Model-generated
wording or an accepted request alone does not prove delivery. Unsupported or
uncertain outcomes remain pending rather than deleting evidence.

An explicit owner correction reopens the topic with its current revision.
This cancels the old completion identity without erasing the research or links.
Previously sent messages remain in their original conversations.

Explicit forget and do-not-notify requests retain their own authority.
Completed or merged records do not become an archive of obsolete interests.

## Installation and changes

Install the reviewed plugins and render focused worker briefs through native
owners. Preserve existing source permissions. A tool cap is a separate ceiling,
so a configured capability also needs admission in its scheduled job.

Reconcile private source templates, rendered scripts, tool caps, and schema/hash
pins together. Use current native configuration revisions. Keep admitted work
intact while its old plugin generation settles.

A saved installation is not proof of activation. Inspect the running Gateway
through `plugins.list`, including the selected version and `runtime.state`.
If an old explicit `plugins.load.paths` entry shadows the managed replacement,
remove only that verified obsolete override through native configuration.
Use the native reload owner to settle a saved replacement, not another install.

Before a schema change, establish the current version and supported migration.
Use the migration owner's transaction rather than direct live SQL edits.
Reject incompatible state before mutation. The reviewed no-backup cutover
does not create duplicate personal archives.

Move current facts out of obsolete lists before removing their readers.
Delete only named obsolete files and task-owned copies. Preserve original
conversations, current facts, and requested documents.

Inspect custom health scripts before deleting old state. A legacy watchdog can
still recreate retired research or notification files after model jobs stop.
Use `openclaw health --json` for a native health-check command job when that is
the required responsibility. Native scheduling retains retry and run outcomes.
Do not replace an active recovery or power-management owner without accounting
for its work.

Set the agent's `heartbeat.every` to `"0m"` to stop an empty periodic cadence
while preserving targeted event wakes. Read `agents.files.list` for the serving
build's actual instruction files. An obsolete `HEARTBEAT.md` is not a substitute
for a native job or an active instruction owner.

Verify the actual source intake, topic update, fair selection, conversation
return, and completion flow. A passing helper test or a reloaded CLI process
does not prove that the serving Gateway changed.
