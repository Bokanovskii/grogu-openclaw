import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeStartupFailure } from "./startup-failure.js";

const fakeToken = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

void test("startup failure line names each cause and withholds secrets and content", () => {
  class ChildOwnershipError extends Error {}
  let parseError: unknown;
  try {
    JSON.parse("private member words");
  } catch (error) {
    parseError = error;
  }
  const storage = Object.assign(
    new Error(`open failed token=${fakeToken}\u001b[31m\nnext line`, { cause: parseError }),
    { code: "SQLITE_CANTOPEN" },
  );
  const line = describeStartupFailure(
    new ChildOwnershipError("Child ownership is ambiguous.", { cause: storage }),
  );
  const parts = line.split(" <- caused by ");
  assert.equal(parts.length, 3);
  assert.match(
    parts[0] ?? "",
    /^Startup failure: ChildOwnershipError \(Error\): Child ownership is ambiguous\. \(at .*startup-failure\.test\.ts:\d+:\d+\)/u,
  );
  assert.match(
    parts[1] ?? "",
    /^Error \[SQLITE_CANTOPEN\]: open failed token=\S+ next line \(at /u,
  );
  assert.match(parts[2] ?? "", /^SyntaxError: input is not valid JSON \(input withheld\) \(at /u);
  assert.doesNotMatch(line, /private me|abcdefghijklmnop|[\n\p{Cc}]/u);

  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  assert.equal(describeStartupFailure(first).split(" <- caused by ").length, 2);

  let deep: Error = new Error("x".repeat(100_000));
  for (let index = 0; index < 8; index += 1) {
    deep = new Error("y".repeat(100_000), { cause: deep });
  }
  const bounded = describeStartupFailure(deep);
  assert.ok(bounded.length <= 4_000);
  assert.equal(bounded.split(" <- caused by ").length, 5);
  assert.ok(bounded.endsWith(" <- further causes omitted"));

  assert.equal(describeStartupFailure("private member words"), "Startup failure: non-Error string");
});

void test("runtime startup failure writes the guidance line and a detail line", async (t) => {
  const home = path.resolve(".artifacts", `protected-startup-${randomUUID()}`);
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  const config = path.join(home, "protected.json");
  await writeFile(config, `private member words ${fakeToken}`, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "grogu/protected/main.ts", config],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(
    lines[0],
    "Protected runtime initialization failed. Check isolated runtime configuration.",
  );
  assert.match(
    lines[1] ?? "",
    /^Startup failure: SyntaxError: input is not valid JSON \(input withheld\) \(at JSON\.parse .+; at readSettingsJson /u,
  );
  assert.equal(lines.length, 2);
  assert.doesNotMatch(result.stderr, /private me|abcdefghijklmnop/u);
});

void test("maintenance prints a bounded, redacted tail of the runtime stderr log", async (t) => {
  const home = path.resolve(".artifacts", `protected-startup-log-${randomUUID()}`);
  const logs = path.join(home, "state", "logs");
  const log = path.join(logs, "runtime.stderr.log");
  await mkdir(logs, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = () =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "grogu/protected/maintain.ts", "startup-log"],
      {
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "config", "openclaw.json"),
        },
        encoding: "utf8",
      },
    );
  const old = Array.from(
    { length: 10_000 },
    (_, index) => `old line ${String(index).padStart(5, "0")}`,
  );
  const content = `${old.join("\n")}\nStartup failure: Error: token=${fakeToken} \u001b[31mred\u001b[0m\n\tat frame\n`;
  const cut = content.length - 64 * 1024;
  assert.notEqual(content[cut - 1], "\n", "The fixture must cut the tail inside a line.");
  await writeFile(log, content);

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
  const lines = result.stdout.split("\n");
  assert.match(lines[0] ?? "", /^old line \d{5}$/u);
  assert.match(result.stdout, /\nStartup failure: Error: token=\S+ \[31mred\[0m\n\tat frame\n$/u);
  assert.doesNotMatch(result.stdout, /abcdefghijklmnop/u);
  assert.ok(!result.stdout.includes("\u001b"));

  const outside = path.join(home, "outside.txt");
  await writeFile(outside, "outside service file\n");
  for (const makeLink of [symlink, link]) {
    await rm(log);
    await makeLink(outside, log);
    const refused = run();
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      "The runtime stderr log is not a regular file; it was not read.\n",
    );
  }
});
