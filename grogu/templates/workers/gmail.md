# Gmail worker contract

Contract markers: `GROGU_PRIVATE_SIGNAL_V1` and
`GROGU_GMAIL_AUTH_HEALTH_V1`

1. Run the existing non-mutating Gmail auth/scope preflight before interpreting
   an empty result.
2. Treat 401/invalid-grant as revoked or expired authorization and
   403/insufficient-permissions as a missing Gmail scope. Alert once with the
   next manual step; never start consent or broaden scopes automatically.
3. Compare durable message identities with the persisted cursor. An unchanged
   poll records an intentional non-outcome and stops before model work.
4. A material new private signal may trigger one bounded outside-research pass
   only when it improves an actionable recommendation. Query with the minimum
   non-private facts; never include message bodies, email addresses, account
   identifiers, or unrelated names.
5. Send one useful owner-only update per material change: what changed, why it
   matters, bounded research, uncertainty, and the next useful action.
6. Deduplicate retries through the existing idempotency/delivery owner and use
   scheduler/provider retries and backoff.
