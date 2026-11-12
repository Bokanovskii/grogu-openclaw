import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOperatorProfile, runNative } from "../../grogu/operator.js";
import { bootstrapGroguPlugins } from "../../grogu/plugins.js";
import { createGroguRuntimeFixture } from "../../src/agents/grogu-runtime.test-support.js";
import { createInstalledPluginIndex } from "../../src/plugins/test-helpers/installed-plugin-index.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
});

function operatorFixture(gatewayUrl = "ws://127.0.0.1:18789", gatewayPort = 18789) {
  const fixture = createGroguRuntimeFixture();
  fixtures.push(fixture);
  const cli = path.join(fixture.directory, "native-fixture.mjs");
  fs.writeFileSync(
    cli,
    `console.log(JSON.stringify({
    state: process.env.OPENCLAW_STATE_DIR,
    config: process.env.OPENCLAW_CONFIG_PATH,
    oauth: process.env.OPENCLAW_OAUTH_DIR,
    gateway: process.env.OPENCLAW_GATEWAY_URL
  }));`,
  );
  const operator = {
    runtime: { node: process.execPath, cli },
    stateDir: path.join(fixture.directory, "state"),
    configFile: path.join(fixture.directory, "config.json"),
    oauthDir: path.join(fixture.directory, "credentials"),
    recoveryDir: path.join(fixture.directory, "recovery"),
    releasesDir: path.join(fixture.directory, "releases"),
    gatewayPort,
    gatewayUrl,
  };
  fs.writeFileSync(fixture.profileFile, JSON.stringify({ ...fixture.profile, operator }));
  return { fixture, operator };
}

function pluginSetupFixture() {
  const { fixture, operator } = operatorFixture();
  const stateFile = path.join(fixture.directory, "native-plugins.json");
  fs.writeFileSync(stateFile, JSON.stringify({ plugins: {}, installs: [], diagnostics: [] }));
  fs.writeFileSync(
    operator.runtime.cli,
    `
import fs from "node:fs";
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args[0] !== "plugins") throw new Error("Unexpected native command");
if (args[1] === "list") {
  console.log(JSON.stringify({ plugins: Object.keys(state.plugins).map(id => ({ id })), diagnostics: state.diagnostics }));
} else if (args[1] === "info") {
  const id = args[2];
  const entry = state.plugins[id];
  console.log(JSON.stringify({
    plugin: {
      id, packageName: entry.name, packageVersion: entry.version, status: entry.status ?? "loaded",
      dependencyStatus: { requiredInstalled: entry.dependencies },
    },
    install: {
      source: entry.source, spec: entry.spec, version: entry.version,
      ...(entry.source === "npm" ? { resolvedName: entry.name, resolvedSpec: entry.name + "@" + entry.version } : { clawhubPackage: entry.name }),
    },
  }));
} else if (args[1] === "install") {
  const spec = args[2];
  const source = spec.slice(0, spec.indexOf(":"));
  const target = spec.slice(spec.indexOf(":") + 1);
  const at = target.lastIndexOf("@");
  const name = target.slice(0, at);
  const version = target.slice(at + 1);
  const id = name.slice(name.lastIndexOf("/") + 1);
  if (state.plugins[id] && !args.includes("--force")) {
    console.error("Plugin already installed");
    process.exit(1);
  }
  if (id === "openclaw-icloud-calendar" && !args.includes("--accept-capabilities")) {
    console.error("Capability consent is required");
    process.exit(1);
  }
  state.plugins[id] = {
    source, name, version, dependencies: true,
    spec: source === "npm" ? (args.includes("--pin") ? target : name) : spec,
  };
  state.installs.push({ id, force: args.includes("--force"), preservesPolicy: args.includes("--no-enable") });
  save();
  console.log("Installed " + id);
} else {
  throw new Error("Unexpected native plugin command");
}
`,
  );
  return {
    profile: loadOperatorProfile(fixture.profileFile),
    read: (): {
      plugins: Record<
        string,
        {
          source: string;
          name: string;
          version: string;
          spec: string;
          dependencies: boolean;
          status?: string;
        }
      >;
      installs: Array<{ id: string; force: boolean; preservesPolicy: boolean }>;
      diagnostics: Array<{ level: string; pluginId: string }>;
    } => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    write: (state: unknown) => fs.writeFileSync(stateFile, JSON.stringify(state)),
  };
}

describe("native maintenance target selection", () => {
  it("pins every native profile path instead of inheriting another profile's config or credentials", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/different/state");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/different/config.json");
    vi.stubEnv("OPENCLAW_OAUTH_DIR", "/different/credentials");
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:1");
    const { fixture, operator } = operatorFixture();
    expect(
      await runNative(loadOperatorProfile(fixture.profileFile), ["status"], fixture.directory),
    ).toEqual({
      state: operator.stateDir,
      config: operator.configFile,
      oauth: operator.oauthDir,
      gateway: operator.gatewayUrl,
    });
  });

  it("rejects contradictory Gateway identities before launching a native operation", () => {
    const { fixture } = operatorFixture("ws://127.0.0.1:1");
    expect(() => loadOperatorProfile(fixture.profileFile)).toThrow(/port must agree/);
  });

  it("rejects non-canonical loopback hosts and URL paths that --port cannot select", () => {
    for (const gatewayUrl of [
      "ws://localhost:18789",
      "ws://[::1]:18789",
      "ws://127.0.0.1:18789/openclaw",
      "ws://127.0.0.1:18789?target=other",
      "ws://127.0.0.1:18789/",
    ]) {
      const { fixture } = operatorFixture(gatewayUrl);
      expect(() => loadOperatorProfile(fixture.profileFile)).toThrow();
    }
  });

  it("preserves explicit canonical ports even when URL parsing treats them as defaults", () => {
    const { fixture } = operatorFixture("ws://127.0.0.1:80", 80);
    expect(loadOperatorProfile(fixture.profileFile).gatewayUrl).toBe("ws://127.0.0.1:80");
  });
});

describe("Grogu plugin setup", () => {
  it("previews, resumes after native consent is required, and does not reinstall ready plugins", async () => {
    const setup = pluginSetupFixture();
    const preview = await bootstrapGroguPlugins(setup.profile, {
      apply: false,
      acceptCapabilities: false,
    });
    expect(preview.applied).toBe(false);
    expect(preview.plugins.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(["acpx", "openclaw-icloud-calendar"]),
    );
    expect(preview.plugins).toHaveLength(5);
    expect(preview.plugins.some((plugin) => plugin.id === "grogu-local-voice")).toBe(false);
    expect(setup.read().installs).toEqual([]);

    await expect(
      bootstrapGroguPlugins(setup.profile, { apply: true, acceptCapabilities: false }),
    ).rejects.toThrow(/Native plugins install failed; private receipt:/);
    expect(setup.read().plugins["openclaw-icloud-calendar"]).toBeUndefined();
    expect(setup.read().installs).toHaveLength(4);

    const applied = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(applied.applied).toBe(true);
    const installed = setup.read();
    expect(installed.plugins["openclaw-icloud-calendar"]).toMatchObject({
      source: "clawhub",
      dependencies: true,
    });
    expect(installed.plugins.acpx).toMatchObject({ source: "npm", dependencies: true });

    const repeated = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(repeated.plugins.every((plugin) => plugin.action === "ready")).toBe(true);
    expect(setup.read().installs).toEqual(installed.installs);
  });

  it("refuses a conflicting source before repairing missing dependencies", async () => {
    const setup = pluginSetupFixture();
    await bootstrapGroguPlugins(setup.profile, { apply: true, acceptCapabilities: true });
    const state = setup.read();
    const acpx = state.plugins.acpx;
    const copilot = state.plugins.copilot;
    const lobster = state.plugins.lobster;
    if (!acpx || !copilot || !lobster) {
      throw new Error("The fixture did not install the expected plugins.");
    }
    acpx.dependencies = false;
    copilot.source = "path";
    setup.write(state);

    const conflict = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(conflict.applied).toBe(false);
    expect(conflict.plugins).toContainEqual(
      expect.objectContaining({ id: "copilot", action: "conflict" }),
    );
    expect(setup.read()).toEqual(state);

    copilot.source = "npm";
    copilot.spec = copilot.name;
    lobster.spec = `clawhub:${lobster.name}`;
    setup.write(state);
    const repaired = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(repaired.applied).toBe(true);
    expect(setup.read().plugins.acpx?.dependencies).toBe(true);
    expect(setup.read().installs.slice(state.installs.length)).toEqual([
      { id: "acpx", force: true, preservesPolicy: true },
      { id: "copilot", force: true, preservesPolicy: true },
      { id: "lobster", force: true, preservesPolicy: true },
    ]);
    expect(setup.read().plugins.copilot?.spec).toBe("@openclaw/copilot@2026.10.7");
    expect(setup.read().plugins.lobster?.spec).toBe("clawhub:@openclaw/lobster@2026.10.7");
  });

  it("stops on unresolved native plugin errors before installing anything", async () => {
    const setup = pluginSetupFixture();
    await bootstrapGroguPlugins(setup.profile, { apply: true, acceptCapabilities: true });
    const state = setup.read();
    if (!state.plugins.acpx) {
      throw new Error("The fixture did not install the expected plugin.");
    }
    state.plugins.acpx.status = "error";
    delete state.plugins.copilot;
    state.diagnostics.push({ level: "error", pluginId: "copilot" });
    setup.write(state);

    const result = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(result.applied).toBe(false);
    expect(result.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acpx", action: "conflict" }),
        expect.objectContaining({ id: "copilot", action: "conflict" }),
      ]),
    );
    expect(setup.read()).toEqual(state);
  });

  it("repairs only missing packages with a matching recorded source and version", async () => {
    const setup = pluginSetupFixture();
    const copilot = {
      source: "npm",
      spec: "@openclaw/copilot",
      version: "2026.10.7",
      resolvedName: "@openclaw/copilot",
      resolvedVersion: "2026.10.7",
      resolvedSpec: "@openclaw/copilot@2026.10.7",
    } as const;
    const databasePath = path.join(setup.profile.stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    const writeIndex = (index: Parameters<typeof createInstalledPluginIndex>[0]) => {
      database
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(
          "plugins.installedIndex",
          JSON.stringify({ revision: 1, index: createInstalledPluginIndex(index) }),
          Date.now(),
        );
    };
    try {
      writeIndex({
        plugins: [],
        installRecords: {
          copilot,
          diffs: { source: "path", sourcePath: path.join(setup.profile.stateDir, "missing-diffs") },
        },
      });
      const conflict = await bootstrapGroguPlugins(setup.profile, {
        apply: true,
        acceptCapabilities: true,
      });
      expect(conflict.applied).toBe(false);
      expect(conflict.plugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "copilot", action: "repair" }),
          expect.objectContaining({ id: "diffs", action: "conflict" }),
        ]),
      );
      expect(setup.read().installs).toEqual([]);

      writeIndex({
        plugins: [],
        installRecords: {
          copilot,
        },
      });
    } finally {
      database.close();
    }

    const repaired = await bootstrapGroguPlugins(setup.profile, {
      apply: true,
      acceptCapabilities: true,
    });
    expect(repaired.applied).toBe(true);
    expect(setup.read().installs).toContainEqual({
      id: "copilot",
      force: true,
      preservesPolicy: true,
    });
  });
});
