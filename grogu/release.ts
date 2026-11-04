import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createPrivateArtifactDirectory,
  sha256File,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";

const execute = promisify(execFile);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceCommit: commit,
    upstreamCommit: commit,
    packageVersion: z.string().min(1),
    node: z.string().min(1),
    pnpm: z.string().min(1),
    platform: z.enum(["darwin", "linux"]),
    arch: z.enum(["arm64", "x64"]),
    stateSchemaVersion: z.number().int().nonnegative(),
    agentSchemaVersion: z.number().int().nonnegative(),
    updateAdmissionProtocol: z.number().int().nonnegative(),
    filename: z.string().regex(/^[a-zA-Z0-9._-]+\.tgz$/),
    sha256: digest,
    rollbackCertified: z.literal(false),
  })
  .strict();

const packageMetadataSchema = z
  .object({
    version: z.string(),
    packageManager: z.string().regex(/^pnpm@[0-9.]+\+/),
    openclaw: z
      .object({
        updateAdmissionProtocol: z.number().int().nonnegative(),
        schemaVersions: z
          .object({
            state: z.number().int().nonnegative(),
            agent: z.number().int().nonnegative(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export function parsePackageMetadata(value: unknown) {
  const metadata = packageMetadataSchema.parse(value);
  return {
    version: metadata.version,
    packageManager: metadata.packageManager,
    stateSchemaVersion: metadata.openclaw.schemaVersions.state,
    agentSchemaVersion: metadata.openclaw.schemaVersions.agent,
    updateAdmissionProtocol: metadata.openclaw.updateAdmissionProtocol,
  };
}

export function createToolchainEnvironment(
  nodePath: string,
  pnpmPath: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: [path.dirname(nodePath), path.dirname(pnpmPath), environment.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter),
  };
}

export async function resolveToolchainPnpm(nodePath: string, environment: NodeJS.ProcessEnv) {
  const selectionEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PATH: [path.dirname(nodePath), environment.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter),
  };
  const { stdout } = await execute("which", ["pnpm"], { env: selectionEnvironment });
  const pnpmPath = stdout.trim();
  return {
    pnpmPath,
    environment: createToolchainEnvironment(nodePath, pnpmPath, environment),
  };
}

export function admitReleaseManifest(
  value: unknown,
  target: {
    platform: string;
    arch: string;
    node: string;
  },
) {
  const manifest = manifestSchema.parse(value);
  if (
    manifest.platform !== target.platform ||
    manifest.arch !== target.arch ||
    manifest.node !== target.node
  ) {
    throw new Error("Release platform, architecture and pinned Node must match the target host");
  }
  return manifest;
}

async function git(source: string, args: string[]) {
  const { stdout } = await execute("git", args, { cwd: source, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function buildRelease(profile: OperatorProfile, source: string) {
  if (
    !path.isAbsolute(source) ||
    (await git(source, ["rev-parse", "--show-toplevel"])) !== source
  ) {
    throw new Error("Release builds require an explicit absolute Git worktree root");
  }
  if (
    [
      profile.stateDir,
      profile.configFile,
      profile.oauthDir,
      profile.recoveryDir,
      profile.releasesDir,
      profile.profileFile,
      profile.runtime.cli,
    ].some((target) => contains(source, target))
  ) {
    throw new Error(
      "Build source must be isolated from live runtime, private configuration, state and artifacts",
    );
  }
  const sourceCommit = commit.parse(await git(source, ["rev-parse", "HEAD"]));
  if (await git(source, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Commit and review source changes before building an immutable release");
  }
  const packageMetadata = parsePackageMetadata(
    JSON.parse(await readFile(path.join(source, "package.json"), "utf8")),
  );
  const toolchain = z
    .object({ node: z.string(), pnpm: z.string() })
    .strict()
    .parse(JSON.parse(await readFile(path.join(source, "grogu/toolchain.json"), "utf8")));
  const { pnpmPath: packageManagerPath, environment: buildEnvironment } =
    await resolveToolchainPnpm(process.execPath, process.env);
  const releaseEnvironment: NodeJS.ProcessEnv = { ...buildEnvironment, NO_COLOR: "1" };
  delete releaseEnvironment.GROGU_PROFILE_FILE;
  const { stdout: pnpmVersion } = await execute(packageManagerPath, ["--version"], {
    cwd: source,
    env: releaseEnvironment,
  });
  if (
    process.versions.node !== toolchain.node ||
    pnpmVersion.trim() !== toolchain.pnpm ||
    !packageMetadata.packageManager.startsWith(`pnpm@${toolchain.pnpm}+`)
  ) {
    throw new Error("Install the committed Node and pnpm toolchain before building");
  }
  const upstream = z
    .object({ commit })
    .parse(JSON.parse(await readFile(path.join(source, "grogu/upstream.json"), "utf8")));
  await git(source, ["merge-base", "--is-ancestor", upstream.commit, sourceCommit]);
  const directory = await createPrivateArtifactDirectory(profile.releasesDir);
  const filename = `openclaw-${sourceCommit}-${process.platform}-${process.arch}.tgz`;
  let output: { stdout: string; stderr: string };
  try {
    output = await execute(
      process.execPath,
      [
        "scripts/package-openclaw-for-docker.mjs",
        "--source-dir",
        source,
        "--output-dir",
        directory,
        "--output-name",
        filename,
        "--allow-unreleased-changelog",
      ],
      {
        cwd: source,
        env: releaseEnvironment,
        timeout: 90 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      },
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const receipt = await writePrivateReceipt(directory, "release-build-failed.json", {
      sourceCommit,
      stdout: failure.stdout,
      stderr: failure.stderr,
    });
    throw new Error(`Release build failed; candidate not admitted. Private receipt: ${receipt}`, {
      cause: error,
    });
  }
  await writePrivateReceipt(directory, "release-build-output.json", output);
  for (const entry of ["grogu-maint.js", "model-request-telemetry-store.worker.js"]) {
    if (!(await stat(path.join(source, "dist", entry))).isFile()) {
      throw new Error(`Required downstream runtime entry is absent: ${entry}`);
    }
  }
  if (
    (await git(source, ["rev-parse", "HEAD"])) !== sourceCommit ||
    (await git(source, ["status", "--porcelain", "--untracked-files=all"]))
  ) {
    throw new Error("Source changed during packaging; release is not admitted");
  }
  const manifest = admitReleaseManifest(
    {
      schemaVersion: 1,
      sourceCommit,
      upstreamCommit: upstream.commit,
      packageVersion: packageMetadata.version,
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      platform: process.platform,
      arch: process.arch,
      stateSchemaVersion: packageMetadata.stateSchemaVersion,
      agentSchemaVersion: packageMetadata.agentSchemaVersion,
      updateAdmissionProtocol: packageMetadata.updateAdmissionProtocol,
      filename,
      sha256: await sha256File(path.join(directory, filename)),
      rollbackCertified: false,
    },
    { platform: process.platform, arch: process.arch, node: process.versions.node },
  );
  const receipt = await writePrivateReceipt(directory, "release-manifest.json", manifest);
  return { directory, manifest: receipt, sha256: manifest.sha256, deployed: false };
}

export async function verifyRelease(profile: OperatorProfile, manifestFile: string) {
  if (!path.isAbsolute(manifestFile) || !contains(profile.releasesDir, manifestFile)) {
    throw new Error("Select an absolute manifest inside the private immutable releases directory");
  }
  const manifest = admitReleaseManifest(JSON.parse(await readFile(manifestFile, "utf8")), {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  });
  if (
    (await sha256File(path.join(path.dirname(manifestFile), manifest.filename))) !== manifest.sha256
  ) {
    throw new Error("Release artifact digest differs from its committed-source manifest");
  }
  return {
    sourceCommit: manifest.sourceCommit,
    artifactVerified: true,
    rollbackCertified: false,
    deployed: false,
  };
}
