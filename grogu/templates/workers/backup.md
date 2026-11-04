# Daily backup job contract

- Run the complete verified online backup with workspace inclusion and
  per-database SQLite-safe capture. Keep the 900-second timeout.
- Schedule outside the busiest model/research window and use the scheduler's
  overlap guard so a second backup cannot start while one is active.
- Preserve archive verification, inventory, retention, and the private digest
  receipt. Never substitute a config-only archive.
- Report the private receipt's archive bytes and capture, verification, digest,
  and retention timings when available. Do not publish paths or inventory.
- Re-measure host memory pressure and swap-in rate during a slow scheduled run
  before attributing latency to the model or changing archive format.
