# Research Topics

This plugin owns one private research ledger for trusted chat agents and automations.
It registers the `research_topics` agent tool through the public Plugin SDK.
It makes no network requests and sends no messages.
It does not start a research loop or install an automation.

The ledger uses `<stateDir>/research-topics/ledger.sqlite`.
It does not read the workspace's Markdown files or financial records.
Topic lists and due lists contain bounded summaries, not full notes.
Long findings stay in separate private artifacts. `findingsRef` points to those artifacts.

## Enable the plugin

Install this directory with OpenClaw's native plugin installer, or add its absolute path to `plugins.load.paths`.
For an installed copy, keep the entire directory, including `store.worker.ts`.
The plugin declares its `typebox` dependency.
It requires the Plugin SDK shipped with OpenClaw 2026.10.7 or later.

Merge the following entries into the existing configuration. Preserve other plugin and tool permissions.
Replace the example path with the plugin directory on the Gateway host.

```json5
{
  plugins: {
    load: { paths: ["/path/to/research-topics"] },
    allow: ["research-topics"],
    entries: { "research-topics": { enabled: true } },
  },
  tools: {
    alsoAllow: ["research_topics"],
  },
}
```

The tool is optional. Include `research_topics` in the effective permissions of each selected agent.
If a scheduled payload defines `toolsAllow`, include `research_topics` there too.
Keep existing fetch and messaging permissions. This tool does not replace them.
Expose this shared ledger only to trusted agents that act for the owner.
The plugin adds no channel-specific behavior, model selector, or new Gateway API.

## Tool contract

Every call has an `action`. All timestamps are Unix milliseconds from the Gateway host.
Ids use lowercase letters, digits, dots, underscores, and hyphens, with a maximum length of 96.
Use stable ids so repeated intake finds the same topic.
Unknown fields and invalid arguments fail without a write.

| Action                | Arguments besides `action`                                                | Result                                                             |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `list`                | Optional `status`, `limit` (1–50, default 20), `after`                    | `{topics, nextCursor}` with summaries ordered by id                |
| `get`                 | `id`                                                                      | Full topic with its `sources`                                      |
| `add`                 | `id`, `title`, optional topic fields                                      | Full topic. Existing ids fail without overwriting                  |
| `update`              | `id`, `expectedRevision`, `changes` containing topic fields               | Full topic. Stale revisions fail                                   |
| `remove`              | `id`, `expectedRevision`, optional `hardDelete` (default false)           | Archived topic, or `{id, deleted:true}`                            |
| `due`                 | Optional `limit` (1–50, default 10)                                       | `{topics}` with eligible summaries                                 |
| `acquire`             | `id`, optional `leaseMinutes` (1–60, default 15)                          | `{acquired:true, ...topic, sources}` or `{acquired:false, reason}` |
| `record_check`        | `id`, `leaseId`, `sources`, optional `nextDueAtMs`                        | Full topic after the check                                         |
| `record_notification` | `id`, `confirmedAtMs`                                                     | Full topic after confirmed successful notification delivery        |
| `signal`              | `id`                                                                      | Makes an active topic due now                                      |
| `source_list`         | Optional `limit` (1–50, default 20), `after`                              | `{sources, nextCursor}`                                            |
| `source_set`          | `id`, `minimumIntervalMinutes`, `expectedRevision` for an existing source | Full source                                                        |

Topic fields for `add` and `update.changes`:

| Field            | Values and defaults                                                     |
| ---------------- | ----------------------------------------------------------------------- |
| `title`          | Nonblank text, at most 240 characters. Required for `add`               |
| `why`            | At most 1,000 characters, default empty                                 |
| `priority`       | `high`, `normal` (default), or `low`                                    |
| `status`         | `active` (default), `paused`, `done`, or `archived`                     |
| `cadenceMinutes` | Integer 1–525600, default 360. `null` means on-signal                   |
| `origin`         | `owner` (default), `noticed`, or `automation`                           |
| `notifyBar`      | What merits a notification, at most 1,000 characters, default empty     |
| `notes`          | At most 2,000 characters, default empty                                 |
| `findingsRef`    | Private artifact reference, at most 1,000 characters, default empty     |
| `sourceIds`      | Up to 20 distinct, previously defined source ids, default empty         |
| `nextDueAtMs`    | Timestamp or `null`. Default now for timed topics, `null` for on-signal |

Changing the cadence resets the next due time to now, or to `null` for on-signal.
An explicit `nextDueAtMs` in the same update overrides that reset.
`signal` does not resume a paused, done, or archived topic.
An active signal received during a check stays pending after that check settles.
The source limits still apply to signals.
Archive retains the topic. Hard deletion removes the topic and its source links, not shared source history.

Each `record_check.sources` item has `id`, `outcome`, and optional `retryAfterMinutes`.
The outcome is `ok`, `throttled`, `error`, or `skipped`.
Supply exactly one outcome for every source returned by `acquire`.
Use an empty array when the topic has no sources.
Keep `notes` and `findingsRef` edits separate through `get` and `update`.
This prevents a completed check from overwriting a concurrent owner edit.

## Planner and source limits

Run one planner on the chosen schedule, for example every 30 minutes.
The planner first calls `due`, then acquires each selected topic before any fetch.
`due` sorts high priority first, then normal, then low.
Within each priority, the oldest due time comes first. The id breaks ties.
It excludes inactive topics, future topics, live reservations, and topics with any unavailable required source.

A lease is a short reservation for one check and all its required sources.
Acquisition reserves all sources in one transaction.
Two planners cannot acquire overlapping sources at the same time.
Do not fetch after the lease expires. A late result fails instead of replacing a newer check.
Choose enough lease time for the bounded work and settle it promptly.
If a worker crashes, the reservation expires. The source's minimum interval still applies.

Source state separates these facts:

- `lastAttemptedAtMs` records acquisition, before network work. It conservatively counts a reservation even if the worker crashes or skips a source.
- `lastFetchedAtMs` records the successful result time only. Failures never advance it.
- `lastStatus` records the last settled outcome.
- `backoffUntilMs` blocks new acquisition after a refusal or error.

The next source attempt must wait until both its minimum interval and backoff expire.
The interval applies after acquisition and after a successful result.
Error and throttling backoffs also cover the minimum interval after settlement.
This keeps a slow check from releasing a source too early.
A throttled result defaults to a backoff of 30 minutes or the source interval, whichever is longer.
An error defaults to five minutes or the source interval, whichever is longer.
Use `retryAfterMinutes` for a provider's `Retry-After`, rounded up.
The minimum source interval still applies if that value is shorter.
Only attach sources required by a check. Use the same id for a shared provider limit across topics.
The plugin cannot enforce a limit against a caller that bypasses acquisition or an unrelated external client.

`record_check` advances `lastCheckedAtMs` for any completed check, including failures.
It schedules the next check from the current cadence, unless a new signal or explicit override applies.
It preserves concurrent priority, status, cadence, due-time, and note edits.
Pausing or archiving takes effect immediately for future selection.
A current fetch can finish and record its outcome, but cannot reactivate the topic.
Changing sources or hard deleting waits for a live lease to settle.
Call `record_notification` only after a message succeeds.
Supply its canonical confirmation time as `confirmedAtMs`, not the time of a later ledger update.
The time must be after topic creation and cannot be in the future.
Repeated or older confirmations leave the topic and its revision unchanged.
The ledger does not send messages or deduplicate external delivery.

### Confirm scheduled notifications

Guarded scheduled delivery happens after the model returns.
Do not call `record_notification` in that model turn.
Before returning a notice, link the saved finding to its topic and exact job/run identity.
That link records intent, not delivery.

On a later existing planner or Main turn, read the canonical completed run with `automations` action `runs`.
Match its job/run identity, finding, topic, and intended recipient.
Require `status: "ok"` and primary `deliveryStatus: "delivered"`.
Do not count `failureNotificationDelivery`, an error notice, a quiet run, or an uncertain result.
Leave ambiguous matches unrecorded and do not resend to resolve uncertainty.

Use the completed record's `ts` as `confirmedAtMs` when no more precise canonical confirmation time exists.
That value is the finish/confirmation time, not an exact provider send time.
The trusted caller owns this reconciliation.
The plugin does not read delivery records or install an automatic delivery callback.
Hook observations, queued work, and model output alone are not delivery records.

## Import existing topics

The separate deployment task owns migration and retirement of the old research loop.
Do not run the old loop and the new planner together against the same providers.
This plugin does not parse or change Markdown automatically.

On the Gateway host, read the old private research file once and prepare bounded topic records.
Keep that input outside all repositories.
For each shared provider, call `source_set` with its known minimum interval.
For each topic, call `add` with a stable id, title, cadence, status, origin, and source ids.
Put a short summary in `notes` and keep long findings in the existing private artifact.

On a repeated import, use `get` for each stable id before calling `add`.
If the topic exists, compare it and use `update` with its current revision only for intended changes.
Do not overwrite chat edits or treat a failed add as success.
Use `list` pagination to reconcile topic counts and inspect representative records after import.
Historical timestamps are not guessed or imported. Newly added timed topics start due now.
For known provider cooldowns, set the imported topics' `nextDueAtMs` conservatively before starting the planner.

## Storage and updates

The private directory uses mode `0700`. The database uses mode `0600`.
SQLite WAL mode permits concurrent readers. Full synchronous commits protect acknowledged writes.
The existing SDK worker broker owns database execution and drains writes during cleanup.
No database access runs on the Gateway main thread.
Synchronous transactions and revision comparisons prevent partial writes and lost edits.
There is no application-level result cache to become stale across processes.
Indexed due selection and cursor pagination avoid reading every note on each planner run.

The plugin admits schema version 1 once per connection and refuses newer versions without changing their schema.
It does not change OpenClaw's state or agent schemas.
Disabling or removing the plugin leaves its database intact.
Updates preserve it, and older code must not open a newer plugin schema.
Back up this private database through an SQLite-aware backup or after the Gateway stops.
The plugin does not install a backup schedule or delete data automatically.
