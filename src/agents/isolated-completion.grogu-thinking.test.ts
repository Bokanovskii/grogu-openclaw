import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
} from "./isolated-completion.test-support.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetIsolatedCompletionTestState);

it.each([
  ["configured default", "sparky", true, undefined, undefined, undefined, "ultra"],
  ["explicit request", "sparky", true, "low", undefined, undefined, "low"],
  ["model disabled", "sparky", true, undefined, false, undefined, "off"],
  ["agent override", "sparky", true, undefined, undefined, "high", "high"],
  ["agent disabled", "sparky", true, undefined, undefined, "off", "off"],
  ["no private profile", "sparky", false, undefined, undefined, undefined, undefined],
  ["another provider", "openai", true, undefined, undefined, undefined, undefined],
] as const)(
  "applies Grogu isolated thinking policy: %s",
  async (_name, provider, privateProfile, requested, modelThinking, agentThinking, expected) => {
    const profileFile = path.join(tempDirs.make("openclaw-isolated-thinking-"), "profile.json");
    writeFileSync(profileFile, JSON.stringify({ schemaVersion: 1, bindings: {} }), { mode: 0o600 });
    vi.stubEnv("GROGU_PROFILE_FILE", privateProfile ? profileFile : undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "ultra",
          ...(modelThinking !== undefined
            ? { models: { "sparky/gpt-test": { params: { thinking: modelThinking } } } }
            : {}),
        },
        ...(agentThinking ? { entries: { main: { thinkingDefault: agentThinking } } } : {}),
      },
    };
    Object.assign(preparedModelRuntime, { config });
    mocks.prepareSimpleCompletionModel.mockResolvedValue({
      model: makeProviderModelFixture({
        api: "openai-completions",
        provider,
        id: "gpt-test",
        baseUrl: "https://completion.example.invalid",
      }),
      auth: { apiKey: "test-key", source: "test", mode: "api-key" },
    });
    const dispatch = vi.fn(async () => ({
      assistant: { ...isolatedAssistant([{ type: "text", text: "done" }]), provider },
    }));
    registerIsolatedHarness({ id: "test-isolated", runIsolatedCompletionV2: dispatch });
    await expect(
      runIsolatedCompletion({
        ...isolatedRequest(),
        config: { agents: { defaults: { thinkingDefault: "medium" } } },
        provider,
        agentHarnessRuntimeOverride: "test-isolated",
        thinkLevel: requested,
        streamParams: { maxTokens: 1_024 },
      }),
    ).resolves.toMatchObject({ text: "done" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: expected, streamParams: { maxTokens: 1_024 } }),
    );
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  },
);
