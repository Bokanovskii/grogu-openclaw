import {
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
// The captured source plugin resolves its TypeScript sibling directly.
import {
  AUTOMATIONS_CHAT_TOOL_NAMES,
  AUTOMATIONS_CHAT_PLUGIN_ID,
  AutomationsChatListParametersSchema,
  AutomationsChatProposeCreateParametersSchema,
  AutomationsChatProposePatchParametersSchema,
  AutomationsChatReadParametersSchema,
  isAutomationsChatListParameters,
  isAutomationsChatProposeCreateParameters,
  isAutomationsChatProposePatchParameters,
  isAutomationsChatReadParameters,
  type AutomationsChatBindings,
} from "./contract.ts";

function isAutomationsChatBindings(value: unknown): value is AutomationsChatBindings {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "list" in value &&
    typeof value.list === "function" &&
    "read" in value &&
    typeof value.read === "function" &&
    "proposeCreate" in value &&
    typeof value.proposeCreate === "function" &&
    "proposePatch" in value &&
    typeof value.proposePatch === "function"
  );
}

function createTools(context: OpenClawPluginToolContext<2>) {
  const bindings = context.toolRuntimeBindings?.[AUTOMATIONS_CHAT_PLUGIN_ID];
  if (!isAutomationsChatBindings(bindings)) {
    return null;
  }
  const invoke = async <T>(run: () => Promise<T>) => {
    context.assertInvocationCurrent();
    const result = await run();
    context.assertInvocationCurrent();
    return textResult(JSON.stringify(result), result);
  };
  const invalid = () =>
    textResult("Invalid automation request. No changes were made.", {
      status: "invalid",
      writeApplied: false,
    });

  return [
    {
      name: "automations_list",
      label: "List automations",
      description: "List this member's private automations. This tool does not change anything.",
      parameters: AutomationsChatListParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsChatListParameters(params)
          ? invoke(() => bindings.list(params))
          : invalid();
      },
    },
    {
      name: "automations_read",
      label: "Read automation",
      description:
        "Read one of this member's private automations. Other members' automations are not visible.",
      parameters: AutomationsChatReadParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsChatReadParameters(params)
          ? invoke(() => bindings.read(params))
          : invalid();
      },
    },
    {
      name: "automations_propose_create",
      label: "Propose automation",
      description:
        "Validate and propose a paused private automation. This is only a suggestion; it is never saved or scheduled.",
      parameters: AutomationsChatProposeCreateParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsChatProposeCreateParameters(params)
          ? invoke(() => bindings.proposeCreate(params))
          : invalid();
      },
    },
    {
      name: "automations_propose_patch",
      label: "Propose automation changes",
      description:
        "Propose changes to one of this member's paused private automations. The proposal cannot turn it on and is never saved.",
      parameters: AutomationsChatProposePatchParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsChatProposePatchParameters(params)
          ? invoke(() => bindings.proposePatch(params))
          : invalid();
      },
    },
  ];
}

export default definePluginEntry({
  id: AUTOMATIONS_CHAT_PLUGIN_ID,
  name: "Alcove Automations Chat",
  description: "Member-scoped read and proposal tools for protected automation conversations.",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => createTools(context),
      },
      { names: [...AUTOMATIONS_CHAT_TOOL_NAMES] },
    );
  },
});
