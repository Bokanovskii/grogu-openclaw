import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function serviceHome(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "protected-bootstrap-"));
  const stateDir = path.join(home, "state");
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(stateDir, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(home, "config", "openclaw.json"),
  };
  const workspace = path.join(stateDir, "workspace");
  const bootstrap = path.join(workspace, "BOOTSTRAP.md");
  const node = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "./scripts/tsx.mjs", ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
  const workspaceScript = (body: string) => {
    const result = node([
      "--input-type=module",
      "--eval",
      `const w = await import("./src/agents/workspace.js");
       const dir = ${JSON.stringify(workspace)};
       ${body}
       process.exit(0);`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return {
    stateDir,
    workspace,
    bootstrap,
    retire: () => node(["grogu/protected/maintain.ts", "retire-bootstrap"]),
    // Older protected releases seeded the shared workspace through this path.
    seedLegacyWorkspace: () =>
      workspaceScript("await w.ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });"),
    skipBootstrapRun: () =>
      workspaceScript(`
        await w.ensureAgentWorkspace({ dir, ensureBootstrapFiles: false });
        process.stdout.write(await w.resolveWorkspaceBootstrapStatus(dir));`),
  };
}

void test("retire-bootstrap removes only the generated default and child runs continue", async (t) => {
  const service = await serviceHome(t);
  const absent = service.retire();
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "No workspace BOOTSTRAP.md to retire.\n");

  service.seedLegacyWorkspace();
  const agents = await fs.readFile(path.join(service.workspace, "AGENTS.md"), "utf8");
  await fs.access(service.bootstrap);
  assert.equal(service.skipBootstrapRun(), "pending");

  const listener = await acquireProtectedStateOwner(service.stateDir);
  assert.ok(listener);
  try {
    const refused = service.retire();
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stderr, "Stop the listener before retiring the workspace bootstrap.\n");
    await fs.access(service.bootstrap);
  } finally {
    listener.release();
  }

  const retired = service.retire();
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(retired.stdout, "Generated workspace BOOTSTRAP.md retired.\n");
  await assert.rejects(fs.access(service.bootstrap), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(service.workspace, "AGENTS.md"), "utf8"), agents);
  assert.equal(service.skipBootstrapRun(), "complete");
  await assert.rejects(fs.access(service.bootstrap), { code: "ENOENT" });

  const repeated = service.retire();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, "No workspace BOOTSTRAP.md to retire.\n");
});

void test("retire-bootstrap keeps customized or linked files without printing them", async (t) => {
  const service = await serviceHome(t);
  service.seedLegacyWorkspace();
  const generated = await fs.readFile(service.bootstrap, "utf8");
  const refusal = "Workspace BOOTSTRAP.md is not the generated default; it was kept.\n";

  const customized = `${generated}\nprivate-onboarding-note\n`;
  await fs.writeFile(service.bootstrap, customized);
  const edited = service.retire();
  assert.notEqual(edited.status, 0);
  assert.equal(edited.stderr, refusal);
  assert.equal(edited.stdout, "");
  assert.equal(await fs.readFile(service.bootstrap, "utf8"), customized);

  const outside = path.join(path.dirname(service.stateDir), "outside.md");
  await fs.writeFile(outside, generated);
  await fs.rm(service.bootstrap);
  await fs.symlink(outside, service.bootstrap);
  const linked = service.retire();
  assert.notEqual(linked.status, 0);
  assert.equal(linked.stderr, refusal);
  assert.ok((await fs.lstat(service.bootstrap)).isSymbolicLink());
  assert.equal(await fs.readFile(outside, "utf8"), generated);
});
