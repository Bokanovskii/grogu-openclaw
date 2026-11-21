import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertStateDatabaseAccessAllowed } from "../../src/infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function runForeignProcess(stateDir: string, script: string) {
  return spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
    { cwd: repoRoot, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, encoding: "utf8" },
  );
}

const sharedStateWrite = `
  const { runOpenClawStateWriteTransaction } = await import("./src/state/openclaw-state-db.js");
  runOpenClawStateWriteTransaction((database) => database.db.exec("CREATE TABLE IF NOT EXISTS owner_probe (id INTEGER)"), {});
`;

// The canonical agent transcript write that recovery's deletion races with.
const transcriptWrite = `
  const { appendTranscriptEvent } = await import("./src/config/sessions/session-accessor.js");
  await appendTranscriptEvent(
    { agentId: "protected", env: process.env, sessionId: "00000000-0000-4000-8000-000000000000", sessionKey: "agent:protected:family:p:probe" },
    { type: "custom", id: "probe" },
  );
`;

void test("the service owner excludes foreign-process state writes until released", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "protected-owner-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const first = await acquireProtectedStateOwner(stateDir);
  assert.ok(first);
  assert.equal(await acquireProtectedStateOwner(stateDir), undefined);
  assertStateDatabaseAccessAllowed(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
  );

  for (const script of [sharedStateWrite, transcriptWrite]) {
    const refused = runForeignProcess(stateDir, script);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /exclusively owned by process/u);
  }

  first.release();
  assert.equal(runForeignProcess(stateDir, sharedStateWrite).status, 0);
  const released = runForeignProcess(stateDir, transcriptWrite);
  assert.doesNotMatch(released.stderr, /exclusively owned by process/u);
});

void test("the service owner excludes an already-open foreign agent writer", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "protected-owner-open-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const script = `
    const { runOpenClawAgentWriteTransaction } = await import("./src/state/openclaw-agent-db.js");
    const options = { agentId: "protected" };
    runOpenClawAgentWriteTransaction(({ db }) => db.exec("CREATE TABLE IF NOT EXISTS owner_probe (id INTEGER)"), options);
    process.send("ready");
    process.stdin.once("data", () => {
      try {
        runOpenClawAgentWriteTransaction(({ db }) => db.exec("INSERT INTO owner_probe VALUES (1)"), options);
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
    {
      cwd: repoRoot,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["pipe", "ignore", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  });
  const exited = once(child, "exit");
  let errors = "";
  assert.ok(child.stderr && child.stdin);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    errors += chunk;
  });
  const [ready] = await Promise.race([
    once(child, "message"),
    exited.then(([code]) => {
      throw new Error(`Foreign writer exited before readiness (${code}): ${errors}`);
    }),
  ]);
  assert.equal(ready, "ready");
  const owner = await acquireProtectedStateOwner(stateDir);
  assert.ok(owner);
  try {
    child.stdin.end("write");
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.match(errors, /exclusively owned by process/u);
  } finally {
    owner.release();
  }
});
