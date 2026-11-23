/**
 * Holds the native state-owner lock for the service lifetime. Session lifecycle
 * admission is process-local, so this lock is what makes startup recovery and
 * offline maintenance exclusive with a live listener. Returns undefined while
 * another process owns the state.
 */
export async function acquireProtectedStateOwner(stateDir: string) {
  const { acquireGatewayStateOwner, GatewayStateOwnerContentionError } =
    await import("../../src/infra/gateway-state-owner.js");
  const { resolveOpenClawStateSqlitePath } =
    await import("../../src/state/openclaw-state-db.paths.js");
  const { defaultPayload } = await import("../../src/infra/gateway-state-owner-record.js");
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  try {
    // The native default carries ownerId, processNamespace and startTime for stale-owner detection.
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: { ...defaultPayload(databasePath), role: "exclusive-service" },
    });
    let retained = 0;
    return {
      ...owner,
      databasePath,
      /** Unsettled protected work keeps the native owner; only process exit ends it. */
      retain(): () => void {
        retained += 1;
        let held = true;
        return () => {
          if (held) {
            held = false;
            retained -= 1;
          }
        };
      },
      release(): void {
        if (retained > 0) {
          process.stderr.write(
            `Protected state owner kept for ${retained} unsettled operation(s); restart recovery settles them.\n`,
          );
          return;
        }
        owner.release();
      },
    };
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      return undefined;
    }
    throw error;
  }
}
