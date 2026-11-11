import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { readGroguPrivateProfileDocument } from "../src/agents/grogu-private-profile.js";
import {
  createPrivateArtifactDirectory,
  runNative,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";

type JsonRecord = Record<string, unknown>;

const compactionBindingSchema = z
  .object({
    agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    pluginDirectory: z.string().min(1).refine(path.isAbsolute, "Expected an absolute plugin path"),
  })
  .strict();

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addUnique(values: string[], additions: string[]): string[] {
  return [...new Set([...values, ...additions])];
}

export function buildGroguCompactionConfig(
  current: unknown,
  binding: z.infer<typeof compactionBindingSchema>,
): JsonRecord {
  const next = structuredClone(record(current));
  const plugins = (next.plugins = record(next.plugins));
  if (!Array.isArray(plugins.allow)) {
    throw new Error(
      "Staging requires an explicit plugins.allow list so enabling grogu-digest cannot change other plugin trust decisions",
    );
  }
  plugins.allow = addUnique(stringArray(plugins.allow), ["grogu-digest"]);
  const load = (plugins.load = record(plugins.load));
  load.paths = addUnique(stringArray(load.paths), [binding.pluginDirectory]);
  const pluginEntries = (plugins.entries = record(plugins.entries));
  pluginEntries["grogu-digest"] = {
    ...record(pluginEntries["grogu-digest"]),
    enabled: true,
  };

  const agents = (next.agents = record(next.agents));
  const defaults = (agents.defaults = record(agents.defaults));
  defaults.compaction = {
    ...record(defaults.compaction),
    provider: "grogu-digest",
    notifyUser: false,
  };
  const entries = (agents.entries = record(agents.entries));
  const agent = (entries[binding.agentId] = record(entries[binding.agentId]));
  const tools = (agent.tools = record(agent.tools));
  const historyTools = ["sessions_search", "sessions_history"];
  if (Array.isArray(tools.allow)) {
    tools.allow = addUnique(stringArray(tools.allow), historyTools);
  } else {
    tools.alsoAllow = addUnique(stringArray(tools.alsoAllow), historyTools);
  }
  return next;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cutoverScript(params: {
  configFile: string;
  sourceFile: string;
  expectedCurrentSha256: string;
  expectedSourceSha256: string;
}): string {
  return `import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

const configFile = ${JSON.stringify(params.configFile)};
const sourceFile = ${JSON.stringify(params.sourceFile)};
const expectedCurrentSha256 = ${JSON.stringify(params.expectedCurrentSha256)};
const expectedSourceSha256 = ${JSON.stringify(params.expectedSourceSha256)};
const digest = (value) => createHash("sha256").update(value).digest("hex");

const current = await readFile(configFile);
if (digest(current) !== expectedCurrentSha256) throw new Error("The live config changed since staging");
const source = await readFile(sourceFile);
if (digest(source) !== expectedSourceSha256) throw new Error("The staged config artifact changed");
const temporary = \`\${configFile}.grogu-\${randomUUID()}\`;
try {
  await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
  await rename(temporary, configFile);
} finally {
  await rm(temporary, { force: true });
}
console.log(JSON.stringify({ configUpdated: true, gatewayRestarted: false }));
`;
}

function recoveryScript(params: {
  configFile: string;
  originalSha256: string;
  candidateSha256: string;
}): string {
  return `import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const current = await readFile(${JSON.stringify(params.configFile)});
const digest = createHash("sha256").update(current).digest("hex");
const state = digest === ${JSON.stringify(params.originalSha256)}
  ? "original"
  : digest === ${JSON.stringify(params.candidateSha256)}
    ? "candidate"
    : "drifted";
console.log(JSON.stringify({ state, gatewayRestarted: false }));
if (state === "drifted") process.exitCode = 1;
`;
}

export async function stageGroguCompactionConfig(profile: OperatorProfile) {
  const document = readGroguPrivateProfileDocument(profile.profileFile);
  const binding = compactionBindingSchema.parse(record(document?.bindings).compaction);
  const original = await readFile(profile.configFile);
  const current = JSON5.parse(original.toString("utf8"));
  const candidate = buildGroguCompactionConfig(current, binding);
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const originalFile = path.join(directory, "openclaw.original.json");
  const candidateFile = path.join(directory, "openclaw.candidate.json");
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  await writeFile(originalFile, original, { mode: 0o600, flag: "wx" });
  await writeFile(candidateFile, candidateBytes, { mode: 0o600, flag: "wx" });
  z.object({ valid: z.literal(true) })
    .passthrough()
    .parse(
      await runNative(profile, ["config", "validate", "--json"], directory, {
        configFile: candidateFile,
      }),
    );
  const originalSha256 = sha256(original);
  const candidateSha256 = sha256(candidateBytes);
  const applyFile = path.join(directory, "apply.mjs");
  const rollbackFile = path.join(directory, "rollback.mjs");
  const recoverFile = path.join(directory, "recover.mjs");
  await writeFile(
    applyFile,
    cutoverScript({
      configFile: profile.configFile,
      sourceFile: candidateFile,
      expectedCurrentSha256: originalSha256,
      expectedSourceSha256: candidateSha256,
    }),
    { mode: 0o700, flag: "wx" },
  );
  await writeFile(
    rollbackFile,
    cutoverScript({
      configFile: profile.configFile,
      sourceFile: originalFile,
      expectedCurrentSha256: candidateSha256,
      expectedSourceSha256: originalSha256,
    }),
    { mode: 0o700, flag: "wx" },
  );
  await writeFile(
    recoverFile,
    recoveryScript({ configFile: profile.configFile, originalSha256, candidateSha256 }),
    { mode: 0o700, flag: "wx" },
  );
  const receipt = await writePrivateReceipt(directory, "compaction-stage.json", {
    schemaVersion: 1,
    provider: "grogu-digest",
    agentId: binding.agentId,
    originalSha256,
    candidateSha256,
    applyRequiresVerifiedBackup: false,
    gatewayRestarted: false,
    liveConfigChanged: false,
  });
  return { directory, receipt, applyFile, rollbackFile, recoverFile };
}
