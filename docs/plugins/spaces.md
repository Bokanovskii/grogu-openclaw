---
summary: "Personal lists and research shared by the human UI and permitted agent chats"
read_when:
  - You want to keep To-do, Shopping, Read Later, or Vacation Research content across chats
  - You are enabling Spaces or recovering its saved content
title: "Spaces"
---

# Spaces

Spaces keeps personal lists and research across chats. You and an agent edit the
same saved records. Deleting a chat does not delete a Space.

The bundled plugin uses the existing Gateway and Control UI. It does not add
sharing, public links, another app, or a task executor. Chat, Usage, Artifacts,
and existing saved boards remain separate and unchanged.

## Enable Spaces

Spaces is disabled by default. Enable it on the Gateway that will own your
personal content:

```bash
openclaw plugins enable spaces
openclaw plugins inspect spaces --runtime --json
openclaw dashboard
```

If your configuration uses `plugins.allow`, include `spaces` there. Open the
Spaces page in an authenticated Control UI session. Reading requires
`operator.read`, and saving requires `operator.write`.

Allow `spaces_query` and `spaces_edit` through your existing agent tool policy.
Enabling the plugin does not override that policy. Agent access requires a
current owner-private audience outside a sandbox.

The current host grants these audiences only with a selected native memory
provider. The legacy `memory-core` registration does not supply them.
In that configuration, human access works but agent tools remain unavailable.
Spaces does not reconstruct owner authority or replace the selected memory
provider. See [Memory architecture](/concepts/memory-architecture) for that
provider contract.

## Choose a view

Each Space requires a name, a description, and interaction rules. Rules describe
what belongs in the Space and how to edit it. They do not grant permission.

| View              | Saved content                                     | Actions                                             |
| ----------------- | ------------------------------------------------- | --------------------------------------------------- |
| To-do             | Tasks, checklists, due dates, notes, links        | Add, edit, complete, reopen, delete                 |
| Shopping          | Items, quantities, units, categories, notes       | Add, edit, combine, check off                       |
| Read Later        | Source URLs, titles, notes, reading status        | Preview imports, save, annotate, mark read, archive |
| Vacation Research | Candidates, sources, comparisons, dated estimates | Compare, annotate, select, update                   |

A Space with saved items cannot change its view type. Checklist parents must
be active items in the same Space, without a cycle. Move or delete active
checklist children before deleting their parent.

Shopping combine requires two different open items with saved quantities and
matching details. It compares source links, source dates, and estimates as well
as names, units, categories, notes, and due dates. Undo restores both items
together, unless either item changed afterward.

Read Later imports first show duplicate URLs. URL fragments do not distinguish
sources. Commit can skip duplicates or reject the whole import.

Research items require an HTTP or HTTPS source link without credentials. An
estimate requires a currency and a source date. A source link is a reference,
not an independent copy of its content.

## Save and resolve conflicts

A revision is the saved version of a record. Each edit supplies its exact IDs,
expected revision, and an operation ID. Creation expects revision `0`.
Different items have independent revisions.

An operation ID identifies one request from one actor. Repeating the same
request returns its saved result without applying it twice. Reusing that ID
with different input or another actor is rejected.

An edit returns `applied`, `conflict`, `not-found`, `rejected`, or `expired`.
Content, revisions, history, and the result commit in one database transaction.
Completion sets an explicit status rather than reversing a toggle on retry.

If delivery is uncertain, read the operation result or retry the same input
with the same operation ID. Do not create a new operation ID merely because
the connection dropped. After a conflict, compare the current record with your
draft before saving a new request.

## History, Trash, and storage

History and Trash last 30 days. Active content remains until you delete it.
Reads hide expired Trash, history, and operation results immediately. The next
authorized edit removes expired content in its transaction.

If a checklist parent expires first, cleanup clears links from surviving
trashed children and advances their revisions. This cleanup cannot be undone.
It does not change active children or extend their Trash period.

Compact record IDs and operation digests remain after content expires. They
prevent an old request or record ID from creating another record. Backups retain
deleted content according to the backup owner's retention policy.

The plugin owns one relational database at
`<state-dir>/plugins/spaces/spaces.sqlite`, with SQLite schema version `1`.
The existing worker broker runs database operations outside the Gateway main
thread. Shutdown stops new requests and settles accepted writes before closing
the worker.

Spaces refuses unsupported schema versions before changing the schema or
enabling WAL. It also refuses unversioned databases with existing tables.
An update preserves this database. A downgrade that does not support its schema
must use a compatible verified backup rather than reinterpret saved records.

## Back up and recover

The plugin manifest includes `plugins/spaces` in state backup coverage. Use
the existing [Backup CLI](/cli/backup), which captures managed SQLite snapshots.
Do not copy an active database file without its snapshot owner.

```bash
openclaw backup create --no-include-workspace --verify --output ~/Backups
openclaw backup verify <archive>
openclaw backup restore <archive> --target ~/restored-openclaw
```

Restore first into a new directory. Keep the current database until you inspect
the restored content and its schema. Stop the Gateway that owns the database
before replacing its state through your normal recovery procedure.

## Agent discovery and limits

Automatic discovery requires `spaces_query` in the permitted tool set and a
current owner-private audience. Group, incognito, sandboxed, and unsupported
contexts receive no automatic personal catalog.

The catalog contains at most eight complete descriptors and 4 KiB of encoded
output. Descriptions have a 240-byte UTF-8 authoring limit. Larger catalogs
report an omitted count and the paged `spaces_query` discovery path.

Metadata edits invalidate the catalog cache. Ordinary item edits leave that
metadata unchanged. Full rules and selected items are read on demand, outside
the stable conversation prefix.

Spaces does not schedule reminders or settle linked FSA reminders. It does not
promote artifacts into independent copies. Those actions require supported
operations from their existing owners, not raw cron deletion or file copying.

## Troubleshooting

If Spaces cannot authenticate a request, reconnect the Control UI or start a
permitted owner-private agent conversation. A token or saved session ID alone
does not prove that the caller still has authority.

If a save conflicts, keep your draft and read the current record. If a saved
edit cannot notify other clients, the Gateway logs a warning. Refresh Spaces
to read the committed result.

If schema admission or integrity fails, keep the database and restore a
compatible verified backup. Do not delete tables or lower `user_version`.
See [Database schemas](/reference/database-schemas) for storage ownership.
