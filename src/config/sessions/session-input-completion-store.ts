import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  openSessionInputCompletionOutcome,
  sealSessionInputCompletionOutcome,
} from "./session-pending-input-encryption.js";

type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;
type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function isFinalInputCompletion(outcome: AgentRunTerminalOutcome): boolean {
  return (
    outcome.reason === "completed" ||
    (outcome.reason === "cancelled" && outcome.stopReason !== "restart")
  );
}

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_input_completions")
      .selectAll()
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("idempotency_key", "=", scope.idempotencyKey),
  );
  if (!row) {
    return undefined;
  }
  // SAFETY: only writeSessionInputCompletion writes this feature-owned table with typed terminal outcomes.
  const outcomeJson = openSessionInputCompletionOutcome(
    database.db,
    scope.sessionId,
    scope.idempotencyKey,
    row.outcome_json,
  );
  const outcome = JSON.parse(outcomeJson) as AgentRunTerminalOutcome;
  return { ...row, outcome_json: outcomeJson, outcome };
}

/** The caller holds the write transaction and has revalidated the exact live admission owner. */
export function writeSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope & {
    runId: string;
    requestHash: string;
    lifecycleGeneration: string;
  },
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const retained = readSessionInputCompletion(database, scope);
  if (retained && isFinalInputCompletion(retained.outcome)) {
    return retained.outcome;
  }
  const succeeded = classifyAgentRunTerminalOutcome(outcome) === "success";
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values({
        session_key: scope.sessionKey,
        session_id: scope.sessionId,
        idempotency_key: scope.idempotencyKey,
        run_id: scope.runId,
        request_hash: scope.requestHash,
        outcome_json: sealSessionInputCompletionOutcome(
          database.db,
          scope.sessionId,
          scope.idempotencyKey,
          JSON.stringify(outcome),
        ),
        succeeded: succeeded ? 1 : 0,
        completed_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet({
            outcome_json: sealSessionInputCompletionOutcome(
              database.db,
              scope.sessionId,
              scope.idempotencyKey,
              JSON.stringify(outcome),
            ),
            succeeded: succeeded ? 1 : 0,
            completed_at: Date.now(),
          })
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
  if (isFinalInputCompletion(outcome)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey)
        .where("run_id", "=", scope.runId)
        .where("request_hash", "=", scope.requestHash)
        .where("lifecycle_generation", "=", scope.lifecycleGeneration),
    );
  }
  return outcome;
}
