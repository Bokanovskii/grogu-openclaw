import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateAuthorizedUserFiles,
  verifyAuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { protectedResearchAgent } from "./agents.js";
import { createProtectedBrowserBroker } from "./browser/broker.js";
import { publicError } from "./errors.js";
import { configureProtectedRuntimeWorkers, ProtectedWorkerBuildError } from "./runtime-workers.js";
import {
  parseRuntimeSettings,
  protectedMaxFileBytes,
  protectedOpenClawConfig,
  readSettingsJson,
  sparky,
} from "./settings.js";
import { describeStartupFailure } from "./startup-failure.js";
import {
  requireProtectedStorageEncryption,
  resolveProtectedStorageKeyFile,
} from "./storage-key.js";
import type { ProtectedModel } from "./turns.js";

const anthropic: ProtectedModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  label: "Claude Sonnet 4.6",
};
const copilot: ProtectedModel = {
  provider: "github-copilot",
  id: "gpt-5.3-codex",
  label: "GitHub Copilot",
};
const openai: ProtectedModel = { provider: "openai", id: "gpt-5.6-luna", label: "ChatGPT" };

let releaseStateOwner = () => {};

class ProtectedStartupError extends Error {}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error("Missing absolute runtime configuration path");
  }
  const settings = parseRuntimeSettings(await readSettingsJson(configPath));
  const { stateDir, origin, accessIssuer, accessAudience, allowedSubjects, port, sparkySecret } =
    settings;
  const configFile = path.join(path.dirname(configPath), "openclaw.json");
  if (
    process.env.OPENCLAW_STATE_DIR !== stateDir ||
    process.env.OPENCLAW_CONFIG_PATH !== configFile ||
    process.getuid?.() === 0
  ) {
    throw new Error("Protected runtime requires isolated process state and an unprivileged user");
  }
  const serviceRoot = fileURLToPath(new URL("../..", import.meta.url));
  if (!existsSync(path.join(serviceRoot, "extensions", "duckduckgo", "openclaw.plugin.json"))) {
    throw new ProtectedStartupError(
      "The runtime archive is missing extensions/duckduckgo, which web search needs. Repackage it.",
    );
  }
  if (
    !existsSync(path.join(serviceRoot, "extensions", "memory-core", "openclaw.plugin.json")) ||
    !existsSync(
      path.join(
        serviceRoot,
        "extensions",
        "memory-core",
        "src",
        "memory",
        "manager-ephemeral.worker.ts",
      ),
    )
  ) {
    throw new ProtectedStartupError(
      "The runtime archive is missing Memory Core or its member memory worker. Repackage it.",
    );
  }
  resolveProtectedStorageKeyFile();
  await configureProtectedRuntimeWorkers(serviceRoot);
  const { acquireProtectedStateOwner } = await import("./state-owner.js");
  const stateOwner = await acquireProtectedStateOwner(stateDir);
  if (!stateOwner) {
    throw new ProtectedStartupError(
      "Another process owns the service state. Stop it before starting.",
    );
  }
  releaseStateOwner = () => stateOwner.release();
  const { root } = await import("../../src/infra/fs-safe.js");
  const { createProtectedStaticClient } = await import("./static-client.js");
  const bundleDir = fileURLToPath(new URL("../../protected-client/", import.meta.url));
  const staticClient = await createProtectedStaticClient(
    await root(bundleDir, { symlinks: "reject" }),
  );
  const stateRoot = await root(stateDir);
  await stateRoot.mkdir("users", { private: true });
  await stateRoot.mkdir("workspace", { private: true });
  const usersRoot = await root(path.join(stateRoot.rootReal, "users"));
  const storageEncryption = requireProtectedStorageEncryption();
  try {
    await verifyAuthorizedUserFiles({
      usersRoot,
      assertCurrent: () => stateOwner.assertCurrent(),
      maxBytes: protectedMaxFileBytes,
      encryption: storageEncryption,
    });
    const { prepareProtectedSharedState } = await import("./state-worker-context.js");
    await prepareProtectedSharedState(stateDir, () => stateOwner.assertCurrent());
    const { admitProtectedPhysicalAgentStorage } = await import("./agent-storage.js");
    admitProtectedPhysicalAgentStorage(() => stateOwner.assertCurrent());
    await migrateAuthorizedUserFiles({
      usersRoot,
      assertCurrent: () => stateOwner.assertCurrent(),
      maxBytes: protectedMaxFileBytes,
      encryption: storageEncryption,
    });
  } finally {
    storageEncryption.dispose();
  }
  const workspaceDir = path.join(stateRoot.rootReal, "workspace");
  const agentDir = path.join(stateRoot.rootReal, "agents", "protected", "agent");
  const config = protectedOpenClawConfig(stateRoot.rootReal, serviceRoot);
  const { publishConfiguredModelRuntimeSnapshots } =
    await import("../../src/gateway/server-startup-model-runtime.js");
  await publishConfiguredModelRuntimeSnapshots({
    cfg: config,
    isCurrent: () => {
      stateOwner.assertCurrent();
      return true;
    },
    workspaceDir,
  });
  const { createProviderRelay } = await import("./provider-relay.js");
  const { resolveSecretRefString } = await import("../../src/secrets/resolve.js");
  const { createCanonicalProtectedTurns } = await import("./turns.js");
  const { withThinking } = await import("./models.js");
  const { resolveBundledProviderStaticCatalogModel } =
    await import("../../src/agents/embedded-agent-runner/model.static-catalog.js");
  const { createCloudflareAccessVerifier, protectedTestClientSubject } =
    await import("./identity.js");
  const { createProtectedHttp } = await import("./http.js");
  const { createProtectedMemberMemory } = await import("./member-memory.js");
  const { createProtectedMemoryReview } = await import("./memory-review.js");
  const { closeProtectedServer, createProtectedServer } = await import("./server.js");
  const admissionStore = await import("./admission-store.js");
  const { startProtectedUsageRetention } = await import("./usage-retention.js");
  const { createProtectedPolicySync } = await import("./policy-sync.js");
  await admissionStore.migrateProtectedSubjects(stateDir, {
    subjects: allowedSubjects,
    issuer: accessIssuer,
  });
  // Membership features (automations, storage limits, run admission) read admission rows; the test
  // client bypasses Access policy but still needs one. An owner removal stays in force.
  if (
    settings.testClientId &&
    (await admissionStore.addProtectedSubject(stateDir, {
      issuer: accessIssuer,
      subject: protectedTestClientSubject(settings.testClientId),
    })) === "removed"
  ) {
    process.stderr.write(
      "Protected test client was removed by the owner; configure a new client ID to test again.\n",
    );
  }
  const admissions = await admissionStore.listProtectedAdmissions(stateDir);
  const allowed = new Set(
    admissions
      .filter((admission) => admission.status === "approved" && admission.subject)
      .map((admission) => admission.subject!),
  );
  const policySync = createProtectedPolicySync(stateDir);
  const verifyIdentity = createCloudflareAccessVerifier({
    issuer: accessIssuer,
    audience: accessAudience,
    isAllowed: ({ subject }) => allowed.has(subject),
    bindVerifiedIdentity: async (identity, assertCurrent) => {
      return admissionStore.bindProtectedAdmission(stateDir, identity, assertCurrent, () => {
        allowed.add(identity.subject);
        policySync.trigger();
      });
    },
    testClientId: settings.testClientId,
    origin,
  });
  const models = await Promise.all(
    [sparky, anthropic, copilot, openai].map(async (model) => {
      if (model.provider === "sparky") {
        return withThinking(model, { ...model, reasoning: true });
      }
      const catalog = await resolveBundledProviderStaticCatalogModel({
        provider: model.provider,
        modelId: model.id,
        cfg: config,
        workspaceDir,
      });
      return withThinking(
        {
          ...model,
          ...(catalog?.contextWindow ? { contextWindow: catalog.contextWindow } : {}),
        },
        catalog,
      );
    }),
  );
  const memberMemory = createProtectedMemberMemory();
  const browser = settings.browser === "fresh" ? createProtectedBrowserBroker() : undefined;
  const app = createProtectedHttp({
    origin,
    stateDir,
    accessIssuer,
    ownerSubject: settings.ownerSubject,
    onRemoveSubject: (subject) => {
      allowed.delete(subject);
      verifyIdentity.invalidateSubject(subject);
    },
    onPolicyChanged: policySync.trigger,
    isPolicyInFlight: policySync.isInFlight,
    getPolicyStatus: policySync.getStatus,
    usersRoot,
    directory: {
      issuer: accessIssuer,
      get allowedSubjects() {
        return [...allowed];
      },
    },
    maxChatsPerUser: 100,
    maxFileBytes: protectedMaxFileBytes,
    storageLimits: settings.storageLimits,
    agentExtensions: [protectedResearchAgent],
    verifyIdentity,
    answerAccessProof: verifyIdentity.answerProof,
    providerRelay: createProviderRelay(),
    memberMemory,
    memoryReview: createProtectedMemoryReview(),
    turns: createCanonicalProtectedTurns({
      config,
      workspaceDir,
      agentDir,
      memberMemory,
      ...(browser ? { browser } : {}),
      models,
      resolveSparkyKey: () => resolveSecretRefString(sparkySecret, { config }),
    }),
  });
  const recovered = await app.recoverTransient(stateOwner.assertCurrent);
  if (recovered.skipped) {
    throw new ProtectedStartupError(
      "Child ownership is ambiguous. Inspect the isolated state before starting.",
    );
  }
  try {
    await app.startAutomations(stateOwner.assertCurrent);
  } catch (error) {
    process.stderr.write(
      `Protected automations could not start (${publicError(error).code}); scheduling is unavailable. Check owner access and protected storage recovery before restarting.\n`,
    );
  }
  const retention = await startProtectedUsageRetention(stateDir);
  policySync.trigger();
  const server = createProtectedServer(origin, app.fetch, staticClient);
  const stopKeyRefresh = verifyIdentity.startKeyRefresh();
  server.on("error", () => {
    process.stderr.write("Protected listener failed.\n");
    process.exitCode = 1;
  });
  process.once("SIGTERM", () => {
    stopKeyRefresh();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 8_000);
    retention.beginClose();
    void closeProtectedServer(
      server,
      {
        shutdown: async () => {
          await Promise.all([
            app.shutdown().finally(() => browser?.shutdown()),
            retention.stop(),
            policySync.stop(),
          ]);
        },
      },
      stateDir,
    )
      .then(() => {
        releaseStateOwner();
        process.exit(0);
      })
      .catch(() => {
        process.stderr.write("Protected listener could not settle cleanly.\n");
        process.exit(1);
      })
      .finally(() => clearTimeout(deadline));
  });
  server.listen(port, "127.0.0.1");
}

void main().catch((error: unknown) => {
  releaseStateOwner();
  const storageFailure =
    error instanceof Error &&
    /Protected storage key|Protected storage encryption|is encrypted but its key is unavailable|could not be opened with the configured storage key|invalid encryption key check/iu.test(
      error.message,
    );
  process.stderr.write(
    storageFailure
      ? "Protected runtime initialization failed. Restore the original storage key or provision it before startup; never replace a lost key.\n"
      : `${error instanceof ProtectedStartupError || error instanceof ProtectedWorkerBuildError ? error.message : "Protected runtime initialization failed. Check isolated runtime configuration."}\n`,
  );
  let detail: string;
  try {
    detail = describeStartupFailure(error);
  } catch {
    detail = "Startup failure details could not be formatted.";
  }
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
