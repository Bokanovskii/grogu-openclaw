import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { admitRollingPullRequests } from "./upstream-pr.js";
import { checkUpstream } from "./upstream.js";
import { archiveUpstreamWorkflows } from "./workflows.js";

const execute = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branch = "grogu/upstream";
const root = process.cwd();

async function run(bin: string, args: string[]) {
  // Upstream-controlled hook files must never run while the writer holds a push token.
  const argv = bin === "git" ? ["-c", "core.hooksPath=/dev/null", ...args] : args;
  const { stdout } = await execute(bin, argv, {
    cwd: root,
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
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

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_REPOSITORY) {
    throw new Error("The rolling-update writer runs only in its isolated private Actions checkout");
  }
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
  await run("git", ["switch", "-c", "grogu/upstream-candidate"]);
  await run("git", [
    "fetch",
    "--no-tags",
    `https://github.com/${status.upstream}.git`,
    `refs/tags/${status.latest}`,
  ]);
  const upstreamCommit = sha.parse(await run("git", ["rev-parse", "FETCH_HEAD^{commit}"]));
  const canonicalCommit = sha.parse(
    await run("gh", ["api", `repos/${status.upstream}/commits/${status.latest}`, "--jq", ".sha"]),
  );
  if (upstreamCommit !== canonicalCommit) {
    throw new Error(
      "The fetched release differs from its canonical commit; do not publish a candidate",
    );
  }
  await run("git", ["merge-base", "--is-ancestor", status.pinnedCommit, upstreamCommit]);
  try {
    await run("git", ["merge", "--no-commit", "--no-ff", upstreamCommit]);
  } catch (error) {
    const conflicts = await run("git", ["diff", "--name-only", "--diff-filter=U"]);
    throw new Error(
      `Upstream integration needs explicit conflict resolution; remote branch and production unchanged. Conflicts: ${conflicts}`,
      { cause: error },
    );
  }
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
  await run("git", ["commit", "--no-verify", "-m", `chore: integrate upstream ${status.latest}`]);
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Upstream preparation failed");
  process.exitCode = 1;
}
