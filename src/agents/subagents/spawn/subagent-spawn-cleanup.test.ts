import { describe, expect, it, vi } from "vitest";
import "./subagent-spawn-model.mocks.shared.js";
import type { CliDeps } from "../../../cli/deps.types.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { withLocalGatewayRequestScope } from "../../../gateway/local-request-context.js";
import { LegacyPluginSdkResourceHost } from "../../../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  bindSubagentSpawnCleanup,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
  it("removes a provisional request-owned child after local dispatch admission fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const parentKey = "agent:main:parent";
      const parent = { agentId: "main", sessionKey: parentKey };
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(parent, {
        sessionId: "parent-id",
        lifecycleRevision: "parent-revision",
        updatedAt: 1,
        createdVia: "plugin",
        createdActor: { type: "human", source: "profile", id: "p1" },
      });
      const resources = new LegacyPluginSdkResourceHost();
      const dispatch = vi.fn(async () => {
        throw new Error("Unexpected Gateway dispatch");
      });
      spawnTesting.setDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
      let preparedKey: string | undefined;
      try {
        await resources.run(() =>
          withLocalGatewayRequestScope(
            { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
            async () => {
              const result = await spawnSubagentDirect(
                {
                  task: "synthetic task",
                  cleanup: "delete",
                  expectsCompletionMessage: false,
                  context: "isolated",
                  lightContext: true,
                },
                {
                  config: cfg,
                  agentSessionKey: parentKey,
                  expectedParentSessionId: "parent-id",
                  transientLifetime: {
                    parentSessionKey: parentKey,
                    parentSessionId: "parent-id",
                    profileId: "p1",
                  },
                  beforeChildDispatch: ({ sessionKey }) => {
                    preparedKey = sessionKey;
                    throw new Error("synthetic admission failure");
                  },
                },
              );
              expect(result).toMatchObject({
                status: "error",
                error: "synthetic admission failure",
              });
              expect(preparedKey).toBeDefined();
              expect(
                loadSessionEntry({ agentId: "main", sessionKey: preparedKey! }),
              ).toBeUndefined();
              expect(dispatch).not.toHaveBeenCalled();
            },
          ),
        );
      } finally {
        spawnTesting.setDepsForTest();
        await resources.close();
      }
    });
  });

  it("stops and deletes the exact provisional child through its local Gateway owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = "agent:main:subagent:local-cleanup";
      const scope = { agentId: "main", sessionKey: key };
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(scope, {
        sessionId: "local-child",
        lifecycleRevision: "local-revision",
        updatedAt: 1,
      });
      const resources = new LegacyPluginSdkResourceHost();
      try {
        await resources.run(() =>
          withLocalGatewayRequestScope(
            { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
            async () => {
              const gatewayScope = getPluginRuntimeGatewayRequestScope();
              const resolveGatewayContext = gatewayScope?.resolveGatewayContext;
              const context = gatewayScope?.context;
              if (!resolveGatewayContext || !context) {
                throw new Error("Local Gateway owner is unavailable");
              }
              const owner = bindSubagentSpawnCleanup({
                childSessionKey: key,
                resolveGatewayContext,
                isCurrent: () => true,
                canAbortAcceptedRun: () => true,
                getSessionIdentity: () => ({
                  expectedSessionId: "local-child",
                  expectedLifecycleRevision: "local-revision",
                }),
              });
              const registration = registerChatAbortController({
                chatAbortControllers: context.chatAbortControllers,
                runId: "local-run",
                sessionId: "local-child",
                sessionKey: key,
                timeoutMs: 60_000,
              });
              if (!registration.registered) {
                throw new Error("Child run was not registered");
              }
              owner.bindAcceptedRun("local-run");
              await expect(
                owner.callGateway({
                  method: "chat.abort",
                  params: { sessionKey: key, runId: "other-run" },
                }),
              ).rejects.toThrow("Subagent cleanup run does not match");
              expect(registration.entry.controller.signal.aborted).toBe(false);
              await expect(
                owner.callGateway({
                  method: "chat.abort",
                  params: { sessionKey: key, runId: "local-run" },
                }),
              ).resolves.toMatchObject({ aborted: true, runIds: ["local-run"] });
              expect(registration.entry.controller.signal.aborted).toBe(true);
              await expect(
                owner.callGateway({
                  method: "sessions.delete",
                  params: {
                    key,
                    expectedSessionId: "other-child",
                    expectedLifecycleRevision: "local-revision",
                  },
                }),
              ).rejects.toThrow("Subagent cleanup session does not match");
              expect(loadSessionEntry(scope)?.sessionId).toBe("local-child");
              await expect(
                cleanupProvisionalSession(key, {
                  isCurrent: owner.isCurrent,
                  callGateway: owner.callGateway,
                  deleteTranscript: true,
                  expectedSessionId: "local-child",
                  expectedLifecycleRevision: "local-revision",
                }),
              ).resolves.toBe(true);
              expect(loadSessionEntry(scope)).toBeUndefined();
            },
          ),
        );
      } finally {
        await resources.close();
      }
    });
  });

  it("requires both frozen session identities before deletion", async () => {
    const callGateway = vi.fn();

    await expect(
      cleanupProvisionalSession("agent:main:subagent:child", {
        expectedSessionId: "session-id",
        callGateway,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("accepts chat.abort only when it confirms the exact run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        emitLifecycleHooks: false,
        deleteTranscript: true,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 60_000,
    });
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops without deleting a durable session when the accepted run already ended", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("retries abort without deleting a durable session after a gateway error", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:subagent:child",
        runId: "gateway-run",
      },
      timeoutMs: 60_000,
    });
  });

  it("stops accepted-run cleanup when its Gateway request owner is retired", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("Gateway request owner is retired"))
      .mockResolvedValue({ aborted: false, runIds: [] });

    await withPluginRuntimeGatewayRequestScope(
      { resolveGatewayContext: () => undefined, isWebchatConnect: () => false },
      () =>
        terminateAcceptedCollectorRun({
          childSessionKey: "agent:main:subagent:child",
          gatewayRunId: "gateway-run",
          sessionCleanup: "preserve",
          callGateway,
        }),
    );

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
