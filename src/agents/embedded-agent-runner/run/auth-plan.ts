import type { ProviderModelRouteSource } from "../../../plugin-sdk/provider-model-types.js";
import {
  providerOwnsDynamicModelPreparation,
  resolveProviderAuthProfileId,
} from "../../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../../auth-profiles/external-cli-auth-selection.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../../model-auth.js";
import { resolveOpenAIModelRoutes } from "../../openai-model-routes.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { resolveRequestModelCredential } from "../../request-model-credential.js";
import { buildAgentRuntimeAuthPlan } from "../../runtime-plan/auth.js";
import {
  createPreparedRuntimeModelMaterializer,
  providerUsesCredentialScopedModelMetadata,
} from "../../runtime-plan/credential-scoped-model.js";
import { materializePreparedRuntimeModel } from "../../runtime-plan/materialize-model.js";
import {
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../../runtime-plan/prepare-auth.js";
import { resolveModelAsync } from "../model.js";
import type { PreparedNativeSessionRuntime } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;
type RuntimeModel = NonNullable<ModelResolution["model"]>;

export async function prepareEmbeddedRunAuthPlan(params: {
  assertCurrent: () => void;
  runParams: RunEmbeddedAgentParams;
  provider: string;
  /** Selected logical ID returned by the model resolver. */
  modelId: string;
  model: RuntimeModel;
  agentDir: string;
  workspaceDir: string;
  requestStreamTransportOverrides?: "present";
  nativeModelOwned: boolean;
  /** Picker routes for a native-owned model; its placeholder transport is not an observation. */
  observedRoutes?: readonly ProviderModelRouteSource[];
  nativeSessionRuntime?: PreparedNativeSessionRuntime;
  authStorage: ModelResolution["authStorage"];
  modelRegistry: ModelResolution["modelRegistry"];
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  getAgentHarness: () => AgentHarness;
  setAgentHarness: (harness: AgentHarness) => void;
  getRuntimeModel: () => RuntimeModel;
  getEffectiveModel: () => RuntimeModel;
  applyResolvedRuntimeModel: (model: RuntimeModel) => void;
  selectHarnessForPreparedAttempts: (
    model: RuntimeModel,
    attempts: readonly PreparedAgentRuntimeAuthAttempt[],
  ) => AgentHarness;
  markStage?: (stage: string) => void;
}) {
  const runParams = params.runParams;
  if (runParams.requestModelCredential) {
    const auth = resolveRequestModelCredential(
      runParams.requestModelCredential,
      params.provider,
      params.modelId,
    );
    if (
      params.getAgentHarness().id !== "openclaw" ||
      params.nativeSessionRuntime?.auth === "native"
    ) {
      throw new Error("Request credentials require the canonical OpenClaw transport.");
    }
    const subscriptionRoute =
      params.provider === OPENAI_PROVIDER_ID
        ? resolveOpenAIModelRoutes({
            provider: params.provider,
            modelId: params.modelId,
            config: runParams.config,
            agentId: runParams.agentId,
            routeIntent: { source: "explicit", authRequirement: "subscription" },
          })
        : undefined;
    const subscription =
      subscriptionRoute?.kind === "routes"
        ? subscriptionRoute.routes.find((route) => route.authRequirement === "subscription")
        : undefined;
    const modelRoute = subscription && {
      ...subscription,
      provider: params.provider,
      modelId: params.modelId,
    };
    if (params.provider === OPENAI_PROVIDER_ID && !modelRoute) {
      throw new Error("The requested model has no OpenAI subscription route.");
    }
    const plan = buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      authProfileMode: auth.mode,
      modelRoute,
      config: runParams.config,
      metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
      allowHarnessAuthProfileForwarding: false,
    });
    const materialize = async () => {
      params.assertCurrent();
      if (!modelRoute) {
        return params.model;
      }
      const model = await materializePreparedRuntimeModel({
        plan,
        provider: params.provider,
        modelId: params.modelId,
        config: runParams.config,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
        model: params.model,
        resolveModel: ({ config, authProfileMode }) =>
          resolveModelAsync(params.provider, params.modelId, params.agentDir, config, {
            abortSignal: runParams.abortSignal,
            assertCurrent: params.assertCurrent,
            modelIdSource: "selected",
            authStorage: params.authStorage,
            modelRegistry: params.modelRegistry,
            skipAgentDiscovery: true,
            deferProviderDynamicModelPreparation: true,
            allowBundledStaticCatalogFallback: true,
            preparedModelRuntime: params.preparedModelRuntime,
            workspaceDir: params.workspaceDir,
            authProfileMode,
          }),
      });
      params.assertCurrent();
      if (!model) {
        throw new Error("The OpenAI subscription model could not be prepared.");
      }
      return model;
    };
    params.applyResolvedRuntimeModel(await materialize());
    return {
      attemptAuthProfileStore: { version: 1, profiles: {} } satisfies AuthProfileStore,
      lockedProfileId: undefined,
      preferredProfileId: undefined,
      providerUsesProfileScopedModelMetadata: false,
      materializeAuthPlan: materialize,
      materializeAuthPlanUncached: materialize,
      preparedAuthAttempts: [{ kind: "implicit" as const, plan }],
      activePreparedAuthPlan: plan,
    };
  }
  const usesOpenAIAuthRouting = params.provider === OPENAI_PROVIDER_ID;
  const initialHarness = params.getAgentHarness();
  const initialPluginHarnessOwnsTransport = initialHarness.id !== "openclaw";
  const openClawNativeCodexResponsesNeedsAuthBootstrap =
    !initialPluginHarnessOwnsTransport &&
    usesOpenAIAuthRouting &&
    params.getEffectiveModel().api === "openai-chatgpt-responses";
  const resolveExternalCliAuthScope = (store?: AuthProfileStore) =>
    resolveExternalCliAuthOverlayScopeFromSelection({
      ...params,
      cfg: runParams.config,
      agentId: runParams.agentId,
      ...(store ? { store } : {}),
      userPinnedAuthProfileId:
        runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
    });
  let externalCliAuthScope = initialPluginHarnessOwnsTransport
    ? { ignoreAutoPreferredProfile: false }
    : openClawNativeCodexResponsesNeedsAuthBootstrap
      ? {
          providerIds: [OPENAI_PROVIDER_ID],
          ignoreAutoPreferredProfile: false,
        }
      : resolveExternalCliAuthScope();
  const authStoreOptions = {
    migrationProvider: params.provider,
    config: runParams.config,
    profileId: runParams.authProfileId,
    allowKeychainPrompt: false,
  };
  let noExternalAuthStore: AuthProfileStore | undefined;
  if (!initialPluginHarnessOwnsTransport && !externalCliAuthScope.providerIds) {
    noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(
      params.agentDir,
      authStoreOptions,
    );
    externalCliAuthScope = resolveExternalCliAuthScope(noExternalAuthStore);
  }
  params.markStage?.("scope");

  // Provider pins own ambient overlays at this loader seam. Stored profiles
  // and explicit bindings remain available for the cross-class auth contracts.
  const externalCliProviderIds = usesOpenAIAuthRouting
    ? [OPENAI_PROVIDER_ID]
    : initialPluginHarnessOwnsTransport
      ? undefined
      : externalCliAuthScope.providerIds;
  const attemptAuthProfileStore = externalCliProviderIds
    ? ensureAuthProfileStore(params.agentDir, { ...authStoreOptions, externalCliProviderIds })
    : (noExternalAuthStore ??
      ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, authStoreOptions));
  params.markStage?.("store");

  const requestedProfileId = runParams.authProfileId?.trim() || undefined;
  const lockedProfileId = runParams.authProfileIdSource === "user" ? requestedProfileId : undefined;
  const preferredProfileId =
    externalCliAuthScope.ignoreAutoPreferredProfile && !lockedProfileId
      ? undefined
      : requestedProfileId;
  const createAuthPreparation = (): PreparedAgentRuntimeAuth => {
    const harness = params.getAgentHarness();
    if (params.nativeSessionRuntime?.auth === "native") {
      // Only the binding-owned connection bypasses host credentials and routes;
      // preserving a native model alone still uses the normal auth planner below.
      const plan = buildAgentRuntimeAuthPlan({
        provider: params.provider,
        modelId: params.modelId,
        harnessId: harness.id,
        allowHarnessAuthProfileForwarding: false,
        metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
        config: runParams.config,
        workspaceDir: params.workspaceDir,
      });
      return { plan, attempts: [{ kind: "implicit", plan }] };
    }
    return prepareAgentRuntimeAuth({
      provider: params.provider,
      modelId: params.modelId,
      ...(params.observedRoutes
        ? { observedRoutes: params.observedRoutes }
        : { modelApi: params.model.api, modelBaseUrl: params.model.baseUrl }),
      requestTransportOverrides: params.requestStreamTransportOverrides,
      config: runParams.config,
      env: process.env,
      agentId: runParams.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
      authProfileStore: attemptAuthProfileStore,
      sessionAuthProfileId: preferredProfileId,
      sessionAuthProfileSource: runParams.authProfileIdSource,
      allowAuthProfileFallback: runParams.allowAuthProfileFallback,
      harnessId: harness.id,
      harnessRuntime: harness.id,
      harnessAuthBootstrap: harness.authBootstrap,
      allowHarnessAuthProfileForwarding: true,
      allowTransientCooldownProbe: runParams.allowTransientCooldownProbe === true,
      resolveProviderPreferredProfileId: (context) =>
        resolveProviderAuthProfileId({
          provider: params.provider,
          config: runParams.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
          context,
        }),
    });
  };
  const providerUsesProfileScopedModelMetadata = providerUsesCredentialScopedModelMetadata({
    ...params,
    config: runParams.config,
  });
  const providerOwnsDynamicModelRefresh = providerOwnsDynamicModelPreparation({
    provider: params.provider,
    config: runParams.config,
    workspaceDir: params.workspaceDir,
  });
  const { materialize: materializeAuthPlan, materializeUncached: materializeAuthPlanUncached } =
    createPreparedRuntimeModelMaterializer({
      ...params,
      config: runParams.config,
      metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
      getModel: params.getRuntimeModel,
      requestedProfileId: runParams.authProfileId,
      providerUsesProfileScopedModelMetadata,
      providerOwnsDynamicModelRefresh,
      generationRouteModelMemo: params.preparedModelRuntime?.routeModelResolutionMemo,
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, params.agentDir, config, {
          abortSignal: runParams.abortSignal,
          assertCurrent: params.assertCurrent,
          modelIdSource: "selected",
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preparedModelRuntime: params.preparedModelRuntime,
          workspaceDir: params.workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    });

  let resolvedAuthPreparation = createAuthPreparation();
  for (let preparation = 0; ; preparation += 1) {
    params.applyResolvedRuntimeModel(await materializeAuthPlan(resolvedAuthPreparation.plan));
    if (preparation === 0) {
      params.markStage?.("prepare-plan");
    }
    const selectedHarness = params.selectHarnessForPreparedAttempts(
      params.getEffectiveModel(),
      resolvedAuthPreparation.attempts,
    );
    if (selectedHarness.id === params.getAgentHarness().id) {
      break;
    }
    if (preparation > 0) {
      throw new Error(
        `Prepared auth route did not converge on one agent harness for ${params.provider}/${params.modelId}.`,
      );
    }
    params.setAgentHarness(selectedHarness);
    resolvedAuthPreparation = createAuthPreparation();
  }
  params.markStage?.("harness");

  return {
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    providerUsesProfileScopedModelMetadata,
    materializeAuthPlan,
    materializeAuthPlanUncached,
    preparedAuthAttempts: resolvedAuthPreparation.attempts,
    activePreparedAuthPlan: resolvedAuthPreparation.plan,
  };
}
