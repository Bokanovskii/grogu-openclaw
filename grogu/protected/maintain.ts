import path from "node:path";
import { withFileLock } from "../../src/infra/file-lock.js";
import { root } from "../../src/infra/fs-safe.js";
import { writeJsonAtomic } from "../../src/infra/json-files.js";
import { measureStorageLimits } from "./capacity.js";
import {
  parseDeploySettings,
  parseRuntimeSettings,
  protectedOpenClawConfig,
  readSettingsJson,
  sparkyRef,
  subjectPattern,
  testClientIdPattern,
} from "./settings.js";

async function main() {
  const [action, arg, ...rest] = process.argv.slice(2);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const home = process.env.HOME;
  if (
    !home ||
    !path.isAbsolute(home) ||
    stateDir !== path.join(home, "state") ||
    configPath !== path.join(home, "config", "openclaw.json") ||
    process.getuid?.() === 0
  ) {
    throw new Error("Maintenance requires the isolated service account and environment.");
  }
  const configDir = path.dirname(configPath);
  const runtimePath = path.join(configDir, "protected.json");
  if (
    action === "init" &&
    arg === "--deploy-json" &&
    rest.length === 1 &&
    path.isAbsolute(rest[0]!)
  ) {
    const deploy = parseDeploySettings(await readSettingsJson(rest[0]!));
    const storageLimits = measureStorageLimits(stateDir);
    const configRoot = await root(configDir);
    // Install each file once; never silently replace an existing allowlist.
    const config = protectedOpenClawConfig(stateDir);
    const provider = config.models?.providers?.sparky;
    if (!provider) {
      throw new Error("Missing isolated Sparky configuration.");
    }
    provider.apiKey = sparkyRef;
    await configRoot.create("openclaw.json", `${JSON.stringify(config, null, 2)}\n`, {
      private: true,
      atomic: true,
    });
    await configRoot.create(
      "protected.json",
      `${JSON.stringify(
        {
          ...deploy,
          stateDir,
          allowedSubjects: [],
          sparkySecret: sparkyRef,
          storageLimits,
        },
        null,
        2,
      )}\n`,
      { private: true, atomic: true },
    );
    process.stdout.write("Initialized Family config with no admitted subjects.\n");
    return;
  }
  const updateSettings = (
    change: (settings: ReturnType<typeof parseRuntimeSettings>) => object | undefined,
  ) =>
    withFileLock(
      runtimePath,
      {
        retries: { retries: 5, factor: 2, minTimeout: 25, maxTimeout: 300 },
        stale: 10_000,
        staleRecovery: "remove-if-definitely-stale",
      },
      async () => {
        const settings = parseRuntimeSettings(await readSettingsJson(runtimePath));
        if (settings.stateDir !== stateDir) {
          throw new Error("Family config state directory mismatch.");
        }
        const next = change(settings);
        if (next) {
          await writeJsonAtomic(runtimePath, next, { mode: 0o600, durable: true });
        }
      },
    );
  if (action === "add-subject" && arg && subjectPattern.test(arg) && rest.length === 0) {
    const subject = arg.toLowerCase();
    await updateSettings((settings) =>
      settings.allowedSubjects.includes(subject)
        ? undefined
        : { ...settings, allowedSubjects: [...settings.allowedSubjects, subject] },
    );
    process.stdout.write("Family allowlist updated.\n");
    return;
  }
  if (
    action === "test-client" &&
    arg &&
    (arg === "none" || testClientIdPattern.test(arg)) &&
    rest.length === 0
  ) {
    await updateSettings(({ testClientId: _previous, ...settings }) =>
      arg === "none" ? settings : { ...settings, testClientId: arg },
    );
    process.stdout.write("Family test client updated.\n");
    return;
  }
  if (action !== "revoke-profile" || !arg || !/^[a-zA-Z0-9_-]{1,128}$/u.test(arg) || rest.length) {
    throw new Error(
      "Supported commands: init --deploy-json FILE, add-subject UUID, test-client CLIENT_ID|none, revoke-profile PROFILE_ID.",
    );
  }
  const { updateCanonicalUserProfileAccess } =
    await import("../../src/state/user-profile-access.js");
  const changed = await updateCanonicalUserProfileAccess(
    { action: "revoke", profileId: arg },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
  if (!changed) {
    throw new Error("No matching active Family profile");
  }
  process.stdout.write("Family profile revoked.\n");
}

void main().catch(() => {
  process.stderr.write(
    "Family maintenance failed. Check the isolated account, config, and command arguments.\n",
  );
  process.exitCode = 1;
});
