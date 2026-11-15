# Frequent source polls

Contract marker: `GROGU_DETERMINISTIC_POLL_V1`

Use one bounded metadata collector per native trigger. Each source keeps its
own cursor, continuation, coverage, and failure state. Multiple source jobs can
feed one role, such as Inbox. The shared topic owner joins related evidence.

An unchanged source returns an intentional non-outcome without a model request.
A new delta or bounded continuation admits the source producer's focused brief.
The native scheduler coalesces pending work and records progress.

Keep read-only metadata arguments and live schema pins. Distinguish an empty
result from source failure. Use the native source retry and backoff owner.
Describe gaps in observed coverage instead of treating an incomplete page as
complete history.

Sources with no supported deterministic collector use an explicit bounded
native schedule and a focused producer brief. Daily prep uses this path for
calendar and weather. Adding an admitted source reuses the producer contract
and its existing scheduler rather than adding another topic ledger.
