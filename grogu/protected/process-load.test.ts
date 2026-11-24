import assert from "node:assert/strict";
import type { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { DiagnosticWorkerRequestFields } from "../../src/infra/diagnostic-process-types.js";
import { createProcessLoad } from "./process-load.js";

type Utilization = ReturnType<typeof performance.eventLoopUtilization>;
type RequestEvent = DiagnosticWorkerRequestFields;

// A process whose clock, event-loop busy time, 50 ms timer and diagnostics the test drives.
function fakeProcess() {
  let clock = 1_000;
  let timerDue = clock + 50;
  let busyMs = 0;
  let runTimer = () => {};
  let emit: (event: RequestEvent) => void = () => {};
  const load = createProcessLoad({
    now: () => clock,
    eventLoopUtilization: (since?: Utilization) => ({
      idle: 0,
      active: busyMs - (since?.active ?? 0),
      utilization: 0,
    }),
    every: (tick) => {
      runTimer = tick;
    },
    subscribe: (listener) => {
      emit = listener;
    },
  });
  return {
    load,
    advance: (ms: number) => {
      clock += ms;
    },
    busy: (ms: number) => {
      busyMs += ms;
    },
    // The timer fires `lateMs` after it was due and is due again 50 ms later.
    fire: (lateMs = 0) => {
      clock = timerDue + lateMs;
      timerDue = clock + 50;
      runTimer();
    },
    request: (
      kind: RequestEvent["kind"],
      phase: RequestEvent["phase"],
      times: { queueWaitMs?: number; durationMs?: number } = {},
    ) => {
      emit({
        type: "worker.request",
        kind,
        requestClass: "execute",
        phase,
        queueDepth: 0,
        ...times,
      });
    },
  };
}

void test("a turn reports the event-loop time it overlapped and its longest stall", () => {
  const sim = fakeProcess();
  sim.fire();
  sim.fire(500);
  sim.busy(300);
  // The timer is overdue when the turn starts, so only part of its delay falls inside the turn.
  sim.advance(100);
  const start = sim.load.mark();
  assert.equal(sim.load.since(start).loopMaxStallMs, 0);

  sim.busy(40);
  sim.fire(350);
  assert.equal(sim.load.since(start).loopMaxStallMs, 300);
  const later = sim.load.mark();
  // A delay under 100 ms is ordinary timer jitter.
  sim.fire(99);
  assert.equal(sim.load.since(later).loopMaxStallMs, 0);
  sim.fire(700);
  assert.equal(sim.load.since(later).loopMaxStallMs, 700);
  const change = sim.load.since(start);
  assert.equal(change.loopMaxStallMs, 700);
  assert.equal(change.loopBusyMs, 40);
});

void test("worker requests are totaled by group from their queue wait and duration", () => {
  const sim = fakeProcess();
  const start = sim.load.mark();
  // A queued request counts nothing yet; its wait counts once it starts and its time once it ends.
  sim.request("stateRead", "queued");
  sim.request("stateRead", "started", { queueWaitMs: 4 });
  sim.request("stateRead", "completed", { durationMs: 30 });
  sim.request("sqlite_read", "started", { queueWaitMs: 1 });
  sim.request("sqlite_read", "completed", { durationMs: 2 });
  sim.request("sqlite_writer", "started", { queueWaitMs: 100 });
  sim.request("sqlite_writer", "completed", { durationMs: 900 });
  // A request canceled while it was still queued finishes without a duration.
  sim.request("sqlite_writer", "completed");
  sim.request("sessionTranscript", "started", { queueWaitMs: 8 });
  sim.request("sessionTranscript", "completed", { durationMs: 60 });
  assert.deepEqual(sim.load.since(start), {
    loopBusyMs: 0,
    loopMaxStallMs: 0,
    sqliteWrites: 2,
    sqliteWriteQueueMs: 100,
    sqliteWriteMs: 900,
    transcriptTasks: 1,
    transcriptQueueMs: 8,
    transcriptMs: 60,
    workerTasks: 2,
    workerQueueMs: 5,
    workerMs: 32,
  });
});

void test("a turn sees only the load that came after its own start", () => {
  const sim = fakeProcess();
  sim.request("stateRead", "started", { queueWaitMs: 7 });
  sim.request("stateRead", "completed", { durationMs: 11 });
  sim.fire(900);
  sim.busy(250);
  const start = sim.load.mark();
  sim.busy(5);
  sim.request("sqlite_writer", "started", { queueWaitMs: 1 });
  sim.request("sqlite_writer", "completed", { durationMs: 2 });
  assert.deepEqual(sim.load.since(start), {
    loopBusyMs: 5,
    loopMaxStallMs: 0,
    sqliteWrites: 1,
    sqliteWriteQueueMs: 1,
    sqliteWriteMs: 2,
    transcriptTasks: 0,
    transcriptQueueMs: 0,
    transcriptMs: 0,
    workerTasks: 0,
    workerQueueMs: 0,
    workerMs: 0,
  });
});
