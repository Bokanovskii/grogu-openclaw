import {
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
// The captured source plugin resolves its TypeScript sibling directly.
import {
  AUTOMATIONS_AUTHORING_TOOL_NAMES,
  AUTOMATIONS_CHAT_TOOL_NAMES,
  AUTOMATIONS_CHAT_PLUGIN_ID,
  AutomationsAuthoringReadParametersSchema,
  AutomationsAuthoringSaveParametersSchema,
  AutomationsAuthoringUpdateParametersSchema,
  AutomationsChatListParametersSchema,
  AutomationsChatProposeCreateParametersSchema,
  AutomationsChatProposePatchParametersSchema,
  AutomationsChatReadParametersSchema,
  NEXT_CHECK_TOOL_NAME,
  isAutomationsAuthoringSaveParameters,
  isAutomationsAuthoringUpdateParameters,
  isAutomationsChatListParameters,
  isAutomationsChatProposeCreateParameters,
  isAutomationsChatProposePatchParameters,
  isAutomationsChatReadParameters,
  type AutomationsAuthoringBindings,
  type AutomationsChatBindings,
} from "./contract.ts";
import { createNextCheckTool } from "./next-check.ts";

function isAutomationsAuthoringBindings(value: unknown): value is AutomationsAuthoringBindings {
  return (
    typeof value === "object" &&
    value !== null &&
    "authoring" in value &&
    value.authoring === "automation" &&
    "read" in value &&
    typeof value.read === "function" &&
    "update" in value &&
    typeof value.update === "function" &&
    "save" in value &&
    typeof value.save === "function"
  );
}

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
  if (isAutomationsAuthoringBindings(bindings)) {
    return createAuthoringTools(context, bindings);
  }
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

function createAuthoringTools(
  context: OpenClawPluginToolContext<2>,
  bindings: AutomationsAuthoringBindings,
) {
  const invoke = async <T>(run: () => Promise<T>) => {
    context.assertInvocationCurrent();
    const result = await run();
    context.assertInvocationCurrent();
    return textResult(JSON.stringify(result), result);
  };
  const invalid = () =>
    textResult("Invalid automation draft request. No changes were made.", {
      status: "invalid",
      writeApplied: false,
    });
  return [
    {
      name: "automation_draft_read",
      label: "Read automation draft",
      description:
        "Read the automation draft the member is editing now, its draft revision, and its saved record if one exists.",
      parameters: AutomationsAuthoringReadParametersSchema,
      async execute() {
        return invoke(() => bindings.read());
      },
    },
    {
      name: "automation_draft_update",
      label: "Update automation draft",
      description:
        "Replace the member's unsaved automation draft with a complete revised draft. On draft_updated the app shows the member a card of the new draft; nothing is saved or scheduled. Call this before describing a change, and only describe changes it returned draft_updated for.",
      parameters: AutomationsAuthoringUpdateParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsAuthoringUpdateParameters(params)
          ? invoke(() => bindings.update(params))
          : invalid();
      },
    },
    {
      name: "automation_draft_save",
      label: "Save automation draft",
      description:
        "Only when the member explicitly asks to save: save the unchanged draft they sent this turn as a paused automation. Call directly without reading the revision first. A changed or incomplete draft is refused. This never turns the automation on.",
      parameters: AutomationsAuthoringSaveParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAutomationsAuthoringSaveParameters(params)
          ? invoke(() => bindings.save(params))
          : invalid();
      },
    },
  ];
}

export default definePluginEntry({
  id: AUTOMATIONS_CHAT_PLUGIN_ID,
  name: "Alcove Automations Chat",
  description:
    "Member-scoped read, proposal, and authoring-draft tools for protected automation conversations.",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => createTools(context),
      },
      { names: [...AUTOMATIONS_CHAT_TOOL_NAMES, ...AUTOMATIONS_AUTHORING_TOOL_NAMES] },
    );
    api.registerTool(
      { contextVersion: 2, create: createNextCheckTool },
      { name: NEXT_CHECK_TOOL_NAME, optional: true },
    );
  },
});
