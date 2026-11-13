// Scheduled show_widget registration and allowlist coverage.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readCanvasDocumentHtmlSource } from "../canvas/documents.js";
import { resolveAgentRestartRecoveryContext } from "../gateway/agent-turn/agent-restart-recovery-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function expectWidget(tools: ReturnType<typeof createOpenClawTools>) {
  const tool = tools.find((candidate) => candidate.name === "show_widget");
  if (!tool) {
    throw new Error("Expected show_widget to be registered");
  }
  return tool;
}

function expectPinnedOnlySchema(tool: ReturnType<typeof expectWidget>): void {
  const schema = tool.parameters as {
    properties?: { pin?: { const?: boolean } };
    required?: string[];
  };
  expect(tool.requiredClientCaps).toBeUndefined();
  expect(schema.required).toContain("pin");
  expect(schema.properties?.pin?.const).toBe(true);
}

describe("pinned show_widget registration", () => {
  it.each([undefined, "agent:main:cron:job:run:detached"])(
    "requires a persistent session for recovered authoring (%s)",
    (agentSessionKey) => {
      const tools = createOpenClawTools({ agentSessionKey, inlineWidgetAuthoring: true });
      expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
    },
  );

  it("publishes recovered widget revisions in chat and applies tool policy", async () => {
    const stateDir = tempDirs.make("openclaw-recovered-inline-widget-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const recovery = resolveAgentRestartRecoveryContext({
      isRestartRecoveryResumeRun: true,
      canUseInternalRuntimeHandoff: true,
      expectedExistingSessionId: "recovered-session",
      resolvedSessionId: "recovered-session",
      runId: "recovered-run",
      sessionEntry: {
        sessionId: "recovered-session",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "recovered-run",
        restartRecoveryDeliverySourceRunId: "original-ui-run",
        restartRecoverySourceIngress: "control-ui",
      },
    });
    expect(recovery).toBeDefined();
    const options = {
      sessionKey: "agent:main:dashboard:recovered",
      ...recovery,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    };
    const tool = expectWidget(createOpenClawCodingTools(options));
    const documents: string[] = [];
    for (const version of ["Original comparison", "Updated comparison"]) {
      const result = await tool.execute("recovered-widget", {
        title: "Comparison",
        name: "comparison",
        widget_code: `<main>${version}</main>`,
        final: true,
      });
      expect(result.details).toMatchObject({
        kind: "canvas",
        presentation: { target: "assistant_message", sandbox: "scripts" },
      });
      const view = asOptionalRecord(asOptionalRecord(result.details)?.view);
      if (typeof view?.id !== "string") {
        throw new Error("Expected a hosted inline widget");
      }
      documents.push(view.id);
      expect(await readCanvasDocumentHtmlSource(view.id, { stateDir })).toMatchObject({
        html: expect.stringContaining(version),
        cspSandbox: "scripts",
      });
      expect(view).not.toHaveProperty("boardWidgetName");
    }
    expect(documents[0]).not.toBe(documents[1]);
    expect(await readCanvasDocumentHtmlSource(documents[0]!, { stateDir })).toMatchObject({
      html: expect.stringContaining("Original comparison"),
    });
    await expect(
      tool.execute("recovered-device", {
        title: "Comparison",
        widget_code: "<main>Updated comparison</main>",
        presentation: { target: "node_panel" },
      }),
    ).rejects.toThrow(/chat-only/);
    const deniedTools = createOpenClawCodingTools({
      ...options,
      config: { tools: { deny: ["show_widget"] } },
    });
    expect(deniedTools.some((candidate) => candidate.name === "show_widget")).toBe(false);
  });

  it("does not let scheduled provenance replace an explicit widget cap", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("honors an explicit widget deny on the scheduled surface", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
      runtimeToolAllowlist: ["show_widget"],
      config: { tools: { deny: ["show_widget"] } },
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it.each(["canvas"])(
    "lets a server-authorized %s cap select pinned widget authoring",
    (toolName) => {
      const toolsAllow = [toolName];
      const plan = resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow });
      const tools = createOpenClawCodingTools({
        sessionKey: "agent:main:dashboard:scheduled",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        runtimeToolAllowlist: plan.runtimeToolAllowlist,
        includeCoreTools: plan.includeCoreTools,
        config: { tools: { allow: toolsAllow } },
        toolConstructionPlan: plan.codingToolConstructionPlan,
      });

      expectPinnedOnlySchema(expectWidget(tools));
    },
  );

  it("keeps scheduled turns with a real inline client on the normal widget surface", () => {
    const tool = expectWidget(
      createOpenClawTools({
        agentSessionKey: "agent:main:dashboard:scheduled",
        gatewayCallerScheduled: true,
        runtimeToolAllowlist: ["show_widget"],
        clientCaps: ["inline-widgets"],
      }),
    );
    const schema = tool.parameters as { required?: string[] };

    expect(tool.requiredClientCaps).toEqual(["inline-widgets"]);
    expect(schema.required).not.toContain("pin");
  });
});
