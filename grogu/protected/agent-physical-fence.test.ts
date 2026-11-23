import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { acquireProtectedAgentPhysicalFence } from "./agent-physical-fence.js";
import { acquireProtectedStateOwner } from "./state-owner.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const agentWrite = (sql: string) =>
  `runOpenClawAgentWriteTransaction(({ db }) => db.exec(${JSON.stringify(sql)}), { agentId: "protected" });`;
const importWriter = `const { runOpenClawAgentWriteTransaction } = await import("./src/state/openclaw-agent-db.js");`;

async function protectedState(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "protected-fence-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const keyFile = path.join(root, "storage-key");
  await fs.writeFile(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_PROTECTED_STORAGE_KEY_FILE: keyFile,
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    process.env = saved;
    await fs.rm(root, { recursive: true, force: true });
  });
  const foreign = (script: string) =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
  const created = foreign(`${importWriter}\n${agentWrite("CREATE TABLE probe (id INTEGER)")}`);
  assert.equal(created.status, 0, created.stderr);
  return { stateDir, env, foreign };
}

void test("a foreign opener crossing startup is refused and later foreign writes stay out", async (t) => {
  const { stateDir, env, foreign } = await protectedState(t);
  const script = `${importWriter}
    ${agentWrite("INSERT INTO probe VALUES (1)")}
    process.send("ready");
    process.stdin.once("data", () => {
      try {
        ${agentWrite("INSERT INTO probe VALUES (2)")}
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    });`;
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
    { cwd: repoRoot, env, stdio: ["pipe", "ignore", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
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
    await assert.rejects(
      acquireProtectedAgentPhysicalFence({ stateOwner: owner }),
      new RegExp(`still open in process ${child.pid}`, "u"),
    );
    child.stdin?.end("write");
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.match(errors, /exclusively owned by process/u);

    const fence = await acquireProtectedAgentPhysicalFence({ stateOwner: owner });
    const opened = foreign(`${importWriter}\n${agentWrite("INSERT INTO probe VALUES (3)")}`);
    assert.notEqual(opened.status, 0);
    assert.match(opened.stderr, /exclusively owned by process/u);
    await fence.stop();
  } finally {
    owner.release();
  }
  const count = foreign(`${importWriter}
    const { withFreshOpenClawAgentDatabaseReadOnly } = await import("./src/state/openclaw-agent-db-readonly-open.js");
    console.log(withFreshOpenClawAgentDatabaseReadOnly(({ db }) => db.prepare("SELECT count(*) AS n FROM probe").get().n, { agentId: "protected" }).value);`);
  assert.equal(count.stdout.trim(), "1", count.stderr);
});

void test("stop seals admission but keeps the owner until enrolled work settles", async (t) => {
  const { stateDir, foreign } = await protectedState(t);
  const owner = await acquireProtectedStateOwner(stateDir);
  assert.ok(owner);
  const order: string[] = [];
  const fence = await acquireProtectedAgentPhysicalFence({
    stateOwner: owner,
    async recover(recovery) {
      await Promise.resolve();
      recovery.enroll("recovery").settle();
      order.push("recovered");
    },
  });
  order.push("admitted");
  assert.deepEqual(order, ["recovered", "admitted"]);

  // The host enrolled before initiation; the worker never replied.
  const lostReply = fence.enroll("transcript.append");
  const stopping = fence.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(stopped, false);
  assert.throws(() => fence.enroll("late"), /stopping/u);
  assert.throws(() => fence.assert(), /stopping/u);
  assert.deepEqual(fence.unsettled(), ["transcript.append"]);

  owner.release();
  const held = foreign(`${importWriter}\n${agentWrite("INSERT INTO probe VALUES (1)")}`);
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /exclusively owned by process/u);

  lostReply.settle();
  await stopping;
  owner.release();
  const released = foreign(`${importWriter}\n${agentWrite("INSERT INTO probe VALUES (1)")}`);
  assert.equal(released.status, 0, released.stderr);
});

void test("failed recovery never opens admission or releases the owner", async (t) => {
  const { stateDir, foreign } = await protectedState(t);
  const owner = await acquireProtectedStateOwner(stateDir);
  assert.ok(owner);
  await assert.rejects(
    acquireProtectedAgentPhysicalFence({
      stateOwner: owner,
      recover: () => Promise.reject(new Error("custody unreconciled")),
    }),
    /custody unreconciled/u,
  );
  await assert.rejects(
    acquireProtectedAgentPhysicalFence({ stateOwner: owner }),
    /already fenced/u,
  );
  owner.release();
  const held = foreign(`${importWriter}\n${agentWrite("INSERT INTO probe VALUES (1)")}`);
  assert.match(held.stderr, /exclusively owned by process/u);
});

void test("recovery that leaves enrolled work unsettled never opens admission", async (t) => {
  const { stateDir, foreign } = await protectedState(t);
  const owner = await acquireProtectedStateOwner(stateDir);
  assert.ok(owner);
  await assert.rejects(
    acquireProtectedAgentPhysicalFence({
      stateOwner: owner,
      recover: async (recovery) => {
        recovery.enroll("custody.replay");
      },
    }),
    /unsettled work: custody\.replay/u,
  );
  owner.release();
  const held = foreign(`${importWriter}\n${agentWrite("INSERT INTO probe VALUES (1)")}`);
  assert.match(held.stderr, /exclusively owned by process/u);
});
