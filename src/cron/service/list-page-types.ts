/** Shared filter, sort, and page result types for cron job listing. */
import type { CronGroup } from "../../../packages/gateway-protocol/src/schema/cron.types.js";
import type { CronJob, CronRunStatus } from "../types.js";

/** Stable sort keys supported by paginated cron listing. */
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";

/** Sort direction for paginated cron listing. */
export type CronSortDir = "asc" | "desc";

/** Input contract for filtered, sorted, offset-based cron job pages. */
export type CronListPageOptions = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: "all" | "enabled" | "disabled";
  scheduleKind?: "all" | "at" | "every" | "cron" | "on-exit" | "stream";
  lastRunStatus?: "all" | CronRunStatus | "unknown";
  trigger?: "all" | "conditional" | "unconditional";
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
  agentId?: string;
};

/** Internal offset-page result. Rows are deeply frozen snapshots; clone before editing locally. */
export type CronListPageRowsResult<TJobs extends readonly CronJob[] = CronJob[]> = {
  jobs: TJobs;
  /** Opaque revision for the complete filtered, sorted result set. */
  snapshotRevision: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

/** Canonical cron.list response, including the registry used to organize its jobs. */
export type CronListPageResult<TJobs extends readonly CronJob[] = CronJob[]> =
  CronListPageRowsResult<TJobs> & {
    groups: CronGroup[];
  };
