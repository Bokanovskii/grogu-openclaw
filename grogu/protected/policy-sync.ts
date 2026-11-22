import { execFile } from "node:child_process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProtectedPolicyOperation } from "../../src/state/protected-policy-store.js";
import {
  beginProtectedPolicy,
  listPendingProtectedPolicy,
  settleProtectedPolicy,
} from "./admission-store.js";

export type ProtectedPolicyResult = "synced" | "failed" | "unknown";
export type ProtectedPolicySynchronizer = (
  operation: ProtectedPolicyOperation,
) => Promise<ProtectedPolicyResult>;

async function runFixedPolicyHelper(
  operation: ProtectedPolicyOperation,
): Promise<ProtectedPolicyResult> {
  const request = {
    revision: operation.revision,
    add: operation.desired === "approved" ? [operation.email] : [],
    remove: operation.desired === "removed" ? [operation.email] : [],
  };
  return new Promise((resolve) => {
    let inputFailed = false;
    const child = execFile(
      "/usr/bin/sudo",
      ["-n", "/Library/PrivilegedHelperTools/ai.grogu.protected-policy"],
      { encoding: "utf8", maxBuffer: 4096, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      (error, stdout) => {
        if (inputFailed) {
          resolve("unknown");
          return;
        }
        if (error) {
          resolve(error.code === "ENOENT" ? "failed" : "unknown");
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (
            isRecord(result) &&
            result.revision === operation.revision &&
            (result.status === "synced" || result.status === "unknown")
          ) {
            resolve(result.status);
            return;
          }
        } catch {
          // A malformed helper response cannot prove the remote write outcome.
        }
        resolve("unknown");
      },
    );
    if (!child.stdin) {
      inputFailed = true;
      return;
    }
    child.stdin.on("error", () => {
      inputFailed = true;
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createProtectedPolicySync(
  stateDir: string,
  synchronize: ProtectedPolicySynchronizer = runFixedPolicyHelper,
) {
  let running: Promise<void> | undefined;
  let requested = false;
  let closing = false;
  let activeId: string | undefined;
  let activeGeneration = 0;
  const getStatus = async () => {
    while (true) {
      const generation = activeGeneration;
      const active = activeId;
      const queue = await listPendingProtectedPolicy(stateDir);
      if (generation !== activeGeneration) {
        continue;
      }
      if (
        active &&
        queue.blockedPersonId === active &&
        queue.operations.some(
          (operation) => operation.id === active && operation.state === "pending",
        )
      ) {
        return { blocked: false };
      }
      return { blocked: queue.blocked, blockedPersonId: queue.blockedPersonId };
    }
  };
  const drain = async () => {
    while (requested) {
      if (closing) {
        return;
      }
      requested = false;
      const queue = await listPendingProtectedPolicy(stateDir);
      if (queue.blocked || queue.operations.some((operation) => operation.state === "unknown")) {
        requested = false;
        return;
      }
      for (const candidate of queue.operations) {
        if (closing) {
          return;
        }
        const fresh = await listPendingProtectedPolicy(stateDir);
        if (fresh.blocked) {
          requested = false;
          return;
        }
        const current = fresh.operations.find(
          (operation) =>
            operation.id === candidate.id &&
            operation.revision === candidate.revision &&
            operation.state === "pending",
        );
        if (!current) {
          continue;
        }
        activeId = current.id;
        activeGeneration++;
        try {
          if (!(await beginProtectedPolicy(stateDir, current))) {
            continue;
          }
          const state = await synchronize(current);
          await settleProtectedPolicy(stateDir, {
            id: current.id,
            email: current.email,
            revision: current.revision,
            state,
          });
          if (state === "unknown") {
            return;
          }
        } finally {
          activeId = undefined;
          activeGeneration++;
        }
      }
    }
  };
  const trigger = () => {
    if (closing) {
      return;
    }
    requested = true;
    if (!running) {
      running = drain()
        .catch(() => {
          process.stderr.write("Alcove policy synchronization could not finish.\n");
        })
        .finally(() => {
          running = undefined;
          if (requested && !closing) {
            trigger();
          }
        });
    }
  };
  return {
    trigger,
    isInFlight: (id: string) => activeId === id,
    getStatus,
    stop: async () => {
      closing = true;
      await running;
    },
  };
}
