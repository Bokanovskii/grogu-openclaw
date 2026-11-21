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

class MaintenanceRefused extends Error {}

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
    process.stdout.write("Initialized Alcove config with no admitted subjects.\n");
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
          throw new Error("Alcove config state directory mismatch.");
        }
        const next = change(settings);
        if (next) {
          await writeJsonAtomic(runtimePath, next, { mode: 0o600, durable: true });
        }
      },
    );
  if (action === "add-subject" && arg && subjectPattern.test(arg) && rest.length === 0) {
    const subject = arg.toLowerCase();
    const settings = parseRuntimeSettings(await readSettingsJson(runtimePath));
    if (settings.stateDir !== stateDir) {
      throw new Error("Alcove config state directory mismatch.");
    }
    const { acquireProtectedStateOwner } = await import("./state-owner.js");
    const owner = await acquireProtectedStateOwner(stateDir);
    if (!owner) {
      throw new MaintenanceRefused("Stop the listener before adding a subject.");
    }
    try {
      const { addProtectedSubject } = await import("./admission-store.js");
      owner.assertCurrent();
      const result = await addProtectedSubject(stateDir, {
        issuer: settings.accessIssuer,
        subject,
      });
      if (result === "removed") {
        throw new Error("A removed subject cannot be restored by this command.");
      }
    } finally {
      owner.release();
    }
    process.stdout.write("Alcove admission is recorded; restart the listener to apply it.\n");
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
    process.stdout.write("Alcove test client updated.\n");
    return;
  }
  if (action === "set-owner" && arg && subjectPattern.test(arg) && rest.length === 0) {
    await updateSettings((settings) => ({ ...settings, ownerSubject: arg.toLowerCase() }));
    process.stdout.write("Alcove owner subject updated. Restart the listener.\n");
    return;
  }
  if (action !== "revoke-profile" || !arg || !/^[a-zA-Z0-9_-]{1,128}$/u.test(arg) || rest.length) {
    throw new Error(
      "Supported commands: init --deploy-json FILE, add-subject UUID, set-owner UUID, test-client CLIENT_ID|none, revoke-profile PROFILE_ID.",
    );
  }
  const { acquireProtectedStateOwner } = await import("./state-owner.js");
  const owner = await acquireProtectedStateOwner(stateDir);
  if (!owner) {
    throw new MaintenanceRefused("Stop the listener before revoking a profile.");
  }
  let changed: boolean;
  try {
    const { updateCanonicalUserProfileAccess } =
      await import("../../src/state/user-profile-access.js");
    owner.assertCurrent();
    changed = await updateCanonicalUserProfileAccess(
      { action: "revoke", profileId: arg },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );
  } finally {
    owner.release();
  }
  if (!changed) {
    throw new Error("No matching active Alcove profile");
  }
  process.stdout.write("Alcove profile revoked.\n");
}

void main().catch((error: unknown) => {
  if (error instanceof MaintenanceRefused) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    "Alcove maintenance failed. Check the isolated account, config, and command arguments.\n",
  );
  process.exitCode = 1;
});
