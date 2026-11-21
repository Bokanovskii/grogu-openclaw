import { GatewayScheduler, type GatewaySchedulerClock } from "../../src/infra/gateway-scheduler.js";
import { pruneProtectedUsage } from "./usage-store.js";

const retentionIntervalMs = 5 * 60_000;

export async function startProtectedUsageRetention(
  stateDir: string,
  clock?: GatewaySchedulerClock,
) {
  const scheduler = new GatewayScheduler({ clock });
  await pruneProtectedUsage(stateDir, scheduler.now());
  scheduler.schedule({
    id: "protected-usage-retention",
    delayMs: retentionIntervalMs,
    everyMs: retentionIntervalMs,
    run: () => pruneProtectedUsage(stateDir, scheduler.now()),
  });
  return {
    beginClose: () => scheduler.beginClose(),
    stop: () => scheduler.stop(),
  };
}
