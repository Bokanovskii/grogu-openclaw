import { retainRequestOwnedSubagentContent } from "./subagent-registry-transient-content.js";
import {
  rememberSubagentRunVersion,
  subagentRunRecordVersion,
} from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { retainSubagentRunRuntimeOwner } from "./subagent-run-generation.js";

export function prepareRestoredSubagentRun(
  current: SubagentRunRecord | undefined,
  restored: SubagentRunRecord,
): SubagentRunRecord {
  retainSubagentRunRuntimeOwner(current, restored);
  const installed = retainRequestOwnedSubagentContent(current, restored);
  if (installed !== restored) {
    const version = subagentRunRecordVersion(restored);
    if (version) {
      rememberSubagentRunVersion(installed, version);
    }
  }
  return installed;
}
