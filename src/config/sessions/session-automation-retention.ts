import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readCronTranscriptOwnership } from "../../cron/active-jobs.js";
import { withCronReceiptAuthorityMutation } from "../../cron/store/receipt-authority-owner.js";
import { readAgentRunTranscriptOwnership } from "../../infra/agent-run-transcript-ownership.js";
import { readSessionWorkAdmissionProtection } from "../../sessions/session-lifecycle-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { AutomationRetentionDeferredError } from "./session-automation-retention.errors.js";
import type {
  AutomationRetentionCommitted,
  AutomationTurn,
} from "./session-automation-retention.worker.js";
import { isSessionColdRetentionDeferred } from "./session-cold-retention.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";

// Each probe decodes a whole archive while receipt custody is held, eligible or not.
const MAX_COLD_PROBES_PER_SWEEP = 4;

/** Canonical worker coverage and fresh host custody must both permit every writer grant. */
export async function runAutomationDetailRetentionForStore(
  input: SessionStoreWorkerReadScope & { cutoff: number; assertCurrent: () => void },
) {
  return withSessionStoreReaderInWorker(
    input,
    async ({ database, assertCurrent: assertReaderCurrent }) => {
      const storePaths = new Set([input.storePath, database.path]);
      const receipts = captureOpenClawStateWorkerContext({ env: database.env });
      let target: { sessionId: string; protectionKeys: string[] } | undefined;
      const protectedTarget = () => {
        const selected = target;
        if (!selected) {
          return false;
        }
        for (const scope of storePaths) {
          if (
            readSessionWorkAdmissionProtection({
              scope,
              identities: selected.protectionKeys,
            }) !== "inactive"
          ) {
            return true;
          }
        }
        return [...readCronTranscriptOwnership(), ...readAgentRunTranscriptOwnership()].some(
          (owner) => {
            if (owner.agentId && owner.agentId !== database.agentId) {
              // Conflicting physical and logical scope is not evidence of inactivity.
              return owner.storePath !== undefined && storePaths.has(owner.storePath);
            }
            if (
              owner.state !== "bound" ||
              !owner.storePath ||
              !storePaths.has(owner.storePath) ||
              !owner.sessionKey ||
              !owner.sessionId
            ) {
              return true;
            }
            return (
              selected.protectionKeys.includes(owner.sessionKey) ||
              selected.protectionKeys.includes(owner.sessionId)
            );
          },
        );
      };
      const assertCurrent = () => {
        input.assertCurrent();
        assertReaderCurrent();
        if (protectedTarget()) {
          throw new AutomationRetentionDeferredError(
            "Automation retention deferred because target work is active or unknown",
          );
        }
      };
      const windows = await withSessionEntryWorker(
        database,
        undefined,
        assertCurrent,
        (execution, source) =>
          execution.runExisting(source, (worker) =>
            executeSessionMessageRewriteOperation(worker, database.agentId, {
              type: "session.automation.retention.list",
              input: {},
            }),
          ),
      );
      assertCurrent();
      if (!windows) {
        throw new Error("Automation retention lost its session database");
      }
      let rewritten = 0;
      let runtimeDeleted = 0;
      const seen = new Set<string>();
      let coldProbes = 0;
      for (const { sessionKey, sessionId } of windows) {
        target = undefined;
        assertCurrent();
        if (seen.has(sessionId)) {
          continue;
        }
        seen.add(sessionId);
        target = { sessionId, protectionKeys: [sessionKey, sessionId] };
        if (protectedTarget()) {
          continue;
        }
        const scope = {
          agentId: database.agentId,
          path: database.path,
          env: database.env,
          sessionKey,
          sessionId,
        };
        let afterSeq: number | undefined;
        let restored = false;
        let runs: [string, string][] | undefined;
        let turn: AutomationTurn;
        let personalTurn: boolean | undefined;
        for (;;) {
          // Acquire shared receipt custody before the agent writer, and retain it
          // through native settlement so another host cannot admit a cron run mid-commit.
          const result = await withCronReceiptAuthorityMutation(receipts, (authority) =>
            runSessionEntryWorkerOperation<
              AutomationRetentionCommitted,
              AutomationRetentionCommitted
            >({
              database,
              agentId: database.agentId,
              assertCurrent: () => {
                authority.assertCurrent();
                assertCurrent();
              },
              candidateKind: "session-automation-retention",
              onTransactionFacts: (facts) => {
                if (!isRecord(facts) || facts.kind !== "session-automation-retention-protection") {
                  return false;
                }
                if (
                  facts.sessionId !== sessionId ||
                  !Array.isArray(facts.protectionKeys) ||
                  !facts.protectionKeys.every((key): key is string => typeof key === "string") ||
                  !facts.protectionKeys.includes(sessionId)
                ) {
                  throw new Error("Automation retention omitted canonical target coverage");
                }
                target = { sessionId, protectionKeys: facts.protectionKeys };
                assertCurrent();
                return true;
              },
              run: async (worker, commit) => {
                const plan = await executeSessionMessageRewriteOperation(worker, database.agentId, {
                  type: "session.automation.retention.prepare",
                  input: { scope, cutoff: input.cutoff, afterSeq, runs, turn, personalTurn },
                });
                assertCurrent();
                if (plan.coldArchiveSha256) {
                  return {
                    kind: "session-automation-retention",
                    rewritten: 0,
                    runtimeDeleted: 0,
                    coldArchiveSha256: plan.coldArchiveSha256,
                  };
                }
                runs = plan.runs;
                turn = plan.nextTurn;
                personalTurn = plan.personalTurn;
                if (!plan.rows.length && !plan.runtimeSeqs.length) {
                  return {
                    kind: "session-automation-retention",
                    rewritten: 0,
                    runtimeDeleted: 0,
                  };
                }
                return commit(() =>
                  executeSessionMessageRewriteOperation(worker, database.agentId, {
                    type: "session.automation.retention",
                    input: plan,
                  }),
                );
              },
              onCommitted: (candidate) => candidate,
            }),
          );
          assertCurrent();
          if (result.coldArchiveSha256) {
            if (restored) {
              throw new Error("Automation retention could not restore its cold transcript");
            }
            if (
              coldProbes >= MAX_COLD_PROBES_PER_SWEEP ||
              isSessionColdRetentionDeferred(sessionId, result.coldArchiveSha256, input.cutoff)
            ) {
              break;
            }
            coldProbes++;
            const restoredArchive = await withCronReceiptAuthorityMutation(receipts, (authority) =>
              restoreSessionColdTranscript(
                { ...scope, storePath: database.path },
                () => {
                  authority.assertCurrent();
                  assertCurrent();
                },
                undefined,
                undefined,
                undefined,
                { protectionKeys: target!.protectionKeys, cutoff: input.cutoff },
              ),
            );
            if (restoredArchive === false) {
              break;
            }
            restored = true;
            continue;
          }
          rewritten += result.rewritten;
          runtimeDeleted += result.runtimeDeleted;
          if (result.nextSeq === undefined) {
            break;
          }
          afterSeq = result.nextSeq;
        }
      }
      return { rewritten, runtimeDeleted };
    },
    { lane: maintenanceLane },
  );
}
