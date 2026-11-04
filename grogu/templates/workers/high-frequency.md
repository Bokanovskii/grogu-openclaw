# High-frequency worker contract

- The frequent tick performs only a deterministic source/cursor check.
- No change means an intentional non-outcome: no model request and no owner
  message.
- A new material delta schedules at most one bounded research pass through the
  existing idempotency owner. Repeated ticks while that work is pending do not
  create additional requests.
- Use adaptive research cadence based on observed deltas and the established
  freshness window; do not change business timing without run evidence.
- Provider or collector failure uses the existing scheduler retry/backoff path
  and one actionable alert, never a request storm.
