import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { stageGroguCompactionConfig } from "../../grogu/compaction-config.js";
import type { OperatorProfile } from "../../grogu/operator.js";
import { cleanupGroguArtifacts, withGroguStorageLock } from "../../grogu/storage-artifacts.js";
import { bootstrapGroguStorage, cleanupGroguStorage } from "../../grogu/storage.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execute = promisify(execFile);
const directories = useAutoCleanupTempDirTracker(afterEach);
const oldName = "2026-01-01T00-00-00.000Z-11111111-1111-4111-8111-111111111111";
const freshName = "2026-01-01T00-00-00.000Z-22222222-2222-4222-8222-222222222222";

function job(id: string, payload: CronJob["payload"], declarationKey?: string): CronJob {
  return {
    id,
    declarationKey,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    configRevision: "revision-1",
    schedule: { kind: "every", everyMs: 86_400_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

async function fixture(jobs: CronJob[] = []) {
  const directory = directories.make("grogu-storage-");
  const profile: OperatorProfile = {
    profileFile: path.join(directory, "profile.json"),
    runtime: {
      node: process.execPath,
      cli: path.join(directory, "installed", "openclaw.mjs"),
    },
    stateDir: path.join(directory, "state"),
    configFile: path.join(directory, "state", "openclaw.json"),
    oauthDir: path.join(directory, "state", "credentials"),
    recoveryDir: path.join(directory, "recovery"),
    releasesDir: path.join(directory, "releases"),
    gatewayPort: 18789,
    gatewayUrl: "ws://127.0.0.1:18789",
  };
  for (const root of [
    profile.stateDir,
    profile.recoveryDir,
    profile.releasesDir,
    path.join(directory, "installed", "dist"),
  ]) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const { profileFile, ...operator } = profile;
  await fs.writeFile(
    profileFile,
    JSON.stringify({
      schemaVersion: 1,
      operator,
      bindings: {
        compaction: { agentId: "grogu", pluginDirectory: path.join(directory, "plugin") },
      },
    }),
    { mode: 0o600 },
  );
  const nativeState = path.join(directory, "native-state.json");
  await fs.writeFile(nativeState, JSON.stringify({ jobs }));
  await fs.writeFile(
    profile.runtime.cli,
    `import fs from "node:fs";
const store = ${JSON.stringify(nativeState)};
const data = JSON.parse(fs.readFileSync(store, "utf8"));
const args = process.argv.slice(2);
const method = args[2];
const params = args.includes("--params") ? JSON.parse(args[args.indexOf("--params") + 1]) : {};
let result;
if (args[0] === "config" && args[1] === "validate") {
  result = { valid: true };
} else if (method === "config.get") {
  result = { valid: true, runtimeConfig: { storage: { locations: {
    disk: { provider: "filesystem" }, remote: { provider: "s3" }
  } } } };
} else if (method === "cron.list") {
  result = { jobs: data.jobs.map(job => ({ ...job, effectiveAgentId: job.agentId ?? "main" })),
    snapshotRevision: "snapshot-1", hasMore: false, nextOffset: null };
} else if (method === "cron.update") {
  const job = data.jobs.find(job => job.id === params.id);
  if (!job || job.configRevision !== params.expectedConfigRevision) throw new Error("revision conflict");
  Object.assign(job, params.patch, { configRevision: "revision-2" });
  result = job;
} else if (method === "cron.add") {
  const existing = data.jobs.find(job => job.declarationKey === params.declarationKey);
  const job = { ...params, id: existing?.id ?? "storage-job", state: {},
    createdAtMs: 1, updatedAtMs: 2, configRevision: "revision-1" };
  if (existing) Object.assign(existing, job);
  else data.jobs.push(job);
  result = { created: !existing, updated: !!existing, job };
} else throw new Error("Unexpected native command");
fs.writeFileSync(store, JSON.stringify(data));
console.log(JSON.stringify(result));
`,
  );
  const maintenance = path.join(directory, "installed", "dist", "grogu-maint.js");
  await fs.writeFile(maintenance, "");
  const readJobs = async () =>
    (JSON.parse(await fs.readFile(nativeState, "utf8")) as { jobs: CronJob[] }).jobs;
  return { profile, readJobs, maintenance };
}

async function artifact(root: string, name: string, kind: "backup" | "release", aged = true) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { mode: 0o700 });
  const filename = kind === "backup" ? "example-openclaw-backup.tar.gz" : "openclaw-example.tgz";
  await fs.writeFile(path.join(directory, filename), "synthetic artifact");
  await fs.writeFile(
    path.join(directory, kind === "backup" ? "backup-provenance.json" : "release-manifest.json"),
    JSON.stringify(
      kind === "backup"
        ? { verified: true, archivePath: path.join(directory, filename), sha256: "1".repeat(64) }
        : { filename, sourceCommit: "1".repeat(40), sha256: "1".repeat(64) },
    ),
  );
  const time = new Date(Date.now() - (aged ? 24 : 23) * 60 * 60_000);
  for (const file of await fs.readdir(directory)) {
    await fs.utimes(path.join(directory, file), time, time);
  }
  await fs.utimes(directory, time, time);
  return directory;
}

describe("Grogu small-disk storage policy", () => {
  it("previews then retires completed old artifacts while retaining candidates and unknown content", async () => {
    const { profile } = await fixture();
    const archive = await artifact(profile.recoveryDir, oldName, "backup");
    const release = await artifact(profile.releasesDir, oldName, "release");
    const candidate = await artifact(profile.releasesDir, freshName, "release", false);
    const failed = path.join(
      profile.releasesDir,
      "2026-01-01T00-00-00.000Z-33333333-3333-4333-8333-333333333333",
    );
    await fs.mkdir(failed, { mode: 0o700 });
    const failureReceipt = path.join(failed, "release-build-failed.json");
    await fs.writeFile(failureReceipt, JSON.stringify({ sourceCommit: "1".repeat(40) }));
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await fs.utimes(failureReceipt, old, old);
    await fs.utimes(failed, old, old);
    const unknown = await artifact(profile.recoveryDir, freshName, "backup");
    await fs.writeFile(path.join(unknown, "unfinished-restore.json"), "{}");
    await fs.writeFile(profile.configFile, "preserve live configuration");
    const preview = await withGroguStorageLock(profile, (assertCurrent) =>
      cleanupGroguArtifacts(profile, { apply: false, assertCurrent }),
    );
    expect(preview.eligible).toEqual([archive, release, failed]);
    expect(preview.removed).toEqual([]);
    expect(await fs.readFile(path.join(archive, "example-openclaw-backup.tar.gz"), "utf8")).toBe(
      "synthetic artifact",
    );
    const applied = await withGroguStorageLock(profile, (assertCurrent) =>
      cleanupGroguArtifacts(profile, { apply: true, assertCurrent }),
    );
    expect(applied.removed).toEqual([archive, release, failed]);
    await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(release)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(candidate)).isDirectory()).toBe(true);
    expect((await fs.stat(unknown)).isDirectory()).toBe(true);
    expect(await fs.readFile(profile.configFile, "utf8")).toBe("preserve live configuration");
    expect(
      await withGroguStorageLock(profile, (assertCurrent) =>
        cleanupGroguArtifacts(profile, { apply: true, assertCurrent }),
      ),
    ).toMatchObject({ removed: [] });
  });

  it("does not delete an installed runtime or an aliased artifact", async () => {
    const { profile } = await fixture();
    const release = await artifact(profile.releasesDir, oldName, "release");
    const installedProfile = {
      ...profile,
      runtime: { ...profile.runtime, cli: path.join(release, "openclaw.mjs") },
    };
    const kept = await withGroguStorageLock(profile, (assertCurrent) =>
      cleanupGroguArtifacts(installedProfile, { apply: true, assertCurrent }),
    );
    expect(kept.protected).toContainEqual({ path: release, reason: "live-installation-or-state" });
    const archive = await artifact(profile.recoveryDir, oldName, "backup");
    const archiveFile = path.join(archive, "example-openclaw-backup.tar.gz");
    await fs.unlink(archiveFile);
    await fs.symlink(profile.profileFile, archiveFile);
    await expect(
      withGroguStorageLock(profile, (assertCurrent) =>
        cleanupGroguArtifacts(profile, { apply: true, assertCurrent }),
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(profile.profileFile, "utf8")).toContain('"schemaVersion":1');
    expect((await fs.stat(archive)).isDirectory()).toBe(true);
  });

  it("converges one native cleanup job and disables only local full-backup producers", async () => {
    const { profile, readJobs, maintenance } = await fixture([
      job(
        "local",
        { kind: "command", argv: ["openclaw", "backup", "create", "--to", "disk"] },
        "openclaw-backup-offsite-scheduled",
      ),
      job(
        "remote",
        { kind: "command", argv: ["openclaw", "backup", "create", "--to", "remote"] },
        "openclaw-backup-offsite-scheduled",
      ),
      job(
        "git",
        { kind: "command", argv: ["openclaw", "backup", "git", "create"] },
        "openclaw-backup-scheduled",
      ),
      job("legacy", {
        kind: "agentTurn",
        message: "GROGU_BACKUP_OBSERVABILITY_V1: old backup task",
      }),
      job("research", { kind: "agentTurn", message: "Research synthetic sources." }),
    ]);
    const preview = await bootstrapGroguStorage(profile);
    expect(preview.backups.disabled).toEqual(["local", "legacy"]);
    expect((await readJobs()).every((job) => job.enabled)).toBe(true);
    await fs.writeFile(maintenance, 'throw new Error("unknown command: storage-cleanup");');
    await expect(bootstrapGroguStorage(profile, true)).rejects.toThrow("unknown command");
    expect((await readJobs()).every((job) => job.enabled)).toBe(true);
    await fs.writeFile(maintenance, "");
    const applied = await bootstrapGroguStorage(profile, true);
    await bootstrapGroguStorage(profile, true);
    const jobs = await readJobs();
    expect(jobs.filter((job) => !job.enabled).map((job) => job.id)).toEqual(["local", "legacy"]);
    const cleanup = jobs.filter((job) => job.declarationKey === "grogu-storage-cleanup-v1");
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: {
        kind: "command",
        argv: [
          process.execPath,
          path.join(path.dirname(profile.runtime.cli), "dist", "grogu-maint.js"),
          "--profile",
          profile.profileFile,
          "storage-cleanup",
          "--apply",
        ],
      },
    });
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    for (const file of await fs.readdir(applied.privateReceipts)) {
      await fs.utimes(path.join(applied.privateReceipts, file), old, old);
    }
    await fs.utimes(applied.privateReceipts, old, old);
    await cleanupGroguStorage(profile, true);
    await expect(fs.stat(applied.privateReceipts)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readJobs()).filter((job) => !job.enabled).map((job) => job.id)).toEqual([
      "local",
      "legacy",
    ]);
  });

  it("reports an active legacy backup instead of cancelling its writer", async () => {
    const running = job("running", { kind: "agentTurn", message: "GROGU_BACKUP_OBSERVABILITY_V1" });
    running.state.runningAtMs = 1;
    const { profile, readJobs } = await fixture([running]);
    expect(await cleanupGroguStorage(profile, true)).toMatchObject({
      backups: { disabled: [], deferred: ["running"] },
    });
    expect((await readJobs())[0]?.enabled).toBe(true);
  });

  it("applies and rolls back a staged configuration without making or requiring a full backup", async () => {
    const { profile } = await fixture();
    const original = JSON.stringify({ plugins: { allow: [] } });
    await fs.writeFile(profile.configFile, original);
    const staged = await stageGroguCompactionConfig(profile);
    await execute(process.execPath, [staged.applyFile], {
      env: { ...process.env, GROGU_VERIFIED_BACKUP_RECEIPT: "" },
    });
    expect(JSON.parse(await fs.readFile(profile.configFile, "utf8"))).toMatchObject({
      agents: { defaults: { compaction: { provider: "grogu-digest" } } },
    });
    await execute(process.execPath, [staged.rollbackFile]);
    expect(await fs.readFile(profile.configFile, "utf8")).toBe(original);
    expect((await fs.readdir(staged.directory)).some((file) => file.endsWith(".tar.gz"))).toBe(
      false,
    );
  });
});
