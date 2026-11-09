import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, it, onTestFinished, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../src/agents/admitted-run-context.js";
import { prepareEmbeddedAttemptBootstrap } from "../src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptPromptAssembly } from "../src/agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "../src/agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import { withAgentPluginRegistry } from "../src/agents/runtime-plugins.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { buildConfiguredAgentSystemPrompt } from "../src/agents/system-prompt-config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { HeartbeatWakeRequest } from "../src/infra/heartbeat-wake-contracts.js";
import { setSessionEventWakeHandler } from "../src/infra/session-event-wake.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../src/infra/system-events.js";
import { createHookRunner } from "../src/plugins/hooks.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../src/plugins/loader.test-fixtures.js";

registerAgentSessionLoopTestLifecycle();
afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const pluginRoot = fileURLToPath(new URL("../grogu/plugins/grogu-coordination", import.meta.url));
const canonicalPolicy = fs.readFileSync(path.join(pluginRoot, "policy/AGENTS.md"), "utf8").trim();

it("routes private side-chat and completed research hints through the native Main queue and wake owner", async () => {
  useNoBundledPlugins();
  vi.useFakeTimers();
  const wake = vi.fn(async (_request: HeartbeatWakeRequest) => ({
    status: "skipped" as const,
    reason: "disabled",
  }));
  const disposeWake = setSessionEventWakeHandler(wake);
  onTestFinished(() => {
    disposeWake();
    resetSystemEventsForTest();
    vi.useRealTimers();
  });
  const workspace = makePluginLoaderTempDir();
  const config: OpenClawConfig = {
    session: { mainKey: "curator" },
    agents: { entries: { assistant: { workspace }, researcher: { workspace } } },
    plugins: {
      allow: ["grogu-coordination"],
      load: { paths: [pluginRoot] },
      entries: {
        "grogu-coordination": {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            agentIds: ["assistant", "researcher"],
            jobs: [
              { id: "intake", agentId: "assistant", label: "Intake", role: "intake" },
              { id: "research", agentId: "researcher", label: "Research", role: "research" },
            ],
          },
        },
      },
      slots: { memory: "none" },
    },
  };
  const originalConfig = structuredClone(config);
  await withAgentPluginRegistry({
    config,
    workspaceDir: workspace,
    run: async (registry) => {
      expect(registry.plugins.find(({ id }) => id === "grogu-coordination")?.status).toBe("loaded");
      const runner = createHookRunner(registry, { catchErrors: false });
      const sideChat = { channelId: "webchat", sessionKey: "agent:assistant:dashboard:trip" };
      await runner.runMessageReceived(
        { from: "owner", content: "PRIVATE_CHAT_BYTES", messageId: "first" },
        sideChat,
      );
      const mainKey = "agent:assistant:curator";
      expect(peekSystemEventEntries(mainKey)).toHaveLength(1);
      expect(peekSystemEventEntries(mainKey)[0]?.text).toContain(sideChat.sessionKey);
      expect(peekSystemEventEntries(mainKey)[0]?.text).not.toContain("PRIVATE_CHAT_BYTES");
      await runner.runMessageReceived(
        { from: "owner", content: "OTHER_PRIVATE_BYTES", messageId: "second" },
        sideChat,
      );
      expect(peekSystemEventEntries(mainKey)).toHaveLength(1);
      expect(peekSystemEventEntries(mainKey)[0]?.text).toContain("second");
      const beforeExcluded = peekSystemEventEntries(mainKey);
      for (const sessionKey of [
        undefined,
        "unqualified",
        mainKey,
        "agent:researcher:dashboard:unrelated",
        "agent:assistant:dashboard:incognito-private",
      ]) {
        await runner.runMessageReceived(
          { from: "owner", content: "DO_NOT_FORWARD", messageId: "excluded" },
          { channelId: "webchat", sessionKey },
        );
      }
      expect(peekSystemEventEntries(mainKey)).toEqual(beforeExcluded);
      const scheduler = {
        list: async () => [],
        add: async () => undefined,
        update: async () => undefined,
        remove: async () => ({ removed: false }),
        removeStaleJobFamily: async () => 0,
      };
      const controller = new AbortController();
      const cronContext = { getCron: () => scheduler, abortSignal: controller.signal };
      await runner.runCronReconciled({ reason: "startup", enabled: true }, cronContext);
      const finished = {
        action: "finished" as const,
        jobId: "research",
        agentId: "researcher",
        runAtMs: 1_000,
        status: "ok" as const,
        summary: "PRIVATE_RESEARCH_BYTES",
      };
      for (const event of [
        { ...finished, runAtMs: 0, status: "error" as const },
        { ...finished, runAtMs: 0, job: { id: "research", enabled: false } },
        { ...finished, jobId: "not-selected" },
        { ...finished, agentId: "assistant" },
      ]) {
        await runner.runCronChanged(event, cronContext);
      }
      expect(peekSystemEventEntries(mainKey)).toEqual(beforeExcluded);
      await runner.runCronChanged(finished, cronContext);
      const researchHint = peekSystemEventEntries(mainKey);
      expect(researchHint).toHaveLength(1);
      expect(researchHint[0]?.text).toContain("research");
      expect(researchHint[0]?.text).not.toContain("PRIVATE_RESEARCH_BYTES");
      await runner.runCronChanged(finished, cronContext);
      expect(peekSystemEventEntries(mainKey)).toEqual(researchHint);
      controller.abort();
      await runner.runCronChanged({ ...finished, runAtMs: 2_000 }, cronContext);
      await runner.runMessageReceived(
        { from: "owner", content: "LATE_PRIVATE_BYTES", messageId: "retired" },
        sideChat,
      );
      expect(peekSystemEventEntries(mainKey)).toEqual(researchHint);
      await vi.advanceTimersByTimeAsync(250);
      expect(wake).toHaveBeenCalledOnce();
      expect(wake.mock.calls[0]?.[0]).toMatchObject({
        source: "hook",
        intent: "event",
        agentId: "assistant",
        sessionKey: mainKey,
      });
      expect(config).toEqual(originalConfig);
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    },
  });
});

it.each([
  { name: "conversation", sessionKey: "agent:assistant:main", trigger: "user", lightweight: false },
  { name: "current job", sessionKey: "agent:assistant:main", trigger: "cron", lightweight: false },
  {
    name: "isolated job",
    sessionKey: "agent:assistant:cron:shopping",
    trigger: "cron",
    lightweight: false,
  },
  {
    name: "lightweight job",
    sessionKey: "agent:assistant:cron:shopping",
    trigger: "cron",
    lightweight: true,
  },
] as const)(
  "assembles the complete shared policy for $name without changing history",
  async (scenario) => {
    useNoBundledPlugins();
    const workspace = makePluginLoaderTempDir();
    const workspaceInstruction = "Synthetic workspace-specific instruction.";
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), workspaceInstruction);
    const config: OpenClawConfig = {
      agents: { entries: { assistant: { workspace } } },
      plugins: {
        allow: ["grogu-coordination"],
        load: { paths: [pluginRoot] },
        entries: {
          "grogu-coordination": {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: {
              agentIds: ["assistant"],
              jobs: [
                {
                  id: "shopping",
                  agentId: "assistant",
                  label: "Shopping",
                  role: "purchase-watch",
                  sourceSessionKey: "agent:assistant:dashboard:shopping",
                },
              ],
            },
          },
        },
        slots: { memory: "none" },
      },
    };
    const runId = `coordination-${scenario.name.replaceAll(" ", "-")}`;
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      scenario.sessionKey,
      "coordination-proof",
    );
    onTestFinished(() => {
      admission.close();
      forgetPromptBuildDrainCacheForRun(runId);
    });
    const sessionManager = SessionManager.inMemory();
    await sessionManager.appendMessageAsync({
      role: "user",
      content: "Unrelated existing conversation history.",
      timestamp: 1,
    });
    const { session, modelRegistry } = await createTestSession({ sessionManager });
    const priorMessages = structuredClone(session.messages);
    const attempt: EmbeddedRunAttemptParams = {
      admittedRunContext: await admission.admit("embedded"),
      authStorage: modelRegistry.authStorage,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry,
      config,
      model: testModel,
      modelId: testModel.id,
      provider: testModel.provider,
      thinkLevel: "off",
      prompt: "Continue the existing shopping work.",
      transcriptPrompt: "Continue the existing shopping work.",
      runId,
      sessionId: runId,
      sessionKey: scenario.sessionKey,
      sessionFile: "",
      sessionPersistence: "detached",
      trigger: scenario.trigger,
      jobId: scenario.trigger === "cron" ? "shopping" : undefined,
      bootstrapContextMode: scenario.lightweight ? "lightweight" : undefined,
      timeoutMs: 10_000,
      workspaceDir: workspace,
    };
    await withAgentPluginRegistry({
      config,
      workspaceDir: workspace,
      run: async (registry) => {
        expect(registry.plugins.find(({ id }) => id === "grogu-coordination")?.status).toBe(
          "loaded",
        );
        const bootstrap = await prepareEmbeddedAttemptBootstrap({
          attempt,
          setup: {
            effectiveWorkspace: workspace,
            resolvedWorkspace: workspace,
            sessionAgentId: "assistant",
          },
          hasReadTool: false,
          isRawModelRun: false,
        });
        const systemPrompt = buildConfiguredAgentSystemPrompt({
          config,
          agentId: "assistant",
          workspaceDir: workspace,
          contextFiles: bootstrap.contextFiles,
          promptMode: scenario.trigger === "cron" ? "minimal" : "full",
        });
        let finalSystemPrompt = "";
        const prompt = await prepareEmbeddedAttemptPromptAssembly({
          attempt,
          activeSession: session,
          sessionManager,
          hookRunner: createHookRunner(registry, { catchErrors: false }),
          hookAgentId: "assistant",
          diagnosticTrace: { traceId: "11111111111111111111111111111111" },
          isRawModelRun: false,
          sessionAgentId: "assistant",
          runtimeModel: testModel.id,
          systemPromptText: systemPrompt,
          runAbortSignal: new AbortController().signal,
          applyPromptBuildToolsAllow: () => [],
          setActiveSessionSystemPrompt: (value) => {
            finalSystemPrompt = value;
            session.setBaseSystemPrompt(value);
          },
          setLeasedSteering: () => {},
        });
        expect(finalSystemPrompt).toContain(canonicalPolicy);
        expect(finalSystemPrompt.split(canonicalPolicy)).toHaveLength(2);
        expect(finalSystemPrompt.includes(workspaceInstruction)).toBe(!scenario.lightweight);
        expect(prompt.effectivePrompt.includes("Originating subject:")).toBe(
          scenario.trigger === "cron",
        );
        expect(finalSystemPrompt).not.toContain("Unrelated existing conversation history.");
        expect(session.messages).toEqual(priorMessages);
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      },
    });
  },
);
