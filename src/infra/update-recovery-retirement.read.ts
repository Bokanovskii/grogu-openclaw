import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { readActiveUpdateRun, readUpdateRunRecord } from "./update-run-read.kernel.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectRecoveryRows } from "./update-run-recovery-store.js";

export const updateRecoveryRetirementReadOperations = {
  "updateRecoveryRetirement.read": (input: { runId: string }, db: DatabaseSync) => {
    const { runId } = z.strictObject({ runId: z.string().min(1).max(128) }).parse(input);
    const schema = getAdmittedSqliteSchemaFacts(db);
    if (!schema) {
      throw new Error("Capture retirement requires admitted database schema facts.");
    }
    return {
      type: "updateRecoveryRetirement.read" as const,
      run: schema.tables.has("update_runs") ? readUpdateRunRecord(db, runId) : undefined,
      activeRun: readActiveUpdateRun(db)?.runId,
      pendingRecovery: inspectRecoveryRows(db).some(({ record }) =>
        isUpdateRecoveryPending(record),
      ),
    };
  },
};
