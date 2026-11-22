import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectedResearchAgent } from "./agents.js";
import { configureProtectedRuntimeWorkers, ProtectedWorkerBuildError } from "./runtime-workers.js";
import {
  parseRuntimeSettings,
  protectedOpenClawConfig,
  readSettingsJson,
  sparky,
} from "./settings.js";
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
  await configureProtectedRuntimeWorkers(fileURLToPath(new URL("../..", import.meta.url)));
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
  const workspaceDir = path.join(stateRoot.rootReal, "workspace");
  const agentDir = path.join(stateRoot.rootReal, "agents", "protected", "agent");
  const config = protectedOpenClawConfig(stateRoot.rootReal);
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
  const { createCloudflareAccessVerifier } = await import("./identity.js");
  const { createProtectedHttp } = await import("./http.js");
  const { closeProtectedServer, createProtectedServer } = await import("./server.js");
  const admissionStore = await import("./admission-store.js");
  const { startProtectedUsageRetention } = await import("./usage-retention.js");
  const { createProtectedPolicySync } = await import("./policy-sync.js");
  await admissionStore.migrateProtectedSubjects(stateDir, {
    subjects: allowedSubjects,
    issuer: accessIssuer,
  });
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
    usersRoot,
    directory: {
      issuer: accessIssuer,
      get allowedSubjects() {
        return [...allowed];
      },
    },
    maxChatsPerUser: 100,
    maxFileBytes: 2 * 1024 * 1024,
    storageLimits: settings.storageLimits,
    agentExtensions: [protectedResearchAgent],
    verifyIdentity,
    answerAccessProof: verifyIdentity.answerProof,
    providerRelay: createProviderRelay(),
    turns: createCanonicalProtectedTurns({
      config,
      workspaceDir,
      agentDir,
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
  const retention = await startProtectedUsageRetention(stateDir);
  policySync.trigger();
  const server = createProtectedServer(origin, app.fetch, staticClient);
  server.on("error", () => {
    process.stderr.write("Protected listener failed.\n");
    process.exitCode = 1;
  });
  process.once("SIGTERM", () => {
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 8_000);
    retention.beginClose();
    void closeProtectedServer(
      server,
      {
        shutdown: async () => {
          await Promise.all([app.shutdown(), retention.stop(), policySync.stop()]);
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
  process.stderr.write(
    `${error instanceof ProtectedStartupError || error instanceof ProtectedWorkerBuildError ? error.message : "Protected runtime initialization failed. Check isolated runtime configuration."}\n`,
  );
  process.exitCode = 1;
});
