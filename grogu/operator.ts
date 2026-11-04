import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, stat as statFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readGroguPrivateProfileDocument } from "../src/agents/grogu-private-profile.js";

const execute = promisify(execFile);
const absolutePath = z.string().min(1).refine(path.isAbsolute, "Expected an absolute path");
const operatorSchema = z
  .object({
    runtime: z.object({ node: absolutePath, cli: absolutePath }).strict(),
    stateDir: absolutePath,
    configFile: absolutePath,
    oauthDir: absolutePath,
    recoveryDir: absolutePath,
    releasesDir: absolutePath,
    gatewayPort: z.number().int().min(1).max(65535),
    gatewayUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["ws:", "wss:"].includes(url.protocol) &&
          url.hostname === "127.0.0.1" &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      }, "Maintenance must target the canonical credential-free Gateway loopback URL"),
  })
  .strict()
  .refine((value) => {
    const url = new URL(value.gatewayUrl);
    return value.gatewayUrl === `${url.protocol}//127.0.0.1:${value.gatewayPort}`;
  }, "The selected canonical Gateway URL and port must agree");

export type OperatorProfile = z.infer<typeof operatorSchema> & { profileFile: string };

export function loadOperatorProfile(profileFile: string): OperatorProfile {
  const document = readGroguPrivateProfileDocument(profileFile);
  if (!document) {
    throw new Error("A protected Grogu profile is required for maintenance");
  }
  return { ...operatorSchema.parse(document.operator), profileFile };
}

export async function createPrivateArtifactDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Recovery artifacts require an owner-only directory");
  }
  const directory = path.join(
    root,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export async function writePrivateReceipt(directory: string, name: string, value: unknown) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) {
    throw new Error("Invalid maintenance receipt name");
  }
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

export async function runNative(
  profile: OperatorProfile,
  args: string[],
  receiptDirectory: string,
): Promise<unknown> {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execute(profile.runtime.node, [profile.runtime.cli, ...args], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: profile.stateDir,
        OPENCLAW_CONFIG_PATH: profile.configFile,
        OPENCLAW_OAUTH_DIR: profile.oauthDir,
        OPENCLAW_GATEWAY_URL: profile.gatewayUrl,
        GROGU_PROFILE_FILE: profile.profileFile,
        NO_COLOR: "1",
      },
      timeout: 30 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
      cwd: path.dirname(profile.profileFile),
    }));
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: string; stderr?: string };
    const receipt = await writePrivateReceipt(
      receiptDirectory,
      `native-failure-${randomUUID()}.json`,
      {
        command: args.slice(0, 3),
        code: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      },
    );
    throw new Error(`Native ${args.slice(0, 2).join(" ")} failed; private receipt: ${receipt}`, {
      cause: error,
    });
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    await writePrivateReceipt(receiptDirectory, `native-output-invalid-${randomUUID()}.json`, {
      stdout,
      stderr,
    });
    throw new Error("Native command returned invalid JSON; retained the private output", {
      cause: error,
    });
  }
  await writePrivateReceipt(receiptDirectory, `native-${randomUUID()}.json`, { result, stderr });
  return result;
}

export async function callNative(
  profile: OperatorProfile,
  method: string,
  params: object,
  receiptDirectory: string,
) {
  return runNative(
    profile,
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--port",
      String(profile.gatewayPort),
      "--expect-url",
      profile.gatewayUrl,
      "--timeout",
      "60000",
      "--json",
    ],
    receiptDirectory,
  );
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const completeBackupSchema = z
  .object({
    archivePath: absolutePath,
    verified: z.boolean(),
    dryRun: z.literal(false),
    includeWorkspace: z.literal(true),
    onlyConfig: z.literal(false),
  })
  .passthrough();

export async function createVerifiedBackup(profile: OperatorProfile) {
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const captureStartedAt = Date.now();
  const result = completeBackupSchema.parse(
    await runNative(profile, ["backup", "create", "--output", directory, "--json"], directory),
  );
  const captureMs = Date.now() - captureStartedAt;
  const verificationStartedAt = Date.now();
  await runNative(profile, ["backup", "verify", result.archivePath, "--json"], directory);
  const verificationMs = Date.now() - verificationStartedAt;
  const digestStartedAt = Date.now();
  const digest = await sha256File(result.archivePath);
  const digestMs = Date.now() - digestStartedAt;
  const archiveBytes = (await statFile(result.archivePath)).size;
  const receipt = await writePrivateReceipt(directory, "backup-provenance.json", {
    schemaVersion: 1,
    archivePath: result.archivePath,
    sha256: digest,
    verified: true,
    includeWorkspace: true,
    archiveBytes,
    phaseTimingsMs: {
      capture: captureMs,
      verification: verificationMs,
      digest: digestMs,
    },
    capture: "online-per-database",
    quiescentCutoverBackup: false,
  });
  return { archivePath: result.archivePath, sha256: digest, receipt };
}

export async function stageNativeRestore(
  profile: OperatorProfile,
  archive: string,
  target: string,
) {
  if (!path.isAbsolute(archive) || !path.isAbsolute(target)) {
    throw new Error("Restore requires explicit absolute archive and staging paths");
  }
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  await runNative(profile, ["backup", "verify", archive, "--json"], directory);
  const result = await runNative(
    profile,
    ["backup", "restore", archive, "--target", target, "--json"],
    directory,
  );
  const receipt = await writePrivateReceipt(directory, "staging-restore.json", {
    schemaVersion: 1,
    archiveSha256: await sha256File(archive),
    target,
    result,
    activated: false,
    channelsStarted: false,
  });
  return { target, receipt, activated: false };
}
