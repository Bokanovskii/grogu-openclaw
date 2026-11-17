/** Why a lane cannot admit, from the narrowest cause outward. */
export type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

export type CommandLaneSnapshot = {
  lane: string;
  queuedCount: number;
  /** Owned tasks, including suspended tasks until their owner settles them. */
  activeCount: number;
  /** Still-owned tasks temporarily waiting without execution capacity. */
  suspendedCount?: number;
  /** Existing tasks queued to reacquire capacity, not additional root work. */
  capacityWaitingCount?: number;
  maxConcurrent: number;
  /** Capacity applies independently to each session or swarm group. */
  concurrencyScope?: "session" | "swarm";
  swarmGroupKey?: string;
  saturatedLaneCount?: number;
  draining: boolean;
  generation: number;
  group?: string;
  /** Occupied execution capacity across every member of the group. Always derived. */
  groupActive?: number;
  /** Hard aggregate cap shared by the group's members. */
  groupBudget?: number;
  /** Slots within the budget this lane may always claim. */
  reservedForLane?: number;
  /**
   * Why this lane cannot start more work right now, or null if it can.
   * `lane` is the lane's own maxConcurrent; the other two are group-imposed and
   * are invisible to a lane-local view — see `noteLaneWaitIfBusy`.
   */
  blockedBy?: CommandLaneBlockReason;
};

export type CommandQueueTaskDeadline =
  | { kind: "bounded"; deadlineAtMs: number }
  | { kind: "unlimited" };

export type CommandQueueEnqueueOptions = {
  sessionTarget?: Readonly<{ agentId?: string; sessionKey?: string; sessionId: string }>;
  /** Enqueue-time provenance for diagnostics only; never used for admission. */
  taskIdentity?: Readonly<{
    taskKind: string;
    sessionKey?: string;
    runId?: string;
    requesterSessionKey?: string;
  }>;
  /** Owner-resolved capacity, installed atomically with this enqueue. */
  maxConcurrent?: number;
  /** Allows cooperative capacity waits; never enable on serialization/ownership lanes. */
  allowCapacitySuspension?: boolean;
  /** Cancels admission/reacquisition; the task owns cancellation while executing. */
  abortSignal?: AbortSignal;
  /** Called only when this entry remains queued after immediate lane admission. */
  onQueued?: () => void;
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  /** Replaces idle timing with an owner deadline; undefined restores idle timing. */
  taskTimeoutSubscribe?: (
    onDeadline: (deadline: CommandQueueTaskDeadline | undefined) => void,
  ) => () => void;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  /** Ends the task after a caller-owned timeout cleanup grace has already elapsed. */
  taskTimeoutReleaseSignal?: AbortSignal;
  priority?: "foreground" | "normal" | "background";
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
