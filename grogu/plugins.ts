import { z } from "zod";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../src/plugins/installed-plugin-index-record-reader.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../src/plugins/installed-plugin-index-record-state.js";
import { createPrivateArtifactDirectory, runNative, type OperatorProfile } from "./operator.js";

const requiredPlugins = [
  { id: "acpx", package: "@openclaw/acpx", version: "2026.10.7", source: "npm" },
  { id: "copilot", package: "@openclaw/copilot", version: "2026.10.7", source: "npm" },
  { id: "diffs", package: "@openclaw/diffs", version: "2026.10.7", source: "clawhub" },
  { id: "duckduckgo", package: "@openclaw/duckduckgo-plugin", version: "2026.10.7", source: "npm" },
  { id: "lobster", package: "@openclaw/lobster", version: "2026.10.7", source: "clawhub" },
  {
    id: "openclaw-icloud-calendar",
    package: "openclaw-icloud-calendar",
    version: "0.1.2",
    source: "clawhub",
  },
] as const;

type RequiredPlugin = (typeof requiredPlugins)[number];
type PluginAction = "install" | "repair" | "pin" | "ready" | "conflict";
type PluginPlan = { id: string; spec: string; action: PluginAction; reason?: string };
type PluginInventory = {
  ids: Set<string>;
  errors: Set<string>;
  installs: Record<string, unknown>;
};

const pluginListSchema = z.object({
  plugins: z.array(z.object({ id: z.string() }).passthrough()),
  diagnostics: z
    .array(z.object({ level: z.string(), pluginId: z.string().optional() }).passthrough())
    .default([]),
});
const pluginSchema = z
  .object({
    id: z.string(),
    packageName: z.string().optional(),
    packageVersion: z.string().optional(),
    status: z.string().optional(),
    dependencyStatus: z.object({ requiredInstalled: z.boolean() }).optional(),
  })
  .passthrough();
const installSchema = z
  .object({
    source: z.string(),
    spec: z.string().optional(),
    version: z.string().optional(),
    resolvedVersion: z.string().optional(),
    resolvedName: z.string().optional(),
    resolvedSpec: z.string().optional(),
    clawhubPackage: z.string().optional(),
  })
  .passthrough();
const pluginInfoSchema = z.object({ plugin: pluginSchema, install: installSchema.nullish() });

function pluginSpec(plugin: RequiredPlugin): string {
  return `${plugin.source}:${plugin.package}@${plugin.version}`;
}

function planExistingPlugin(
  expected: RequiredPlugin,
  install: z.infer<typeof installSchema> | null | undefined,
  plugin?: z.infer<typeof pluginSchema>,
): PluginPlan {
  const spec = pluginSpec(expected);
  const conflict = (reason: string): PluginPlan => ({
    id: expected.id,
    spec,
    action: "conflict",
    reason,
  });
  if (
    !install ||
    install.source !== expected.source ||
    (plugin && (plugin.id !== expected.id || plugin.packageName !== expected.package))
  ) {
    return conflict("The existing plugin is not the approved package and source.");
  }
  const recordedNames = [install.resolvedName, install.clawhubPackage].filter(
    (name): name is string => name !== undefined,
  );
  const versions = [install.version, install.resolvedVersion, plugin?.packageVersion].filter(
    (version): version is string => version !== undefined,
  );
  if (
    recordedNames.some((name) => name !== expected.package) ||
    versions.length === 0 ||
    versions.some((version) => version !== expected.version)
  ) {
    return conflict("The existing plugin has a different package identity or version.");
  }
  const unversioned =
    expected.source === "npm" ? expected.package : `${expected.source}:${expected.package}`;
  const normalizeSpec = (value: string) =>
    expected.source === "npm" ? value.replace(/^npm:/, "") : value;
  const recordedSpec = install.spec ? normalizeSpec(install.spec) : undefined;
  const pinnedSpec = `${unversioned}@${expected.version}`;
  if (
    !recordedSpec ||
    (recordedSpec !== unversioned && recordedSpec !== pinnedSpec) ||
    (install.resolvedSpec && normalizeSpec(install.resolvedSpec) !== pinnedSpec)
  ) {
    return conflict("The existing plugin has an unexpected installation record.");
  }
  if (!plugin || plugin.dependencyStatus?.requiredInstalled !== true) {
    return { id: expected.id, spec, action: "repair" };
  }
  if (plugin.status === "error") {
    return conflict("The existing plugin reports an error; inspect its native plugin information.");
  }
  return { id: expected.id, spec, action: recordedSpec === pinnedSpec ? "ready" : "pin" };
}

async function readPluginPlan(
  profile: OperatorProfile,
  plugin: RequiredPlugin,
  inventory: PluginInventory,
  directory: string,
): Promise<PluginPlan> {
  if (!inventory.ids.has(plugin.id)) {
    const record = inventory.installs[plugin.id];
    if (record !== undefined) {
      return planExistingPlugin(plugin, installSchema.parse(record));
    }
    if (inventory.errors.has(plugin.id)) {
      return {
        id: plugin.id,
        spec: pluginSpec(plugin),
        action: "conflict",
        reason: "OpenClaw reports an unresolved installation; inspect its native diagnostics.",
      };
    }
    return { id: plugin.id, spec: pluginSpec(plugin), action: "install" };
  }
  const info = await runNative(profile, ["plugins", "info", plugin.id, "--json"], directory);
  const existing = pluginInfoSchema.parse(info);
  return planExistingPlugin(plugin, existing.install, existing.plugin);
}

async function listPlugins(profile: OperatorProfile, directory: string): Promise<PluginInventory> {
  const result = await runNative(profile, ["plugins", "list", "--json"], directory);
  const { plugins, diagnostics } = pluginListSchema.parse(result);
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const records = inspectPersistedInstalledPluginIndexInstallRecordsSync({
    stateDir: profile.stateDir,
    artifactPreservingReadOnly: true,
  });
  if (records.status === "invalid") {
    throw new Error("OpenClaw plugin install records are invalid; inspect them with doctor.");
  }
  return {
    ids: new Set(plugins.map((plugin) => plugin.id)),
    errors: new Set(
      diagnostics.flatMap((diagnostic) =>
        diagnostic.level === "error" && diagnostic.pluginId ? [diagnostic.pluginId] : [],
      ),
    ),
    installs: records.status === "valid" ? records.records : {},
  };
}

export async function bootstrapGroguPlugins(
  profile: OperatorProfile,
  options: { apply: boolean; acceptCapabilities: boolean },
) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const inventory = await listPlugins(profile, directory);
  const planned: Array<{ plugin: RequiredPlugin; plan: PluginPlan }> = [];
  for (const plugin of requiredPlugins) {
    planned.push({ plugin, plan: await readPluginPlan(profile, plugin, inventory, directory) });
  }
  const plans = planned.map(({ plan }) => plan);
  if (!options.apply || plans.some((plan) => plan.action === "conflict")) {
    return { applied: false, plugins: plans, privateReceipts: directory };
  }

  for (const { plugin, plan } of planned) {
    if (plan.action === "ready") {
      continue;
    }
    const currentInventory = await listPlugins(profile, directory);
    const current = await readPluginPlan(profile, plugin, currentInventory, directory);
    if (
      current.action === "conflict" ||
      (plan.action !== "install" && current.action === "install")
    ) {
      throw new Error(`Plugin ${plugin.id} changed during setup; inspect the native install.`);
    }
    if (current.action === "ready") {
      continue;
    }
    const args = ["plugins", "install", current.spec, "--no-enable"];
    if (current.action !== "install") {
      args.push("--force");
    }
    if (plugin.source === "npm") {
      args.push("--pin");
    }
    if (options.acceptCapabilities) {
      args.push("--accept-capabilities");
    }
    await runNative(profile, args, directory, { output: "text" });
  }

  const resultInventory = await listPlugins(profile, directory);
  for (const plugin of requiredPlugins) {
    const result = await readPluginPlan(profile, plugin, resultInventory, directory);
    if (result.action !== "ready") {
      throw new Error(
        `Plugin ${plugin.id} is not ready after installation; inspect private receipts in ${directory}.`,
      );
    }
  }
  return { applied: true, plugins: plans, privateReceipts: directory };
}
