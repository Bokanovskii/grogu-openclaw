import { AsyncLocalStorage } from "node:async_hooks";
import { createAbortError } from "../infra/abort-signal.js";
import { toErrorObject } from "../infra/errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  enqueueLaneQueue,
  getQueueState,
  removeLaneQueueEntry,
  type CommandCapacitySuspension,
  type CommandLaneTaskMarker,
  type LaneState,
  type QueueEntry,
  type QueuePriority,
} from "./command-queue.state.js";

type CapacityScope = {
  state: LaneState;
  marker: CommandLaneTaskMarker;
  priority: QueuePriority;
  signal?: AbortSignal;
  drain: () => void;
  waiting?: boolean;
};

const capacityScope = resolveGlobalSingleton(
  Symbol.for("openclaw.commandQueueCapacityScope"),
  () => new AsyncLocalStorage<CapacityScope | undefined>(),
);

export function createCommandLaneCapacityScope(
  state: LaneState,
  marker: CommandLaneTaskMarker,
  priority: QueuePriority,
  signal: AbortSignal | undefined,
  drain: () => void,
): CapacityScope {
  return { state, marker, priority, signal, drain };
}

export function runWithCommandLaneCapacity<T>(scope: CapacityScope | false, run: () => T): T {
  return capacityScope.run(scope || undefined, run);
}

/** Readmit a suspended task only while it still owns the current lane generation. */
export function admitCommandLaneCapacityResumption(
  state: LaneState,
  entry: QueueEntry & { resume: CommandLaneTaskMarker },
): boolean {
  const marker = entry.resume;
  if (
    marker.generation !== state.generation ||
    !state.activeTaskIds.has(marker.taskId) ||
    !state.suspendedTasks?.delete(marker.taskId)
  ) {
    entry.reject(new Error("Command task no longer owns its lane"));
    return false;
  }
  entry.resolve(undefined);
  return true;
}

function assertCurrent({ state, marker, signal }: CapacityScope): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
  if (
    getQueueState().lanes.get(marker.lane) !== state ||
    state.generation !== marker.generation ||
    !state.activeTaskIds.has(marker.taskId)
  ) {
    throw new Error("Command task no longer owns its lane");
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason == null
    ? createAbortError("Command task aborted")
    : toErrorObject(signal.reason, "Command task aborted");
}

function suspend(scope: CapacityScope): CommandCapacitySuspension {
  const { state, marker, priority, signal, drain } = scope;
  let resumption: Promise<void> | undefined;
  let entry: QueueEntry | undefined;
  let cancelled: Error | undefined;
  const suspension: CommandCapacitySuspension = {
    cancel(reason) {
      cancelled = reason;
      if (entry) {
        removeLaneQueueEntry(state.queue, entry);
        entry.reject(reason);
      }
    },
    resume() {
      if (cancelled) {
        return Promise.reject(cancelled);
      }
      if (resumption) {
        return resumption;
      }
      resumption = new Promise<void>((resolve, reject) => {
        assertCurrent(scope);
        entry = {
          resume: marker,
          resolve: () => resolve(),
          reject,
          enqueuedAt: Math.floor(performance.now()),
          sequence: getQueueState().nextQueueSequence++,
          priority,
          warnAfterMs: 2_000,
          queuedAheadAtEnqueue: 0,
          activeAheadAtEnqueue: 0,
        };
        enqueueLaneQueue(state.queue, entry);
        if (signal) {
          const onAbort = () => suspension.cancel(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          entry.releaseQueuedAbort = () => signal.removeEventListener("abort", onAbort);
        }
        drain();
      });
      return resumption;
    },
  };
  (state.suspendedTasks ??= new Map()).set(marker.taskId, suspension);
  drain();
  return suspension;
}

/**
 * Cooperatively yield only execution capacity while this task waits. Task
 * ownership, outer serialization lanes, and shutdown accounting stay held.
 * The task must be waiting here, not executing productive parallel work.
 */
export async function withCommandLaneCapacitySuspended<T>(wait: () => Promise<T>): Promise<T> {
  const scope = capacityScope.getStore();
  if (!scope || scope.waiting) {
    return await wait();
  }
  assertCurrent(scope);
  const suspension = scope.state.suspendedTasks?.get(scope.marker.taskId) ?? suspend(scope);
  try {
    return await capacityScope.run({ ...scope, waiting: true }, wait);
  } finally {
    let pending: CommandCapacitySuspension | undefined = suspension;
    do {
      await pending.resume();
      assertCurrent(scope);
      // Another cooperative wait may have started while this resumption settled.
      pending = scope.state.suspendedTasks?.get(scope.marker.taskId);
    } while (pending);
  }
}

export function retireCommandLaneCapacity(state: LaneState, taskId: number): void {
  const suspension = state.suspendedTasks?.get(taskId);
  if (suspension) {
    suspension.cancel(new Error("Command task no longer owns its lane"));
    state.suspendedTasks?.delete(taskId);
  }
}

export function retireAllCommandLaneCapacity(state: LaneState): void {
  for (const taskId of state.suspendedTasks?.keys() ?? []) {
    retireCommandLaneCapacity(state, taskId);
  }
}

export function describeCommandLaneCapacity(state: LaneState | undefined) {
  return {
    ...(state?.suspendedTasks?.size ? { suspendedCount: state.suspendedTasks.size } : {}),
    ...(state?.queue.resumptions ? { capacityWaitingCount: state.queue.resumptions } : {}),
  };
}
