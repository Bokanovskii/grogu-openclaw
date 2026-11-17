# Research Topics

Research Topics is Grogu's deterministic SQLite owner for shared research briefs,
semantic reconciliation, fair work selection, and provider budgets. Models decide
whether topics are equivalent and whether evidence satisfies a completion rule.
Code owns revisions, links, scheduling facts, and deletion constraints.

The optional `research_topics` tool is internal. Do not narrate ordinary ledger
work to the user. Report actionable errors, respond when asked, and send completion
text through Main. The plugin uses existing native owners for thread updates
and Main handoffs. It does not fetch sources, create per-topic automations,
or send phone messages itself. See [Completion boundary](#completion-boundary).

## Install the private package

From a checkout with the repository's dependencies available:

```sh
cd grogu/plugins/research-topics
npm pack --pack-destination /path/to/artifacts
```

`prepack` compiles the entry and its worker modules into `dist/`. The package
contains JavaScript, the manifest, and this README. It needs no runtime TypeScript
compiler. This is a versioned, private local package, not a registry publication.
Install it through OpenClaw's managed npm project:

```sh
openclaw plugins install npm-pack:/path/to/artifacts/grogu-research-topics-2.1.1.tgz
openclaw plugins inspect research-topics --runtime --json
```

The installer owns the declared `typebox` runtime dependency. The minimum declared
Plugin SDK is OpenClaw 2026.10.7. Preserve existing permissions when merging:

```json5
{
  plugins: {
    allow: ["research-topics"],
    entries: {
      "research-topics": {
        enabled: true,
        hooks: { allowConversationAccess: true },
        subagent: {
          allowModelOverride: true,
          allowedModels: ["provider/automatic-model"],
        },
        config: {
          delivery: {
            agentId: "assistant",
            channel: "telegram",
            target: "telegram:OWNER_CHAT_ID",
          },
        },
      },
    },
  },
  tools: { alsoAllow: ["research_topics"] },
}
```

Include `research_topics` in each selected agent's effective permissions and in
scheduled payload `toolsAllow` when present. Retain the native research and
messaging permissions those roles need. Only trusted owner-facing agents should
access this shared private ledger.

Keep `delivery` private. Its agent owns the canonical Main selected by
`session.mainKey`, or `global` under global session scope. Its channel and target
identify the permitted owner route. Add `accountId` when the installation selects
a particular account. This must agree with the coordination plugin's Main agent,
which shows Main this route on every turn.
Handoffs use this agent's configured primary model, or the shared default,
not Main's saved chat override. Set `subagent.allowedModels` to that exact
model reference. The model applies only to the handoff run. Main keeps the
owner's saved model choice for later messages. Missing configuration or a
denied model fails the handoff visibly.
Without delivery configuration, ledger operations remain available, but handoffs
and completion fail explicitly. Incognito conversations do not receive the tool.

For a development load path, first run `npm run build` in this directory. Keep
the entire `dist/` directory. Remove the superseded development path when switching
to the managed package. Do not run schema-1 and schema-2 workers together.

### Replace an installed package

Install a newer package over the running one with
`openclaw plugins install --force /path/to/grogu-research-topics-<version>.tgz`.
The Gateway applies it only while no agent run is active. Otherwise it waits about
a minute and reports the install as saved but not applied.
`openclaw plugins reload research-topics --wait` applies it once the runs finish,
but a busy schedule may never go quiet. Disable the scheduled jobs that start
runs, wait for running work to finish, install, and enable the same jobs again.

After an in-place replacement, scheduled trigger scripts that call
`research_topics` fail with `ReferenceError: research_topics is not defined`
until the Gateway restarts. Once the install has applied, run one plain
`openclaw gateway restart --json` while no agent run is active, then search
`gateway.log` for `trigger evaluation failed`. Do not use `--safe` for this
restart: it defers behind running cron work and can leave Gateway admission
closed for a long time.

## Reconcile topics in the current turn

The tool schema preserves each action's fields. For example, `lookup` takes
`query` and optional `sessionKey`, `category`, and `limit`; it does not take a topic
`id` or write/completion fields. Do not fill unrelated fields with placeholders.
Provider schema projection and execution use the same action contract.

1. Call `lookup` using the subject's ordinary words, optionally narrowing by
   `sessionKey` or `category` (an exact tag). No raw FTS syntax is accepted.
2. Review the bounded candidates semantically. Call `get` for the relevant brief.
3. Add a new stable ID only when no existing topic fits. Otherwise patch with
   `update`, or supply a reconciled title and brief to `merge`.
4. If either revision changed, reread both records and reconcile again. Never
   blindly replay a stale patch or replace an entire topic from an old read.
5. After a merge, update its `affectedSessionRefs` with `post_update`.
   The native writer checks each recorded conversation's exact incarnation.

Intake automations use this same flow for bounded passes over new evidence.
Only the ongoing research worker advances old topics. No topic is claimed:
researchers may overlap and synthesize saved information independently.

New conversation references must match the current tool invocation's
`sessionKey` and `sessionId`, not a model-supplied identity. `add` automatically
links that conversation when `sessionRefs` is omitted. A conversation cannot see
its own `sessionId`, so it links itself to an existing topic with `link_session`,
which takes only the topic `id` and records the host-supplied caller. The link is
idempotent and leaves the revision unchanged, because a link is not a content
edit and must not invalidate a researcher's pending write. A topic pending
completion rejects it. Scheduled runs cannot link, and they and topics with
`origin: automation` do not automatically become originating conversations.
Explicit new references
may name messages only within that same conversation. Existing references survive
updates and merges; an empty patch array does not unlink them. Legacy topics
without links remain unlinked until a conversation adds its own reference.
No broad send, read, list, or sibling-session grant is installed.
`post_update` writes only to recorded source conversations of the configured
agent, under the current tool invocation and native session writer.

## Tool actions

All actions reject unknown fields. A rejection names the missing, unknown, and
invalid fields for that action so the caller can repair the call. IDs are 1–96
lowercase letters, digits, dots, underscores, or hyphens, beginning with a
letter or digit. Times are Unix milliseconds. The host supplies operation time;
callers do not set service time.

| Action               | Arguments besides `action`                                                                                       | Result                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `lookup`             | `query`; optional `sessionKey`, `category`, `limit` (default 8, max 20)                                          | `{topics, match}`; bounded summaries, never briefs                                                                |
| `get`                | `id`                                                                                                             | Full topic, links, sources, and completion destinations                                                           |
| `list`               | Optional `status`, `after`, `limit` (default 20, max 50)                                                         | `{topics, nextCursor}`, ordered by ID                                                                             |
| `add`                | `id`, `title`, optional topic fields                                                                             | Full topic; duplicate IDs fail                                                                                    |
| `update`             | `id`, `expectedRevision`, `changes`                                                                              | Patched full topic; content revision increments                                                                   |
| `merge`              | Target `id`, `expectedRevision`, `sourceId`, `sourceRevision`, `changes` with required `title` and `brief`       | Target, `mergedId`, `affectedSessionRefs`; source row deleted atomically                                          |
| `link_session`       | `id`                                                                                                             | Full topic with the current conversation linked; revision unchanged; rejected for scheduled runs                  |
| `due`                | Optional `category`, `limit` (default 10, max 50)                                                                | `{topics}` with explainable `score`                                                                               |
| `record_check`       | `id`, `expectedRevision`, `operationId`; optional scheduling fields                                              | Full topic; one service unit recorded                                                                             |
| `source_list`        | Optional `after`, `limit` (default 20, max 50)                                                                   | `{sources, nextCursor}`                                                                                           |
| `source_set`         | `id`, `minimumIntervalMinutes`; `expectedRevision` required when source exists                                   | Full source                                                                                                       |
| `source_attempt`     | `id`                                                                                                             | `{allowed:true, ...source}` including `attemptId`, or `{allowed:false, id, reason, nextAllowedAtMs}`              |
| `source_result`      | `id`, `attemptId`, `outcome`; optional `retryAfterMinutes`                                                       | Full source; stale attempts fail                                                                                  |
| `post_update`        | `id`, `expectedRevision`, `sessionKey`, `sessionId`, `message`, `operationId`; `completionId` for pending topics | Visible native thread message and its stored receipt                                                              |
| `notify_main`        | `id`, `expectedRevision`, `message`, `operationId`                                                               | Accepted native Main run ID, not proof of a text                                                                  |
| `complete`           | `id`, `expectedRevision`, `reason`                                                                               | Frozen topic and required destinations; requires a recorded completion rule                                       |
| `reopen`             | `id`, `expectedRevision`                                                                                         | Explicitly reopens a pending topic for an owner correction; clears completion obligations and returns it to ready |
| `prepare_text`       | `id`, `expectedRevision`, `completionId`, `ownerText`                                                            | Main-only final wording and configured route; changing wording increments revision                                |
| `confirm_completion` | `id`, `expectedRevision`, `completionId`; optional `toolCallId`                                                  | Main-only recovery from its bounded recent native message history                                                 |
| `finalize`           | `id`, `expectedRevision`, `completionId`                                                                         | Deletes only after all required outcomes have native receipts                                                     |
| `forget`             | `id`, `expectedRevision`                                                                                         | `{id, deleted:true}`; immediate permanent deletion for an explicit owner request                                  |

`lookup` uses SQLite FTS5 over title, aliases, and the short `why`/`notes`
summary. It tokenizes at most 16 Unicode word terms and quotes each term before
joining them with OR. Words are literal, not operators. A query matching an exact
ID uses the ID index first, still applying supplied filters. Session and tag
links are indexed. There are no embeddings, model calls, result caches, or
global generation tokens.

### Topic fields

| Field              | Meaning and limits                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `title`            | Nonblank, up to 240 characters; required for `add`                                                                         |
| `brief`            | Full working brief, at most 65,536 UTF-8 bytes; default empty                                                              |
| `why`, `notes`     | Lookup summaries, at most 1,000 and 2,000 characters; default empty                                                        |
| `aliases`, `tags`  | Up to 32 each; nonblank aliases up to 160 characters, tags up to 80                                                        |
| `sessionRefs`      | Up to 64 `{sessionKey, sessionId, messageId?}` references; key/ID/message limits 512/128/256 characters                    |
| `sourceIds`        | Up to 20 previously defined provider-budget IDs, never conversation IDs                                                    |
| `priority`         | `high`, `normal` (default), `low`                                                                                          |
| `purpose`          | `answer`, `decision` (default), `watch`                                                                                    |
| `completionRule`   | Nonblank text up to 2,000 characters or `null` (default); unset means reconciliation needed, not permission to auto-delete |
| `workState`        | `ready` (default), `monitoring`, `waiting`                                                                                 |
| `monitoringReason` | At most 1,000 characters; must be nonblank for monitoring                                                                  |
| `nextDueAtMs`      | Required timestamp for monitoring/retry; otherwise `null`                                                                  |
| `origin`           | `owner` (default), `noticed`, `automation`                                                                                 |
| `notifyBar`        | What merits a notification, up to 1,000 characters; default empty                                                          |
| `findingsRef`      | Optional private artifact reference up to 1,000 characters; default empty                                                  |

Ordinary updates replace only explicitly supplied scalar fields, aliases, tags,
and provider links. Session links are append-only unions of retained and
caller-authorized references. Adds and merges deduplicate links. Merge unions
both topics' aliases, tags, session references, and provider IDs with the supplied
changes. Oversized unions fail without partial writes. The target ID remains
stable; no archived row or redirect preserves the source ID. Merge rejects
either topic while completion is pending.

`status` is owner-controlled: `active` or `completion_pending`, not a patchable
field. `revision` changes on content edits, merges, completion, and reopening. Provider
accounting and routine research service facts do not invalidate content edits.

## Research rounds and provider budgets

New general research is ready immediately. There is no implicit six-hour timer,
recurring cadence, exclusive claim, or queue file. `waiting` work is not selected.
Monitoring requires `workState: "monitoring"` with a real reason and a timestamp
in the same call. Its purpose need not be
`watch`: an answer or decision can explicitly wait for evidence or retry.
Changing back to ready/waiting clears the monitoring reason and due time.

`due` sorts eligible topics by:

1. Lowest persistent `serviceCount`.
2. Priority: high, normal, low.
3. Oldest `waitingSinceMs`, then ID.

`score` reports that round, priority, waiting time, and tie-break ID. A fixed set
of eligible topics each gets a completed unit before another round repeats.
New topics join the next round: their initial service count is the minimum count
of currently eligible work plus one, or zero when none is eligible. They remain
ready without a timer, but cannot jump ahead of topics still waiting in the
current round, even when a new high-priority topic arrives before every unit.
Existing topics keep their service history. Merge preserves the higher service
count, so deduplication does not reset that history.

`record_check` checks the content revision, increments service count once, records
`lastCheckedAtMs`, and puts unfinished work back in `ready` unless the caller
explicitly supplies monitoring or waiting fields. It never replaces the brief.
Use one `operationId` per completed unit. Replaying the **last** operation with
the same facts returns `replayed:true` without another count; changed facts fail.
There is no operation history, so reread after uncertainty once later work has
been recorded. Overlapping independently completed units are not exclusive.

Topics with unavailable attached providers are omitted by `due`, without
resetting their service history. Attach only providers that the next research
unit needs. Saved-info synthesis can proceed without fetching while a provider
cools down.

Before a fetch, call `source_attempt` with the shared provider ID from
`source_list` as `id`, never a topic ID. The transaction
checks interval/backoff and records the attempt before network work. A denial
means do not fetch. There is no long-lived reservation. After the interval,
another attempt can begin even if the first researcher has not reported a result.
The first attempt's late result cannot overwrite the second.

`source_result.outcome` is `ok`, `throttled`, `error`, or `skipped`:

- `lastAttemptedAtMs` records attempts, including crashes and skipped fetches.
- `lastFetchedAtMs` changes only on a successful result.
- `lastStatus` records the last settled outcome; failures remain visible.
- Both attempt time and successful-fetch time enforce the minimum interval.
- Throttling defaults to 30 minutes; errors default to five minutes. Both
  backoffs are at least the configured source interval, measured from settlement.
- Supply provider `Retry-After`, rounded up, as `retryAfterMinutes`. It is
  respected even when longer than the normal interval.
- Repeating an identical result for the current attempt is idempotent.
  A different result for that attempt, or a superseded attempt, fails.

The tool cannot enforce budgets against unrelated clients or callers that bypass
`source_attempt`. Provider rules and current facts remain independent of topic
deletion and completion.

## Completion boundary

`complete` stores the model's completion reason (up to 2,000 characters),
completion identity/time, and immutable destinations. It resolves configured
Main through the public native session owner, not caller-supplied routing.
Main's owner-text obligation is always present, plus one obligation
per distinct linked session key/incarnation. Linked message references remain
available on the topic. Pending completion stops due selection and rejects
updates, merges, and checks, so notices cannot become detached from a later edit.

An explicit owner correction uses `reopen` with the current revision, followed by
`update` with the returned revision. Reopening atomically clears completion
identity, reason, owner text, time, and destinations, then returns the topic to
`active/ready` without a monitoring timer. It preserves the current brief, links,
and service history. Old confirmation/finalization requests fail; later completion
needs a new identity and new obligations. Ordinary producer updates never reopen
a pending topic automatically. Reopening cannot retract notices already sent.

`post_update` calls the public strict transcript writer with the stored session
identity. The write publishes a visible update and returns a native message ID.
The SDK's file lock serializes ledger mutations through this short publication.
A correction or deletion cannot commit between selection and the native write.
Reads remain independent, and SQLite transactions remain synchronous. The
temporary `ledger.sqlite.lock` holds lock-owner metadata, not topic data or
research reservations. Recovery only reclaims a definitely dead owner.
Reuse the same `operationId` only
when reconciling the same update. Native payload comparison rejects changed
content under the same identity. This operation does not send a phone message.

Main uses `prepare_text` to record its final wording, up to 8,000 characters.
Only its exact recorded incarnation can prepare that acknowledgment. Main then
uses the normal `message` tool with that wording and the returned route.
Before the send, the plugin binds that native call to the prepared revision and
completion identity. The `after_tool_call` hook consumes that binding. It records
success only for a send from Main with the prepared wording to the configured
target, with a settled, nonpartial result that carries a platform message ID.
The `channel` and `accountId` may be left out of the call because the message
tool resolves them itself. When the call names them, they must match the
configured route. A call that omits the channel counts only when the target is
qualified by the configured channel. A deployment with several accounts on one
channel must have Main name the account.

The result evidence is the host's delivery fact when the host attached one. The
host attaches that fact only to replies to the run's own source conversation. A
plugin-handled send from another run, such as Main's scheduled review, carries
only the channel's success envelope (`ok` and `messageId`), so the same
projection the host uses for plugin sends is accepted. Failed, simulated,
partial, and skipped sends never count.
Unrelated messages and ambiguous matches do not settle a topic. A send that
started before reopening cannot settle a new completion with the same wording.

The native hook is the normal confirmation path, including nested tool calls.
After an interruption, Main can use `confirm_completion`. The `toolCallId` is
optional, because the model does not see the IDs that the serving layer
generates. Without it, recovery finds the send by the prepared wording. Recovery
reads at most 200 recent native messages in Main. It matches the `prepare_text`
call by its recorded arguments (topic, completion identity, and wording) and
requires that call to have a successful result. It does not read the topic from
the stored result, because the host keeps no topic in a stored result over 8 KiB.
The matching send call must come after that preparation and finish after the
completion was recorded. The result must pass the same rules as the hook. A
supplied `toolCallId` limits the match to that call.
Missing, compacted, or otherwise unavailable evidence leaves completion pending.
Main sends the wording again only when recovery finds no matching send. No
model-provided receipt or success boolean is accepted.

Only native prepared facts cross into the worker. Its transaction rechecks the
topic revision, completion identity, and exact destination. Queued runs,
generated wording, partial sends, and intended messages are not confirmations.
No privileged Gateway request, direct SQL transcript write, or broad visibility
change is used.

`finalize` checks the revision, completion identity, mandatory Main destination,
and all destination confirmations before hard deletion. No archive, tombstone,
or historical topic record remains. `forget` is the separate explicit owner
operation for deletion before notices, not a successful completion.

## Schema-1 migration and recovery

The ledger remains `<stateDir>/research-topics/ledger.sqlite`. Private directory
and database modes remain `0700` and `0600`. All runtime access stays in the SDK
SQLite worker; no Gateway main-thread database reads are added. Kysely queries
run inside synchronous transactions, with current caller admission at transaction
and commit. WAL and FULL synchronous commits preserve the existing durability.

Schema 2 migrates schema 1 in one transaction at connection admission:

- Refuse while any live topic lease remains. Let schema-1 work settle and stop
  its workers before retrying; never invalidate active work to force migration.
- Preserve active topics' IDs, title, priority, origin, summaries, artifact
  references, notification bar, and checked/notified/created/updated facts.
- Preserve source intervals, attempt/success/status facts, and the later of
  source backoff and reservation expiry as a conservative cooldown.
- Active legacy topics become `decision/ready` with an unset completion rule,
  not watches inferred from cadence. Paused topics become `decision/waiting`.
  Briefs retain the old cadence and due time as reconciliation context, not
  live scheduling instructions. Content revisions increment.
- Remove old `done` and `archived` topics rather than creating a historical
  archive. Shared provider records remain.
- Build the lookup/link indexes and remove obsolete cadence, claim, and pending
  signal fields. Verify integrity and foreign keys before committing version 2.

No backup is generated. Failure before commit rolls back schema and data
mutations. Once committed, schema-1 code cannot reopen the ledger: this is a
forward-only migration, not a promise of restoring earlier state. A failed
integrity check requires stopping writes and arranging a compatible forward
repair. Newer schemas are refused. Disabling the plugin leaves its database
intact.

Version-1 `acquire`, `signal`, cadence, lease, archive/remove, and
`record_notification` actions are retired. Its `lastNotifiedAtMs` is retained only
as a current legacy fact, not a native completion receipt. This is an installed
private-plugin migration, not an external public API compatibility promise.
Role prompts must move to the v2 actions together with the package.
