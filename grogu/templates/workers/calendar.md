# Calendar worker contract

Contract marker: `GROGU_PRIVATE_SIGNAL_V1`

1. Calendar is a payload-time native source, not a trigger adapter or separate
   scheduled job. Call `icloud_calendar_events` only when the trigger envelope
   has kind `native_source_sweep` or sets `nativeSourceSweep: true`.
2. Compute bounded rolling `from` and `to` values at payload execution time,
   then call the native tool with only `from`, `to`, `calendar`, and `limit`.
   Never persist static dates in the trigger template.
3. Project only UID, start/end, all-day, recurrence, and other reviewed
   metadata before comparison. Do not log or persist the raw response, title,
   location, or notes.
4. Distinguish a successful empty observation from schema, authorization, and
   transient source failure. If the metadata cursor is unchanged, record an
   intentional non-outcome and send no owner message.
5. For a material delta, research only missing outside context needed for an
   actionable recommendation. Use the minimum private facts necessary and never
   put event descriptions, attendees, addresses, account identifiers, or
   unrelated names in a web query.
6. Send one owner-only update per material change: the change, why it matters,
   bounded research, uncertainty, and the next useful action.
7. Deduplicate retries by the durable event identity and existing delivery
   idempotency owner. Use scheduler/provider retries and backoff.
