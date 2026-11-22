import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SecretRef } from "../../src/config/types.secrets.js";
import type { StorageLimits } from "./capacity.js";
import type { ProtectedModel } from "./turns.js";

export const sparky: ProtectedModel = {
  provider: "sparky",
  id: "qwen3.8-flash-next",
  label: "Sparky",
  contextWindow: 128_000,
};
export const sparkyRef = {
  source: "env",
  provider: "default",
  id: "SPARKY_API_KEY",
} satisfies SecretRef;
export const subjectPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export const testClientIdPattern = /^[a-f0-9]{32}\.access$/u;
// Sparky streams long reasoning and large widget calls slowly when it shares its GPU; a two-minute
// budget ended ordinary travel replies. Stop and identity revalidation still end a turn early.
export const protectedTurnTimeoutMs = 15 * 60_000;

export async function readSettingsJson(filename: string): Promise<unknown> {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || (info.mode & 0o022) !== 0) {
    throw new Error("Unsafe runtime configuration file");
  }
  return JSON.parse(await readFile(filename, "utf8")) as unknown;
}

export function parseDeploySettings(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid protected deployment settings");
  }
  const { origin, accessIssuer, accessAudience, port } = value;
  const issuer = typeof accessIssuer === "string" ? URL.parse(accessIssuer) : null;
  if (
    origin !== "https://chat.bokanovski.com" ||
    port !== 19789 ||
    typeof accessIssuer !== "string" ||
    issuer?.protocol !== "https:" ||
    issuer.origin !== accessIssuer ||
    !issuer.hostname.endsWith(".cloudflareaccess.com") ||
    typeof accessAudience !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(accessAudience)
  ) {
    throw new Error("Invalid protected deployment settings");
  }
  return { origin, accessIssuer, accessAudience, port };
}

export function parseRuntimeSettings(value: unknown) {
  const deploy = parseDeploySettings(value);
  if (!isRecord(value)) {
    throw new Error("Invalid protected runtime settings");
  }
  const { stateDir, allowedSubjects, sparkySecret, ownerSubject } = value;
  const testClientId =
    value.testClientId === undefined ||
    (typeof value.testClientId === "string" && testClientIdPattern.test(value.testClientId))
      ? value.testClientId
      : null;
  const limits = value.storageLimits;
  const positive = (number: unknown): number is number =>
    typeof number === "number" && Number.isSafeInteger(number) && number > 0;
  if (
    typeof stateDir !== "string" ||
    !path.isAbsolute(stateDir) ||
    (ownerSubject !== undefined &&
      (typeof ownerSubject !== "string" || !subjectPattern.test(ownerSubject))) ||
    !Array.isArray(allowedSubjects) ||
    !allowedSubjects.every(
      (subject): subject is string => typeof subject === "string" && subjectPattern.test(subject),
    ) ||
    testClientId === null ||
    !isRecord(sparkySecret) ||
    sparkySecret.source !== sparkyRef.source ||
    sparkySecret.provider !== sparkyRef.provider ||
    sparkySecret.id !== sparkyRef.id ||
    !isRecord(limits) ||
    !positive(limits.userBytes) ||
    !positive(limits.globalBytes) ||
    limits.userBytes > limits.globalBytes ||
    !positive(limits.freeFloorBytes)
  ) {
    throw new Error("Invalid protected runtime settings");
  }
  return {
    ...deploy,
    stateDir,
    allowedSubjects,
    ...(ownerSubject === undefined ? {} : { ownerSubject }),
    ...(testClientId === undefined ? {} : { testClientId }),
    sparkySecret: sparkyRef,
    storageLimits: {
      userBytes: limits.userBytes,
      globalBytes: limits.globalBytes,
      freeFloorBytes: limits.freeFloorBytes,
    } satisfies StorageLimits,
  };
}

export function protectedOpenClawConfig(stateDir: string, serviceRoot: string): OpenClawConfig {
  return {
    // Keyless public search only; the plugin is shipped as source because it has no bundled dist.
    // The provider cache is process-wide, so a hit would reveal another member's identical query.
    tools: { web: { search: { enabled: true, provider: "duckduckgo", cacheTtlMinutes: 0 } } },
    agents: {
      ownership: "explicit",
      entries: {
        protected: {
          workspace: path.join(stateDir, "workspace"),
          agentDir: path.join(stateDir, "agents", "protected", "agent"),
          memory: { search: { enabled: false } },
        },
      },
    },
    plugins: {
      allow: ["anthropic", "duckduckgo", "github-copilot", "openai"],
      load: { paths: [path.join(serviceRoot, "extensions", "duckduckgo")] },
      entries: {
        anthropic: { enabled: true },
        duckduckgo: { enabled: true },
        "github-copilot": { enabled: true },
        openai: { enabled: true },
      },
      slots: { memory: "none" },
    },
    models: {
      mode: "replace",
      providers: {
        sparky: {
          baseUrl: "https://agents.ratnakaram.com/v1",
          api: "openai-completions",
          models: [
            {
              id: sparky.id,
              name: sparky.label,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  };
}
