import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  assertAutomationRetentionReceiptCoverage,
  readAutomationRetentionDetailAt,
} from "./session-automation-retention.worker.js";
import {
  resolveSessionColdArchivePath,
  verifyPublishedSessionColdArchive,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
import { readSessionAdmissionProtectionKeys } from "./session-cold-storage-selection.js";
import type { SessionColdMutationPlan } from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";

export function assertSessionColdRetentionCurrent(
  database: OpenClawAgentDatabase,
  plan: SessionColdMutationPlan,
) {
  if (plan.kind !== "cold-restore" || !plan.retention) {
    return;
  }
  assertAutomationRetentionReceiptCoverage(plan.databaseOptions);
  const keys = [
    plan.sessionId,
    ...readSessionAdmissionProtectionKeys(database, [plan.sessionId]),
  ].toSorted();
  if (!isDeepStrictEqual(keys, plan.retention.protectionKeys)) {
    throw new Error("Automation retention ownership changed before cold restoration");
  }
}

/** Records whether a retention probe may restore the archive; ineligible probes keep it cold. */
export function readSessionColdRetentionEligibility(
  database: OpenClawAgentDatabase,
  plan: Extract<SessionColdMutationPlan, { kind: "cold-restore" }>,
  records: SessionColdRecord[],
  result: SessionColdMutationResult,
) {
  if (!plan.retention) {
    return true;
  }
  const sessionKey =
    executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<DB>(database.db)
        .selectFrom("session_windows")
        .select("session_key")
        .where("session_id", "=", plan.sessionId),
    )?.session_key ?? undefined;
  const detailAt = readAutomationRetentionDetailAt(records, sessionKey, plan.sessionId);
  result.retentionEligible = detailAt !== undefined && detailAt < plan.retention.cutoff;
  result.retentionDetailAt = detailAt;
  return result.retentionEligible;
}

export function retireRestoredAutomationArchive(
  plan: SessionColdMutationPlan,
  result: SessionColdMutationResult,
) {
  if (
    plan.kind !== "cold-restore" ||
    !plan.retention ||
    !result.restored ||
    plan.archive.storage !== "file"
  ) {
    return;
  }
  // Restored rows are committed first. The writer excludes any new cold owner
  // between the reference check and removal of this content-addressed file.
  runOpenClawAgentWriteTransaction(
    (database) => {
      const referenced = executeSqliteQueryTakeFirstSync(
        database.db,
        getNodeSqliteKysely<DB>(database.db)
          .selectFrom("session_transcript_cold_archives")
          .select("session_id")
          .where("archive_name", "=", plan.archive.archive_name)
          .limit(1),
      );
      if (referenced) {
        throw new Error("Restored automation archive acquired another owner; retirement deferred");
      }
      verifyPublishedSessionColdArchive(plan.databaseOptions.path, plan.archive);
      fs.unlinkSync(
        resolveSessionColdArchivePath(plan.databaseOptions.path, plan.archive.archive_name),
      );
    },
    plan.databaseOptions,
    { operationLabel: "retire restored automation archive" },
  );
}
