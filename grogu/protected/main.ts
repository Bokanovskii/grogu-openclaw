import path from "node:path";
import { fileURLToPath } from "node:url";
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
  const { createProviderRelay } = await import("./provider-relay.js");
  const { resolveSecretRefString } = await import("../../src/secrets/resolve.js");
  const { createCanonicalProtectedTurns } = await import("./turns.js");
  const { createCloudflareAccessVerifier } = await import("./identity.js");
  const { createProtectedHttp } = await import("./http.js");
  const { closeProtectedServer, createProtectedServer } = await import("./server.js");
  const allowed = new Set(allowedSubjects);
  const verifyIdentity = createCloudflareAccessVerifier({
    issuer: accessIssuer,
    audience: accessAudience,
    isAllowed: ({ subject }) => allowed.has(subject),
    testClientId: settings.testClientId,
    origin,
  });
  const app = createProtectedHttp({
    origin,
    stateDir,
    usersRoot,
    maxChatsPerUser: 100,
    maxFileBytes: 2 * 1024 * 1024,
    storageLimits: settings.storageLimits,
    verifyIdentity,
    answerAccessProof: verifyIdentity.answerProof,
    providerRelay: createProviderRelay(),
    turns: createCanonicalProtectedTurns({
      config,
      workspaceDir,
      agentDir,
      models: [sparky, anthropic, copilot, openai],
      resolveSparkyKey: () => resolveSecretRefString(sparkySecret, { config }),
    }),
  });
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
    void closeProtectedServer(server, app, stateDir)
      .then(() => process.exit(0))
      .catch(() => {
        process.stderr.write("Protected listener could not settle cleanly.\n");
        process.exit(1);
      })
      .finally(() => clearTimeout(deadline));
  });
  server.listen(port, "127.0.0.1");
}

void main().catch(() => {
  process.stderr.write(
    "Protected runtime initialization failed. Check isolated runtime configuration.\n",
  );
  process.exitCode = 1;
});
