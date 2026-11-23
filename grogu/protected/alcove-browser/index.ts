import {
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
// The captured source plugin resolves its TypeScript sibling directly.
import {
  ALCOVE_BROWSER_PLUGIN_ID,
  ALCOVE_BROWSER_TOOL_NAMES,
  AlcoveBrowserBackParametersSchema,
  AlcoveBrowserFollowLinkParametersSchema,
  AlcoveBrowserOpenParametersSchema,
  AlcoveBrowserSnapshotParametersSchema,
  isAlcoveBrowserFollowLinkParameters,
  isAlcoveBrowserOpenParameters,
  type AlcoveBrowserBindings,
  type AlcoveBrowserResult,
} from "./contract.ts";

function isAlcoveBrowserBindings(value: unknown): value is AlcoveBrowserBindings {
  return (
    typeof value === "object" &&
    value !== null &&
    "browser" in value &&
    value.browser === "fresh" &&
    "open" in value &&
    typeof value.open === "function" &&
    "snapshot" in value &&
    typeof value.snapshot === "function" &&
    "followLink" in value &&
    typeof value.followLink === "function" &&
    "back" in value &&
    typeof value.back === "function"
  );
}

function render(result: AlcoveBrowserResult): string {
  if (result.status !== "ok") {
    return `Browser ${result.status}: ${result.reason}`;
  }
  return wrapExternalContent(
    [
      `URL: ${result.url}`,
      `Title: ${result.title}`,
      result.snapshot,
      ...(result.truncated ? ["[snapshot truncated]"] : []),
    ].join("\n"),
    { source: "browser" },
  );
}

function createTools(context: OpenClawPluginToolContext<2>) {
  const bindings = context.toolRuntimeBindings?.[ALCOVE_BROWSER_PLUGIN_ID];
  if (!isAlcoveBrowserBindings(bindings)) {
    return null;
  }
  const invoke = async (run: () => Promise<AlcoveBrowserResult>) => {
    context.assertInvocationCurrent();
    const result = await run();
    context.assertInvocationCurrent();
    return textResult(render(result), result);
  };
  const invalid = () =>
    textResult("Invalid browser request.", { status: "invalid", reason: "invalid parameters" });
  return [
    {
      name: ALCOVE_BROWSER_TOOL_NAMES[0],
      label: "Open web page",
      description:
        "Open a public http or https page in this chat's private, temporary browser and return a text snapshot with link refs. The browser has no saved logins and cannot reach private networks.",
      parameters: AlcoveBrowserOpenParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAlcoveBrowserOpenParameters(params)
          ? invoke(() => bindings.open(params))
          : invalid();
      },
    },
    {
      name: ALCOVE_BROWSER_TOOL_NAMES[1],
      label: "Read web page",
      description: "Return a fresh text snapshot of the current page in this chat's browser.",
      parameters: AlcoveBrowserSnapshotParametersSchema,
      async execute() {
        return invoke(() => bindings.snapshot());
      },
    },
    {
      name: ALCOVE_BROWSER_TOOL_NAMES[2],
      label: "Follow link",
      description:
        "Navigate to the target of a link ref (for example e12) from the latest snapshot. This only follows links; it does not click buttons or submit forms.",
      parameters: AlcoveBrowserFollowLinkParametersSchema,
      async execute(_toolCallId: string, params: unknown) {
        return isAlcoveBrowserFollowLinkParameters(params)
          ? invoke(() => bindings.followLink(params))
          : invalid();
      },
    },
    {
      name: ALCOVE_BROWSER_TOOL_NAMES[3],
      label: "Go back",
      description: "Go back one page in this chat's browser.",
      parameters: AlcoveBrowserBackParametersSchema,
      async execute() {
        return invoke(() => bindings.back());
      },
    },
  ];
}

export default definePluginEntry({
  id: ALCOVE_BROWSER_PLUGIN_ID,
  name: "Alcove Browser",
  description: "Read-only tools for a fresh private browser session in an interactive member chat.",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: createTools,
      },
      { names: [...ALCOVE_BROWSER_TOOL_NAMES] },
    );
  },
});
