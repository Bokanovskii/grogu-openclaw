import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

void test("maintenance returns only recent numeric turn timing fields", async (t) => {
  const home = path.resolve(".artifacts", `protected-timing-${randomUUID()}`);
  const stateDir = path.join(home, "state");
  await mkdir(path.join(stateDir, "logs"), { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const records = Array.from({ length: 25 }, (_, accessChecks) =>
    JSON.stringify({
      admissionMs: 1,
      providerRequestStartMs: 2,
      firstProviderOutputMs: null,
      firstClientVisibleOutputMs: 3,
      accessChecks,
      accessValidationMs: 4,
      completionMs: 5,
      privateText: "do-not-export",
    }),
  );
  await writeFile(
    path.join(stateDir, "logs", "runtime.stdout.log"),
    `${records.map((record) => `[protected-turn-timing] ${record}`).join("\n")}\n` +
      '[protected-turn-timing] {"admissionMs":"private text"}\n',
  );
  const run = () =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "turn-timings"],
      {
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(home, "config", "openclaw.json"),
        },
        encoding: "utf8",
      },
    );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private|do-not-export/u);
  const returned = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(returned.length, 20);
  assert.equal(returned[0].accessChecks, 5);
  assert.equal(returned[19].accessChecks, 24);
  assert.deepEqual(Object.keys(returned[0]), [
    "admissionMs",
    "providerRequestStartMs",
    "firstProviderOutputMs",
    "firstClientVisibleOutputMs",
    "accessChecks",
    "accessValidationMs",
    "completionMs",
  ]);
  await writeFile(path.join(stateDir, "logs", "runtime.stdout.log"), "unrelated log text\n");
  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
});
