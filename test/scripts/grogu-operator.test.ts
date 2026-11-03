import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOperatorProfile, runNative } from "../../grogu/operator.js";
import { createGroguRuntimeFixture } from "../../src/agents/grogu-runtime.test-support.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
afterEach(() => {
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
