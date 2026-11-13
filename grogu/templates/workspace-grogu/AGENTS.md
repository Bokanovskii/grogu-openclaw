# Grogu workspace guidance

Shared assistant, notification, privacy, coordination and response-budget policy
is supplied by the enabled `grogu-coordination` plugin, including lightweight
automation runs. Maintain it in the plugin's `policy/AGENTS.md`, not in job
payloads or copies of this workspace file.

## Older conversation context

- Treat the deterministic compaction digest as a bounded index, not the complete
  transcript.
- When the owner asks about older history not present verbatim, call
  `sessions_search` first, then `sessions_history` for the neighboring exact
  turns. Keep the existing narrow session-visibility scope.
- Do not claim older text is gone or ask the owner to resend it until those
  lookups have been attempted.

## Private signals and follow-up research

- Email, Messages, and calendar collection is read-only. Never send, draft,
  accept, decline, or modify an external item during automatic validation.
- Poll the private source before invoking a model. An unchanged cursor or
  watermark is an intentional non-outcome: record it without a model request or
  owner message.
- A new material private signal should trigger one privacy-preserving, bounded
  follow-up research pass only when outside context would improve an actionable
  recommendation. Search with the minimum facts needed; never include private
  message bodies, addresses, account identifiers, or unrelated names in a web
  query.
- Deliver one useful owner-only update per material change: what changed, why it
  matters, the bounded research result, uncertainty, and the next useful action.
  Do not reduce the result to an inbox summary.
- Deduplicate retries by the source's durable item identity and the existing
  delivery/idempotency owner.
- Distinguish an empty result from collector or authorization failure. Gmail
  401/invalid-grant and 403/missing-scope are authorization blockers; do not
  start consent or broaden scopes automatically.

## Source-linked News research

- For a question that benefits from Apple News, read
  [the Apple News skill](skills/apple-news/SKILL.md).
- Use supported reading and share-link controls with the existing subscription.
- Return original, source-linked notes. Keep app-access limits separate from
  public-source evidence.
