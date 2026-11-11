# Grogu workspace guidance

## Active-response budgets

- For Grogu automations with `payload.kind: "agentTurn"`, set
  `payload.timeoutSeconds: 0` unless the owner explicitly chooses a finite
  budget. This disables the scheduler's overall watchdog, which otherwise
  allows 60 minutes when an agent-turn automation has no explicit timeout.
- Do not apply this policy to other payload kinds, change global timeout
  defaults, or change other OpenClaw installations.
- Disabling the scheduler's overall watchdog does not remove provider
  idle/no-progress safeguards, tool or settlement deadlines, or cancellation.
  Preserve those protections. Schedule cadence is not a run deadline.

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
