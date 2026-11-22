import { sql, type RawBuilder } from "kysely";

export function trajectoryRuntimeEventStorageContext(sessionId: string, seq: number): string {
  if (!sessionId || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("Trajectory storage requires a valid session and sequence.");
  }
  return `openclaw:protected:trajectory-runtime:${sessionId}:${seq}`;
}

export function trajectoryRuntimeEventStorageContextSql(
  alias = "trajectory_runtime_events",
): RawBuilder<string> {
  return /* kysely-allow-raw: fixed table aliases bind an event to its canonical row identity. */ sql<string>`'openclaw:protected:trajectory-runtime:' || ${sql.ref(`${alias}.session_id`)} || ':' || ${sql.ref(`${alias}.seq`)}`;
}
