# Messages worker contract

Contract marker: `GROGU_PRIVATE_SIGNAL_V1`

1. Use the read-only Messages/Seaglass boundary for freshness and conversation
   lookup. Preserve sender and conversation identity without sending or drafting.
2. Compare durable message identities with the persisted cursor. An unchanged
   poll records an intentional non-outcome and stops before model work.
3. A material new private signal may trigger one bounded outside-research pass
   only when it improves an actionable recommendation. Query with the minimum
   non-private facts; never include message bodies, phone numbers, addresses,
   account identifiers, or unrelated names.
4. Send one useful owner-only update per material change, not an inbox summary:
   what changed, why it matters, bounded research, uncertainty, and the next
   useful action.
5. Deduplicate retries by durable message identity and the existing delivery
   owner. Use scheduler/provider retries and backoff.
