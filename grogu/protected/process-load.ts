import { performance } from "node:perf_hooks";
import { onInternalDiagnosticEvent } from "../../src/infra/diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "../../src/infra/diagnostic-process-types.js";

/**
 * What the whole process did while one turn ran, so a slow turn can be told apart from a busy
 * server. Every value counts all members' work during the turn, not only the turn's own.
 */
export const processLoadNotes = [
  "loopBusyMs",
  "loopMaxStallMs",
  "sqliteWrites",
  "sqliteWriteQueueMs",
  "sqliteWriteMs",
  "transcriptTasks",
  "transcriptQueueMs",
  "transcriptMs",
  "workerTasks",
  "workerQueueMs",
  "workerMs",
] as const;
type ProcessLoadNote = (typeof processLoadNotes)[number];

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type RequestTotals = { count: number; queueMs: number; ms: number };
// Every worker request lands in exactly one group: the SQLite writer, the transcript pool, or
// any other worker pool (state reads, read snapshots, model catalog, memory, files).
type GroupTotals = { writer: RequestTotals; transcript: RequestTotals; other: RequestTotals };
type ProcessLoadMark = { at: number; loop: EventLoopUtilization; groups: GroupTotals };

type ProcessLoadDeps = {
  now?: () => number;
  eventLoopUtilization?: typeof performance.eventLoopUtilization;
  subscribe?: (listener: (event: DiagnosticWorkerRequestFields) => void) => void;
  every?: (tick: () => void, intervalMs: number) => void;
};

const tickMs = 50;
// A shorter delay is ordinary timer jitter that nobody waiting on a reply would notice.
const stallFloorMs = 100;
const stallHistory = 256;

/**
 * Process-lifetime sampler. A turn takes a mark when it starts and reads the change when it ends,
 * so nothing is registered per turn and a turn that never ends leaks nothing.
 */
export function createProcessLoad(deps: ProcessLoadDeps = {}) {
  const now = deps.now ?? (() => performance.now());
  const readLoop = deps.eventLoopUtilization ?? performance.eventLoopUtilization.bind(performance);
  const subscribe =
    deps.subscribe ??
    ((listener) => {
      onInternalDiagnosticEvent(
        (event) => {
          if (event.type === "worker.request") {
            listener(event);
          }
        },
        { include: ["worker.request"] },
      );
    });
  const every =
    deps.every ??
    ((tick, intervalMs) => {
      setInterval(tick, intervalMs).unref();
    });

  // Only the newest stalls are kept, so a turn that outlasts them reports the largest recent one.
  const stalls: { endedAt: number; ms: number }[] = [];
  let nextStall = 0;
  let lastTickAt = now();
  every(() => {
    const at = now();
    const late = at - lastTickAt - tickMs;
    lastTickAt = at;
    if (late >= stallFloorMs) {
      stalls[nextStall] = { endedAt: at, ms: late };
      nextStall = (nextStall + 1) % stallHistory;
    }
  }, tickMs);

  const groups: GroupTotals = {
    writer: { count: 0, queueMs: 0, ms: 0 },
    transcript: { count: 0, queueMs: 0, ms: 0 },
    other: { count: 0, queueMs: 0, ms: 0 },
  };
  subscribe((event) => {
    const totals =
      event.kind === "sqlite_writer"
        ? groups.writer
        : event.kind === "sessionTranscript"
          ? groups.transcript
          : groups.other;
    if (event.phase === "started") {
      totals.queueMs += event.queueWaitMs ?? 0;
    } else if (event.phase === "completed") {
      // A request canceled while queued completes without a duration.
      totals.count++;
      totals.ms += event.durationMs ?? 0;
    }
  });

  return {
    mark: (): ProcessLoadMark => ({
      at: now(),
      loop: readLoop(),
      groups: {
        writer: { ...groups.writer },
        transcript: { ...groups.transcript },
        other: { ...groups.other },
      },
    }),
    since: (start: ProcessLoadMark): Record<ProcessLoadNote, number> => {
      let loopMaxStallMs = 0;
      for (const stall of stalls) {
        if (stall.endedAt > start.at) {
          // A stall that began before the turn counts only from the turn's start.
          loopMaxStallMs = Math.max(loopMaxStallMs, Math.min(stall.ms, stall.endedAt - start.at));
        }
      }
      return {
        loopBusyMs: readLoop(start.loop).active,
        loopMaxStallMs,
        sqliteWrites: groups.writer.count - start.groups.writer.count,
        sqliteWriteQueueMs: groups.writer.queueMs - start.groups.writer.queueMs,
        sqliteWriteMs: groups.writer.ms - start.groups.writer.ms,
        transcriptTasks: groups.transcript.count - start.groups.transcript.count,
        transcriptQueueMs: groups.transcript.queueMs - start.groups.transcript.queueMs,
        transcriptMs: groups.transcript.ms - start.groups.transcript.ms,
        workerTasks: groups.other.count - start.groups.other.count,
        workerQueueMs: groups.other.queueMs - start.groups.other.queueMs,
        workerMs: groups.other.ms - start.groups.other.ms,
      };
    },
  };
}

export type ProcessLoad = ReturnType<typeof createProcessLoad>;
