import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  AUTOMATIONS_CHAT_PLUGIN_ID,
  NEXT_CHECK_TOOL_NAME,
  NextCheckParametersSchema,
  isNextCheckParameters,
  type NextCheckBindings,
} from "./contract.ts";

function isNextCheckBindings(value: unknown): value is NextCheckBindings {
  return (
    typeof value === "object" &&
    value !== null &&
    "parseDurationMs" in value &&
    typeof value.parseDurationMs === "function" &&
    "proposeNextCheck" in value &&
    typeof value.proposeNextCheck === "function"
  );
}

export function createNextCheckTool(context: OpenClawPluginToolContext<2>) {
  const bindings = context.toolRuntimeBindings?.[AUTOMATIONS_CHAT_PLUGIN_ID];
  if (!isNextCheckBindings(bindings)) {
    return null;
  }
  const invalid = () =>
    jsonResult({ status: "invalid", writeApplied: false, reason: "expected_positive_duration" });
  return {
    name: NEXT_CHECK_TOOL_NAME,
    label: "Propose next check",
    description:
      "Propose a delay from the successful end of this scheduled check. Check sooner when activity is high or later when quiet. The scheduler enforces the member's bounds; omit the proposal to use the fallback interval. This tool does not set a timer.",
    parameters: NextCheckParametersSchema,
    async execute(_toolCallId: string, params: unknown) {
      if (!isNextCheckParameters(params)) {
        return invalid();
      }
      let delayMs: number;
      try {
        delayMs = bindings.parseDurationMs(params.in);
      } catch {
        return invalid();
      }
      if (delayMs <= 0) {
        return invalid();
      }
      context.assertInvocationCurrent();
      bindings.proposeNextCheck(delayMs);
      return jsonResult({ status: "proposed", proposedDelayMs: delayMs, writeApplied: false });
    },
  };
}
