# Calendar worker contract

Contract marker: `GROGU_PRIVATE_SIGNAL_V1`

1. Perform the read-only calendar/auth preflight before interpreting results.
2. Read the persisted calendar cursor and collect only new or changed upcoming
   commitments. Distinguish no events from collector or authorization failure.
3. If the cursor is unchanged, record an intentional non-outcome and stop
   without a model request or owner message.
4. For a material delta, research only missing outside context needed for an
   actionable recommendation. Use the minimum private facts necessary and never
   put event descriptions, attendees, addresses, account identifiers, or
   unrelated names in a web query.
5. Send one owner-only update per material change: the change, why it matters,
   bounded research, uncertainty, and the next useful action.
6. Deduplicate retries by the durable event identity and existing delivery
   idempotency owner. Use scheduler/provider retries and backoff.
