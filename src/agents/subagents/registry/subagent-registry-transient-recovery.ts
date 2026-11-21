import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import { runSubagentRegistryWorkerWrite } from "./subagent-registry-persistence.js";

export type TransientRegistryRecovery = {
  writeId: string;
  childSessionKey: string;
  childSessionId: string;
  childLifecycleRevision: string;
  parentSessionKey: string;
};

/** Retire only the exact durable owner before removing its transient child. */
export async function retireTransientSubagentRun(
  input: Omit<TransientRegistryRecovery, "writeId"> & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  },
): Promise<boolean> {
  const { env, assertCurrent: assertOwner, ...identity } = input;
  const assertCurrent = () => {
    assertOwner();
    if ([...getSubagentRunsForChildSession(identity.childSessionKey)].length !== 0) {
      throw new Error("Transient child still has a live registry owner");
    }
  };
  assertCurrent();
  const context = captureOpenClawStateWorkerContext({ env });
  const request = { ...identity, writeId: randomUUID() };
  return runSubagentRegistryWorkerWrite(context, () => ({
    kind: "completion",
    writeId: request.writeId,
    assertCurrent,
    execute: (scope) => scope.execute({ type: "subagents.recoverTransient", input: request }),
    decode: (result) => {
      if (
        !isRecord(result) ||
        result.writeId !== request.writeId ||
        typeof result.safe !== "boolean"
      ) {
        throw new Error("Transient registry recovery returned an invalid receipt");
      }
      return result.safe;
    },
  }));
}
