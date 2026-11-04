import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { parseMergeTreeNameOnlyZ } from "./merge-tree.js";
import { admitRollingPullRequests } from "./upstream-pr.js";
import { checkUpstream } from "./upstream.js";
import { archiveUpstreamWorkflows } from "./workflows.js";

const execute = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branch = "grogu/upstream";
const root = process.cwd();
const MAX_REPORTED_CONFLICTS = 20;

type MergeOutcome = { kind: "clean"; tree: string } | { kind: "conflicted"; conflicts: string[] };
type CommandRunner = (bin: string, args: string[]) => Promise<string>;

async function run(bin: string, args: string[]) {
  return (await runRaw(bin, args)).trim();
}

async function runRaw(bin: string, args: string[]) {
  // Upstream-controlled hook files must never run while the writer holds a push token.
  const argv = bin === "git" ? ["-c", "core.hooksPath=/dev/null", ...args] : args;
  const { stdout } = await execute(bin, argv, {
    cwd: root,
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function analyzeMergeTree(
  base: string,
  upstreamCommit: string,
  executeMergeTree: typeof runRaw = runRaw,
): Promise<MergeOutcome> {
  const args = [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    `--merge-base=${base}`,
    "HEAD",
    upstreamCommit,
  ];
  try {
    const parsed = parseMergeTreeNameOnlyZ(await executeMergeTree("git", args));
    return { kind: "clean" as const, tree: parsed.tree };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1) {
      throw error;
    }
    if (typeof failure.stdout !== "string") {
      throw error;
    }
    const parsed = parseMergeTreeNameOnlyZ(failure.stdout);
    return { kind: "conflicted" as const, conflicts: parsed.conflicts };
  }
}

async function summarize(summary: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    await appendFile(file, `${summary}\n`);
  }
}

function normalizedConflictPaths(conflicts: readonly string[]): string[] {
  const paths = [...new Set(conflicts)].toSorted((left, right) => left.localeCompare(right));
  for (const file of paths) {
    if (
      !file ||
      file.includes("\0") ||
      file.includes("\n") ||
      file.includes("\r") ||
      file.includes("`") ||
      path.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("Upstream merge reported an invalid conflicted path");
    }
  }
  return paths;
}

export function formatExpectedConflictSummary(params: {
  release: string;
  upstreamCommit: string;
  conflicts: readonly string[];
}): string {
  const conflicts = normalizedConflictPaths(params.conflicts);
  const visible = conflicts.slice(0, MAX_REPORTED_CONFLICTS);
  const hidden = conflicts.length - visible.length;
  const count =
    conflicts.length === 0
      ? "Conflicted paths: 0 reported by git (non-file conflict, e.g. a directory rename); inspect the merge manually"
      : `Conflicted paths: ${conflicts.length}`;
  return [
    `### Upstream ${params.release} needs conflict resolution`,
    "",
    `Upstream commit: \`${params.upstreamCommit.slice(0, 12)}\``,
    count,
    "",
    ...visible.map((file) => `- \`${file}\``),
    ...(hidden > 0 ? [`- +${hidden} more`] : []),
    "",
    "No PR opened, nothing pushed; resolve manually or wait for the next release.",
  ].join("\n");
}

export async function settleMergeOutcome(
  merge: MergeOutcome,
  params: {
    release: string;
    upstreamCommit: string;
  },
  deps: {
    writeSummary: (summary: string) => Promise<void>;
    log: (summary: string) => void;
  },
): Promise<{ kind: "conflicted" } | { kind: "clean"; tree: string }> {
  if (merge.kind === "conflicted") {
    const summary = formatExpectedConflictSummary({ ...params, conflicts: merge.conflicts });
    await deps.writeSummary(summary);
    deps.log(summary);
    return { kind: "conflicted" };
  }
  return merge;
}

export function assertWriterEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS !== "true" || !env.GITHUB_REPOSITORY) {
    throw new Error("The rolling-update writer runs only in its isolated private Actions checkout");
  }
  if (!env.GH_TOKEN?.trim()) {
    throw new Error("GROGU_UPSTREAM_TOKEN is required for the rolling-update writer");
  }
}

export async function registerAndFetchUpstreamRelease(params: {
  runner: CommandRunner;
  remoteName: string;
  upstreamUrl: string;
  tag: string;
}): Promise<void> {
  await params.runner("git", ["remote", "add", "--no-tags", params.remoteName, params.upstreamUrl]);
  await params.runner("git", ["config", `remote.${params.remoteName}.promisor`, "true"]);
  await params.runner("git", [
    "config",
    `remote.${params.remoteName}.partialclonefilter`,
    "blob:none",
  ]);
  await params.runner("git", [
    "fetch",
    "--no-tags",
    "--filter=blob:none",
    params.remoteName,
    `refs/tags/${params.tag}`,
  ]);
}

export function isDirectRun(argvPath: string | undefined, moduleUrl = import.meta.url): boolean {
  return (
    argvPath !== undefined &&
    argvPath !== "-" &&
    pathToFileURL(realpathSync(argvPath)).href === moduleUrl
  );
}

async function publishPrepared(head: string, upstreamCommit: string, latest: string) {
  const prs = admitRollingPullRequests(
    JSON.parse(
      await run("gh", [
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "number,url,headRefOid,isDraft,autoMergeRequest",
      ]),
    ),
    head,
  );
  if (prs.length > 1 || (prs[0] && prs[0].headRefOid !== head)) {
    throw new Error("The rolling PR owner changed; reconcile without touching production");
  }
  let url = prs[0]?.url;
  if (!url) {
    url = await run("gh", [
      "pr",
      "create",
      "--draft",
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      `chore: integrate upstream ${latest}`,
      "--body",
      `Prepared stable upstream ${latest} at ${upstreamCommit}.\n\nThis rolling branch retains earlier integration work. Inherited workflows remain quarantined. Native state, profiles, channels and model requests are untouched. Review, offline checks, platform builds and recovery acceptance remain mandatory before deployment.`,
    ]);
  } else {
    await run("gh", [
      "pr",
      "edit",
      String(prs[0]!.number),
      "--title",
      `chore: integrate upstream ${latest}`,
    ]);
  }
  const runs = z
    .array(z.object({ status: z.string(), conclusion: z.string() }))
    .parse(
      JSON.parse(
        await run("gh", [
          "run",
          "list",
          "--workflow",
          "grogu-ci.yml",
          "--commit",
          head,
          "--limit",
          "3",
          "--json",
          "status,conclusion",
        ]),
      ),
    );
  let checks = runs[0]?.conclusion || runs[0]?.status || "requested";
  if (!runs.length) {
    // GITHUB_TOKEN-authored pushes do not start PR CI; explicitly request exact-head checks.
    await run("gh", [
      "workflow",
      "run",
      "grogu-ci.yml",
      "--ref",
      branch,
      "-f",
      `target_sha=${head}`,
    ]);
    checks = "requested";
  }
  console.log(
    JSON.stringify({
      url,
      head,
      upstreamCommit,
      checks,
      productionChanged: false,
      autoMerged: false,
    }),
  );
}

export async function main() {
  assertWriterEnvironment(process.env);
  if (await run("git", ["status", "--porcelain"])) {
    throw new Error("Upstream preparation requires a clean isolated checkout");
  }
  const status = await checkUpstream(root);
  if (status.origin !== process.env.GITHUB_REPOSITORY) {
    throw new Error("The authenticated private repository must match the Actions owner");
  }
  process.env.GH_REPO = status.origin;
  if (!status.newer) {
    console.log(JSON.stringify({ newer: false, productionChanged: false }));
    return;
  }
  const remote = await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  const oldHead = remote ? sha.parse(remote.split(/\s+/)[0]) : "";
  const existingPrs = admitRollingPullRequests(
    JSON.parse(
      await run("gh", [
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "number,url,headRefOid,isDraft,autoMergeRequest",
      ]),
    ),
    oldHead || undefined,
  );
  if (!oldHead && existingPrs.length) {
    throw new Error("An open rolling PR exists without its expected remote branch");
  }
  if (oldHead) {
    await run("git", ["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
    if (sha.parse(await run("git", ["rev-parse", "FETCH_HEAD"])) !== oldHead) {
      throw new Error(
        "The rolling branch changed during acquisition; retry after reconciling its owner",
      );
    }
    await run("git", ["switch", "--detach", oldHead]);
  }
  const priorPin = z
    .object({ release: z.string(), commit: sha })
    .parse(JSON.parse(await readFile(path.join(root, "grogu/upstream.json"), "utf8")));
  if (priorPin.release === status.latest) {
    await publishPrepared(oldHead, priorPin.commit, status.latest);
    return;
  }
  const upstreamRemote = "grogu-upstream-source";
  await registerAndFetchUpstreamRelease({
    runner: run,
    remoteName: upstreamRemote,
    upstreamUrl: `https://github.com/${status.upstream}.git`,
    tag: status.latest,
  });
  const upstreamCommit = sha.parse(await run("git", ["rev-parse", "FETCH_HEAD^{commit}"]));
  const canonicalCommit = sha.parse(
    await run("gh", ["api", `repos/${status.upstream}/commits/${status.latest}`, "--jq", ".sha"]),
  );
  if (upstreamCommit !== canonicalCommit) {
    throw new Error(
      "The fetched release differs from its canonical commit; do not publish a candidate",
    );
  }
  // Upstream cuts each stable release on its own branch, so consecutive releases diverge.
  // A three-way merge against the pinned release applies exactly Grogu's delta to the new
  // release; the merge commit then records both histories for the next integration.
  await run("git", ["merge-base", "--is-ancestor", priorPin.commit, "HEAD"]);
  const merge = await analyzeMergeTree(priorPin.commit, upstreamCommit);
  const settled = await settleMergeOutcome(
    merge,
    { release: status.latest, upstreamCommit },
    {
      writeSummary: summarize,
      log: console.log,
    },
  );
  if (settled.kind === "conflicted") {
    return;
  }
  await run("git", ["switch", "-c", "grogu/upstream-candidate"]);
  const mergedTree = settled.tree;
  await run("git", ["read-tree", "--reset", "-u", mergedTree]);
  await archiveUpstreamWorkflows(root);
  await writeFile(
    path.join(root, "grogu/upstream.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: status.upstream,
        release: status.latest,
        commit: upstreamCommit,
      },
      null,
      2,
    )}\n`,
  );
  await run("git", ["add", "--update"]);
  await run("git", ["add", "grogu/upstream.json", ".github/upstream-workflows"]);
  const integrated = sha.parse(
    await run("git", [
      "commit-tree",
      await run("git", ["write-tree"]),
      "-p",
      "HEAD",
      "-p",
      upstreamCommit,
      "-m",
      `chore: integrate upstream ${status.latest}`,
    ]),
  );
  await run("git", ["reset", "--hard", integrated]);
  const head = sha.parse(await run("git", ["rev-parse", "HEAD"]));
  const beforePush = admitRollingPullRequests(
    JSON.parse(
      await run("gh", [
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "number,url,headRefOid,isDraft,autoMergeRequest",
      ]),
    ),
    oldHead || undefined,
  );
  if (!oldHead && beforePush.length) {
    throw new Error("An open rolling PR appeared without the expected remote branch");
  }
  await run("git", [
    "push",
    `--force-with-lease=refs/heads/${branch}:${oldHead}`,
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  await publishPrepared(head, upstreamCommit, status.latest);
}

export async function runUpdateUpstreamCli(
  runMain: () => Promise<void> = main,
  logError: (message: string) => void = console.error,
): Promise<number> {
  try {
    await runMain();
    return 0;
  } catch (error) {
    logError(error instanceof Error ? error.message : "Upstream preparation failed");
    return 1;
  }
}

if (isDirectRun(process.argv[1])) {
  process.exitCode = await runUpdateUpstreamCli();
}
