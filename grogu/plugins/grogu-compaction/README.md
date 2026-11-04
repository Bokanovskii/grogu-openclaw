# Grogu deterministic compaction

This external plugin registers the public `grogu-digest` compaction provider.
It performs no model or network call, logs no message content, and emits a
versioned UTF-8-bounded digest. OpenClaw still owns split-turn recovery and
verbatim recent-turn preservation after the provider returns.

Stage it by adding this directory to `plugins.load.paths`, enabling the
`grogu-digest` entry, and setting:

```json5
{
  agents: {
    defaults: {
      compaction: {
        provider: "grogu-digest",
        notifyUser: false,
      },
    },
  },
}
```

Keep the existing `keepRecentTokens`, `maxActiveTranscriptBytes`, and strict
identifier policy until measurements justify a separate change.
