import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "owner@example.com",
};

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function deviceIdentityPath(label: string): string {
  return path.join(tempDirs.make("openclaw-member-role-"), `${label}.sqlite`);
}

function proxyAuth(identityScopes?: GatewayAuthConfig["identityScopes"]): GatewayAuthConfig {
  return {
    mode: "trusted-proxy",
    identityScopes,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
}

function connectIdentity(
  ws: Awaited<ReturnType<typeof openWs>>,
  options: NonNullable<Parameters<typeof connectReq>[1]>,
) {
  return connectReq(ws, {
    prePairDevice: true,
    client: CONTROL_UI_CLIENT,
    browserOrigin: BROWSER_ORIGIN,
    ...options,
  });
}

test("keeps trusted-proxy member sessions private and denies owner and admin capabilities", async () => {
  const roles: GatewayOperatorRolesConfig = {
    default: "denied",
    definitions: {
      denied: { sessions: { others: "none" }, agents: [], scopes: [] },
      owner: {
        sessions: { others: "write" },
        agents: "*",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      },
      member: {
        accessPolicyPlugin: "person-access",
        sessions: { others: "none" },
        agents: ["alcove-member"],
        scopes: ["operator.read", "operator.write"],
        sandbox: "required",
      },
    },
  };
  const auth = proxyAuth({
    "owner@example.com": ["operator.admin", "operator.read", "operator.write"],
  });
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, "alcove-member": {}, "owner-agent": {} },
    },
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      roles,
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });

  const ownerProfile = ensureProfileForEmail("owner@example.com");
  const memberAProfile = ensureProfileForEmail("member-a@example.com");
  const memberBProfile = ensureProfileForEmail("member-b@example.com");
  setUserProfileRole(ownerProfile.id, "owner");
  setUserProfileRole(memberAProfile.id, "member");
  setUserProfileRole(memberBProfile.id, "member");

  const { config, registry } = createPluginRegistryFixture();
  const grants = new Map<string, AbortController>([
    [memberAProfile.id, new AbortController()],
    [memberBProfile.id, new AbortController()],
  ]);
  registerVirtualTestPlugin({
    registry,
    config,
    id: "person-access",
    name: "Person access",
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ profile }) {
          const grant = grants.get(profile.profileId);
          if (!grant) {
            return undefined;
          }
          return {
            signal: grant.signal,
            assertCurrent: () => grant.signal.throwIfAborted(),
          };
        },
      });
    },
  });
  setTestPluginRegistry(registry.registry);

  const memberAKey = "agent:alcove-member:dashboard:member-a";
  const memberBKey = "agent:alcove-member:dashboard:member-b";
  const ownerKey = "agent:owner-agent:dashboard:owner";
  const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
  try {
    await withGatewayServer(async ({ port }) => {
      const connect = async (label: string, email: string, scopes: OperatorScope[]) => {
        const socket = await openWs(port, {
          ...TRUSTED_PROXY_HEADERS,
          "x-forwarded-user": email,
        });
        sockets.push(socket);
        const result = await connectIdentity(socket, {
          skipDefaultAuth: true,
          scopes,
          deviceIdentityPath: deviceIdentityPath(`member-role-${label}`),
        });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        return socket;
      };
      const owner = await connect("owner", "owner@example.com", [
        "operator.admin",
        "operator.read",
        "operator.write",
      ]);
      const memberA = await connect("member-a", "member-a@example.com", [
        "operator.read",
        "operator.write",
      ]);
      const memberB = await connect("member-b", "member-b@example.com", [
        "operator.read",
        "operator.write",
      ]);

      for (const [socket, key, agentId] of [
        [memberA, memberAKey, "alcove-member"],
        [memberB, memberBKey, "alcove-member"],
        [owner, ownerKey, "owner-agent"],
      ] as const) {
        const created = await rpcReq(socket, "sessions.create", { agentId, key });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
      }

      const memberList = await rpcReq<{ sessions: Array<{ key: string }> }>(
        memberA,
        "sessions.list",
        { agentId: "alcove-member" },
      );
      expect(memberList.ok, JSON.stringify(memberList.error)).toBe(true);
      expect(memberList.payload?.sessions.map((session) => session.key)).toContain(memberAKey);
      expect(memberList.payload?.sessions.map((session) => session.key)).not.toContain(memberBKey);

      const ownerList = await rpcReq<{ sessions: Array<{ key: string }> }>(owner, "sessions.list", {
        agentId: "alcove-member",
      });
      expect(ownerList.ok, JSON.stringify(ownerList.error)).toBe(true);
      expect(ownerList.payload?.sessions.map((session) => session.key)).toContain(memberAKey);
      expect(ownerList.payload?.sessions.map((session) => session.key)).toContain(memberBKey);

      await expect(
        rpcReq(memberA, "sessions.describe", { key: memberBKey }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("was not found"),
        },
      });
      await expect(
        rpcReq(memberA, "sessions.steer", {
          key: memberBKey,
          message: "synthetic cross-member steer",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("was not found"),
        },
      });

      await expect(
        rpcReq(memberA, "sessions.create", {
          agentId: "owner-agent",
          key: "agent:owner-agent:dashboard:member-attempt",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("cannot create sessions for agent") },
      });
      await expect(
        rpcReq(memberA, "cron.add", {
          name: "uncapped member job",
          payload: { kind: "agentTurn", message: "synthetic" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("missing scope: operator.admin") },
      });

      grants.get(memberAProfile.id)?.abort(new Error("Member access revoked"));
      expect(await waitForWsClose(memberA, 1_000)).toBe(true);
      expect((await rpcReq(memberB, "status")).ok).toBe(true);
    });
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    resetTestPluginRegistry();
  }
});
