// Wire types derive from the cron schemas without importing the ProtocolSchemas registry.
import type { Static } from "typebox";
import type {
  CronAddJobResultSchema,
  CronAddParamsSchema,
  CronAddResultSchema,
  CronDeliveryPreviewSchema,
  CronDeclarativeAddResultSchema,
  CronGetParamsSchema,
  CronGroupSchema,
  CronGroupsDeleteParamsSchema,
  CronGroupsListParamsSchema,
  CronGroupsUpsertParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronRemoveParamsSchema,
  CronRunLogEntrySchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronScratchGetParamsSchema,
  CronScratchGetResultSchema,
  CronScratchSetParamsSchema,
  CronScratchSetResultSchema,
  CronStatusParamsSchema,
  CronUpdateParamsSchema,
} from "./cron.js";

export type CronJob = Static<typeof CronJobSchema>;
/** Definition-free row returned by cron.list when compact is true. */
export type CronCompactJob = Pick<
  CronJob,
  | "id"
  | "name"
  | "declarationKey"
  | "displayName"
  | "groupId"
  | "notificationDescription"
  | "owner"
  | "agentId"
  | "enabled"
  | "updatedAtMs"
> &
  Pick<
    CronJob["state"],
    | "runningAtMs"
    | "autoDisabled"
    | "lastDelivered"
    | "lastDeliveryStatus"
    | "lastDeliveryError"
    | "deliverySuppressionReason"
    | "lastFailureNotificationDelivered"
    | "lastFailureNotificationDeliveryStatus"
    | "lastFailureNotificationDeliveryError"
  > & {
    nextRunAt: string | null;
    nextRunAtMs: number | null;
    scheduleKind: CronJob["schedule"]["kind"];
    schedule?: Extract<CronJob["schedule"], { kind: "at" | "every" | "cron" }>;
    trigger?: true;
    lastRunAt: string | null;
    lastRunAtMs: number | null;
    lastRunStatus: NonNullable<CronJob["state"]["lastRunStatus"]> | null;
    lastRunError: string | null;
  };
export type CronListParams = Static<typeof CronListParamsSchema>;
export type CronGroup = Static<typeof CronGroupSchema>;
export type CronGroupsListParams = Static<typeof CronGroupsListParamsSchema>;
export type CronGroupsUpsertParams = Static<typeof CronGroupsUpsertParamsSchema>;
export type CronGroupsDeleteParams = Static<typeof CronGroupsDeleteParamsSchema>;
export type CronStatusParams = Static<typeof CronStatusParamsSchema>;
export type CronGetParams = Static<typeof CronGetParamsSchema>;
export type CronAddParams = Static<typeof CronAddParamsSchema>;
export type CronAddJobResult = Static<typeof CronAddJobResultSchema>;
export type CronAddResult = Static<typeof CronAddResultSchema>;
export type CronDeliveryPreview = Static<typeof CronDeliveryPreviewSchema>;
export type CronDeclarativeAddResult = Static<typeof CronDeclarativeAddResultSchema>;
export type CronUpdateParams = Static<typeof CronUpdateParamsSchema>;
export type CronRemoveParams = Static<typeof CronRemoveParamsSchema>;
export type CronRunParams = Static<typeof CronRunParamsSchema>;
export type CronRunsParams = Static<typeof CronRunsParamsSchema>;
export type CronScratchGetParams = Static<typeof CronScratchGetParamsSchema>;
export type CronScratchGetResult = Static<typeof CronScratchGetResultSchema>;
export type CronScratchSetParams = Static<typeof CronScratchSetParamsSchema>;
export type CronScratchSetResult = Static<typeof CronScratchSetResultSchema>;
export type CronRunLogEntry = Static<typeof CronRunLogEntrySchema>;
