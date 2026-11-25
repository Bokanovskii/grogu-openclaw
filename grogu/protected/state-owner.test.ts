import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertStateDatabaseAccessAllowed } from "../../src/infra/gateway-state-owner.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { listProtectedAdmissions } from "./admission-store.js";
import { sparkyRef } from "./settings.js";
import { acquireProtectedStateOwner } from "./state-owner.js";
import { useTestStorageKey } from "./storage-key.test-support.js";

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "protected-owner-"));
  const stateDir = path.join(home, "state");
  const configDir = path.join(home, "config");
  const runtimePath = path.join(configDir, "protected.json");
  const secretsDir = path.join(home, "secrets");
  await fs.mkdir(secretsDir, { mode: 0o700 });
  const scope = await useTestStorageKey(t, stateDir, path.join(secretsDir, "storage-key"));
  scope.defer(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(configDir, { mode: 0o700 });
  const issuer = "https://synthetic.cloudflareaccess.com";
  const subject = "00000000-0000-4000-8000-000000000001";
  const settings = {
    origin: "https://chat.bokanovski.com",
    port: 19789,
    accessIssuer: issuer,
    accessAudience: "a".repeat(64),
    stateDir,
    allowedSubjects: [],
    sparkySecret: sparkyRef,
    storageLimits: { userBytes: 1024, globalBytes: 4096, freeFloorBytes: 1 },
  };
  await fs.writeFile(runtimePath, JSON.stringify(settings), { mode: 0o600 });
  await fs.writeFile(path.join(configDir, "openclaw.json"), "{}", { mode: 0o600 });
  const addSubject = () =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "add-subject", subject],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
        },
        encoding: "utf8",
      },
    );
  const first = await acquireProtectedStateOwner(stateDir);
  assert.ok(first);
  try {
    assert.equal(await acquireProtectedStateOwner(stateDir), undefined);
    assertStateDatabaseAccessAllowed(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );

    for (const script of [sharedStateWrite, transcriptWrite]) {
      const refused = runForeignProcess(stateDir, script);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /exclusively owned by process/u);
    }

    const refused = addSubject();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Stop the listener before adding a subject\./u);
    first.assertCurrent();
    assert.deepEqual(JSON.parse(await fs.readFile(runtimePath, "utf8")), settings);
  } finally {
    first.release();
  }

  assert.equal(runForeignProcess(stateDir, sharedStateWrite).status, 0);
  const released = runForeignProcess(stateDir, transcriptWrite);
  assert.doesNotMatch(released.stderr, /exclusively owned by process/u);
  const admitted = addSubject();
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /Alcove admission is recorded/u);
  assert.deepEqual(
    (await listProtectedAdmissions(stateDir)).map((entry) => entry.subject),
    [subject],
  );
  assert.deepEqual(JSON.parse(await fs.readFile(runtimePath, "utf8")), settings);
  const restarted = await acquireProtectedStateOwner(stateDir);
  assert.ok(restarted, "maintenance releases the native owner before a listener restarts");
  restarted.release();
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
