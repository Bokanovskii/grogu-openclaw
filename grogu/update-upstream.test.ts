import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  analyzeMergeTree,
  assertWriterEnvironment,
  isDirectRun,
  registerAndFetchUpstreamRelease,
  runUpdateUpstreamCli,
  settleMergeOutcome,
} from "./update-upstream.mjs";

const upstreamCommit = "7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be";
const execute = promisify(execFile);
const scratchRoot = path.join(process.cwd(), ".artifacts");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function commandRunner(cwd: string) {
  return async (bin: string, args: string[]) => {
    const { stdout } = await execute(bin, args, {
      cwd,
      env: gitEnv,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await commandRunner(cwd)("git", args)).trim();
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Upstream Test",
    "commit",
    "-qm",
    message,
  ]);
}

async function createPromisorTopology(scenario: "conflict" | "clean") {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, "upstream-promisor-"));
  const upstream = path.join(directory, "upstream");
  const origin = path.join(directory, "origin");
  const checkout = path.join(directory, "checkout");
  await git(directory, ["init", "-q", "-b", "main", upstream]);
  await git(upstream, ["config", "uploadpack.allowFilter", "true"]);
  await git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(upstream, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  await writeFile(
    path.join(upstream, "shared.txt"),
    `${Array.from({ length: 40 }, (_, index) => index + 1).join("\n")}\n`,
  );
  await git(upstream, ["add", "."]);
  await commit(upstream, "base");
  await git(upstream, ["tag", "v1"]);
  await writeFile(
    path.join(upstream, "shared.txt"),
    `${["1", "upstream-change", ...Array.from({ length: 38 }, (_, index) => index + 3)].join("\n")}\n`,
  );
  await git(upstream, ["add", "."]);
  await commit(upstream, "upstream");
  await git(upstream, ["tag", "v2"]);

  await git(directory, ["init", "-q", "-b", "main", origin]);
  await git(origin, ["config", "uploadpack.allowFilter", "true"]);
  await git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(origin, ["fetch", "-q", pathToFileURL(upstream).href, "refs/tags/v1:refs/tags/v1"]);
  await git(origin, ["checkout", "-q", "-B", "main", "v1"]);
  const lines = Array.from({ length: 40 }, (_, index) => String(index + 1));
  lines[scenario === "conflict" ? 1 : 29] =
    scenario === "conflict" ? "grogu-change" : "grogu-change-30";
  await writeFile(path.join(origin, "shared.txt"), `${lines.join("\n")}\n`);
  await writeFile(path.join(origin, "grogu.txt"), "grogu\n");
  await git(origin, ["add", "."]);
  await commit(origin, "grogu");

  await git(directory, [
    "-c",
    "protocol.file.allow=always",
    "clone",
    "-q",
    "--no-local",
    "--filter=blob:none",
    pathToFileURL(origin).href,
    checkout,
  ]);
  return { directory, upstream, checkout };
}

test("reports expected merge conflicts once without entering the clean mutation path", async () => {
  const conflicts = Array.from({ length: 22 }, (_, index) => `src/conflict-${index}.ts`);
  const summaries: string[] = [];
  const logs: string[] = [];
  const outcome = await settleMergeOutcome(
    { kind: "conflicted", conflicts },
    { release: "v2026.10.10", upstreamCommit },
    {
      writeSummary: async (summary) => {
        summaries.push(summary);
      },
      log: (summary) => {
        logs.push(summary);
      },
    },
  );

  assert.deepEqual(outcome, { kind: "conflicted" });
  assert.deepEqual(logs, summaries);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!, /Upstream v2026\.10\.10 needs conflict resolution/);
  assert.match(summaries[0]!, /Upstream commit: `7dc3350cb9f0`/);
  assert.match(summaries[0]!, /Conflicted paths: 22/);
  assert.equal((summaries[0]!.match(/^- `src\/conflict-/gmu) ?? []).length, 20);
  assert.match(summaries[0]!, /- \+2 more/);
  assert.match(
    summaries[0]!,
    /No PR opened, nothing pushed; resolve manually or wait for the next release\./,
  );
});

test("returns the exact prepared tree for the unchanged clean merge path", async () => {
  const outcome = await settleMergeOutcome(
    { kind: "clean", tree: "a".repeat(40) },
    { release: "v2026.10.10", upstreamCommit },
    {
      writeSummary: async () => {
        throw new Error("clean merges must not write a conflict summary");
      },
      log: () => {
        throw new Error("clean merges must not log a conflict summary");
      },
    },
  );

  assert.deepEqual(outcome, { kind: "clean", tree: "a".repeat(40) });
});

test("keeps non-conflict merge failures terminal", async () => {
  const failure = Object.assign(new Error("network failed"), { code: 128 });
  const messages: string[] = [];
  const exitCode = await runUpdateUpstreamCli(
    async () => {
      await analyzeMergeTree("b".repeat(40), upstreamCommit, async () => {
        throw failure;
      });
    },
    (message) => {
      messages.push(message);
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(messages, ["network failed"]);
});

test("keeps a missing upstream token terminal", async () => {
  const messages: string[] = [];
  const exitCode = await runUpdateUpstreamCli(
    async () => {
      assertWriterEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "owner/repository",
      });
    },
    (message) => {
      messages.push(message);
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(messages, ["GROGU_UPSTREAM_TOKEN is required for the rolling-update writer"]);
});

test("rejects malformed conflict paths instead of reporting success", async () => {
  for (const conflicts of [["../private"], ["src/line\nbreak.ts"]]) {
    await assert.rejects(
      settleMergeOutcome(
        { kind: "conflicted", conflicts },
        { release: "v2026.10.10", upstreamCommit },
        {
          writeSummary: async () => {},
          log: () => {},
        },
      ),
      /invalid conflicted path/,
    );
  }
});

test("reports pathless merge conflicts as an expected manual outcome", async () => {
  const summaries: string[] = [];
  const outcome = await settleMergeOutcome(
    { kind: "conflicted", conflicts: [] },
    { release: "v2026.10.10", upstreamCommit },
    {
      writeSummary: async (summary) => {
        summaries.push(summary);
      },
      log: () => {},
    },
  );

  assert.deepEqual(outcome, { kind: "conflicted" });
  assert.equal(summaries.length, 1);
  assert.match(
    summaries[0]!,
    /Conflicted paths: 0 reported by git \(non-file conflict, e\.g\. a directory rename\); inspect the merge manually/,
  );
  assert.match(
    summaries[0]!,
    /No PR opened, nothing pushed; resolve manually or wait for the next release\./,
  );
});

test("persisted upstream promisor supports conflict and clean merge analysis", async () => {
  for (const scenario of ["conflict", "clean"] as const) {
    const topology = await createPromisorTopology(scenario);
    try {
      const runner = commandRunner(topology.checkout);
      await registerAndFetchUpstreamRelease({
        runner,
        remoteName: "grogu-upstream-source",
        upstreamUrl: pathToFileURL(topology.upstream).href,
        tag: "v2",
      });
      assert.equal(
        await git(topology.checkout, ["config", "--get", "remote.grogu-upstream-source.promisor"]),
        "true",
      );
      const base = await git(topology.checkout, ["rev-parse", "HEAD^"]);
      const fetched = await git(topology.checkout, ["rev-parse", "FETCH_HEAD^{commit}"]);
      const result = await analyzeMergeTree(base, fetched, runner);
      if (scenario === "conflict") {
        assert.deepEqual(result, { kind: "conflicted", conflicts: ["shared.txt"] });
      } else {
        assert.equal(result.kind, "clean");
        assert.match(result.tree, /^[a-f0-9]{40}$/);
      }
    } finally {
      await rm(topology.directory, { recursive: true, force: true });
    }
  }
});

test("one-shot promisor configuration reproduces the lazy-fetch failure", async () => {
  for (const scenario of ["conflict", "clean"] as const) {
    const topology = await createPromisorTopology(scenario);
    try {
      const runner = commandRunner(topology.checkout);
      await runner("git", [
        "-c",
        `remote.grogu-upstream-source.url=${pathToFileURL(topology.upstream).href}`,
        "-c",
        "remote.grogu-upstream-source.fetch=",
        "-c",
        "remote.grogu-upstream-source.promisor=true",
        "-c",
        "remote.grogu-upstream-source.partialclonefilter=blob:none",
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "grogu-upstream-source",
        "refs/tags/v2",
      ]);
      const base = await git(topology.checkout, ["rev-parse", "HEAD^"]);
      const fetched = await git(topology.checkout, ["rev-parse", "FETCH_HEAD^{commit}"]);
      await assert.rejects(
        analyzeMergeTree(base, fetched, runner),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { code?: unknown }).code === 128 &&
          /could not fetch .* from promisor remote/.test(error.message),
      );
    } finally {
      await rm(topology.directory, { recursive: true, force: true });
    }
  }
});

test("direct-run guard accepts physical and symlinked entry paths only", async () => {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, "upstream-entry-"));
  const entry = path.join(process.cwd(), "grogu/update-upstream.mts");
  const link = path.join(directory, "update-upstream-link.mts");
  try {
    await symlink(entry, link);
    assert.equal(isDirectRun(entry), true);
    assert.equal(isDirectRun(link), true);
    assert.equal(isDirectRun(import.meta.filename), false);
    assert.equal(isDirectRun("-"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
