import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installUsageDashboard,
  rollbackUsageDashboard,
  updatePublisherSource,
} from "./publisher-install.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "usage-publisher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const assets = path.join(source, "grogu", "usage-dashboard");
  const state = path.join(root, "state");
  const setup = path.join(state, "setup");
  const core = path.join(root, "core");
  const sdk = path.join(core, "dist", "plugin-sdk");
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  mkdirSync(setup, { recursive: true, mode: 0o700 });
  mkdirSync(sdk, { recursive: true, mode: 0o700 });
  for (const name of [
    "usage-data.mjs",
    "usage-html.mjs",
    "usage-client.js",
    "usage.css",
    "publisher-install.mjs",
  ]) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), path.join(assets, name));
  }
  writeFileSync(path.join(core, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(sdk, "file-lock.js"),
    `export async function withFileLock(target, options, operation) {
      if (!target.endsWith("/personal-dashboard-publisher") ||
          options.stale !== 0 || options.retries.retries !== 0 ||
          options.staleRecovery !== "remove-if-definitely-stale") {
        throw new Error("Wrong publisher lock contract");
      }
      return operation();
    }`,
  );
  const original = `import { summarizeDailyUsage, summarizeUsage, sessionUsageLinks, usageParameters } from "./personal-dashboard-usage.mjs";
import { usageHtml } from "./personal-dashboard-html.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const CORE = ${JSON.stringify(core)};
const TARGET = "fixed-target";
function render(data, catalog, parameters, usageUrl) {
  return usageHtml({}, sessionUsageLinks(data, catalog, parameters, usageUrl));
}
`;
  const publisher = path.join(setup, "personal-dashboard-usage-only.mjs");
  writeFileSync(publisher, original, { mode: 0o600 });
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  git("add", "grogu/usage-dashboard");
  git(
    "-c",
    "user.name=Usage Test",
    "-c",
    "user.email=usage-test@example.test",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Synthetic usage fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
  );
  return { root, source, state, setup, core, publisher, original, git };
}

test("installs a committed bundle under the publisher lock and rolls it back exactly", async (t) => {
  const { source, state, setup, core, publisher, original } = fixture(t);
  const options = { sourceRoot: source, stateDir: state, coreDir: core };
  const preview = await installUsageDashboard(options);
  assert.equal(preview.applied, false);
  assert.equal(preview.changed, true);
  assert.equal(readFileSync(publisher, "utf8"), original);
  assert.equal(existsSync(path.join(setup, `usage-dashboard-${preview.bundleSha256}`)), false);

  const installed = await installUsageDashboard({ ...options, apply: true });
  assert.equal(installed.changed, true);
  assert.equal(installed.bundleSha256, preview.bundleSha256);
  const updated = readFileSync(publisher, "utf8");
  assert.match(updated, new RegExp(`usage-dashboard-${installed.bundleSha256}/usage-data\\.mjs`));
  assert.match(
    updated,
    /sessionUsageLinks\(data, catalog, parameters, usageUrl, buildControlUiSessionPath\)/,
  );
  assert.match(updated, /const TARGET = "fixed-target";/);
  const backup = path.join(setup, "usage-dashboard-backups", `${installed.backupSha256}.mjs`);
  assert.equal(readFileSync(backup, "utf8"), original);
  assert.deepEqual(
    readdirSync(path.join(setup, `usage-dashboard-${installed.bundleSha256}`)).toSorted(),
    ["usage-client.js", "usage-data.mjs", "usage-html.mjs", "usage.css"],
  );
  const again = await installUsageDashboard({ ...options, apply: true });
  assert.equal(again.changed, false);
  assert.equal(readdirSync(path.join(setup, "usage-dashboard-backups")).length, 1);
  await assert.rejects(
    rollbackUsageDashboard({
      stateDir: state,
      coreDir: core,
      backupSha256: installed.backupSha256,
      expectedPublisherSha256: "0".repeat(64),
    }),
    /rollback refused/,
  );
  assert.equal(readFileSync(publisher, "utf8"), updated);
  const restored = await rollbackUsageDashboard({
    stateDir: state,
    coreDir: core,
    backupSha256: installed.backupSha256,
    expectedPublisherSha256: installed.publisherSha256,
  });
  assert.equal(restored.rolledBack, true);
  assert.equal(readFileSync(publisher, "utf8"), original);
});

test("refuses dirty or hidden modifications to a committed source", async (t) => {
  const { source, state, core, git } = fixture(t);
  const file = path.join(source, "grogu", "usage-dashboard", "usage.css");
  writeFileSync(file, "changed");
  const options = { sourceRoot: source, stateDir: state, coreDir: core, apply: true };
  await assert.rejects(installUsageDashboard(options), /clean Usage dashboard source/);
  git("update-index", "--assume-unchanged", "grogu/usage-dashboard/usage.css");
  await assert.rejects(installUsageDashboard(options), /differs from its committed files/);
});

test("rejects unexpected publisher contracts rather than rewriting them", async (t) => {
  const { source, state, core, publisher, original } = fixture(t);
  const unexpected = original.replace("./personal-dashboard-html.mjs", "./different-renderer.mjs");
  writeFileSync(publisher, unexpected);
  await assert.rejects(
    installUsageDashboard({ sourceRoot: source, stateDir: state, coreDir: core, apply: true }),
    /supported contract/,
  );
  assert.equal(readFileSync(publisher, "utf8"), unexpected);
  assert.throws(() => updatePublisherSource(original, "not-a-digest"), /Invalid Usage/);
});

test("refuses a symlinked publisher and does not write its target", async (t) => {
  const { root, source, state, core, publisher, original } = fixture(t);
  const target = path.join(root, "publisher-target.mjs");
  writeFileSync(target, original, { mode: 0o600 });
  unlinkSync(publisher);
  symlinkSync(target, publisher);
  await assert.rejects(
    installUsageDashboard({ sourceRoot: source, stateDir: state, coreDir: core, apply: true }),
    /ELOOP/,
  );
  assert.equal(readFileSync(target, "utf8"), original);
});

test("honors lock refusal and rejects a tampered installed bundle", async (t) => {
  const first = fixture(t);
  writeFileSync(
    path.join(first.core, "dist", "plugin-sdk", "file-lock.js"),
    'export async function withFileLock() { throw new Error("publisher busy"); }',
  );
  await assert.rejects(
    installUsageDashboard({
      sourceRoot: first.source,
      stateDir: first.state,
      coreDir: first.core,
      apply: true,
    }),
    /publisher busy/,
  );
  assert.equal(readFileSync(first.publisher, "utf8"), first.original);
  assert.equal(existsSync(path.join(first.setup, "usage-dashboard-backups")), false);

  const second = fixture(t);
  const options = {
    sourceRoot: second.source,
    stateDir: second.state,
    coreDir: second.core,
    apply: true,
  };
  const installed = await installUsageDashboard(options);
  const installedPublisher = readFileSync(second.publisher, "utf8");
  writeFileSync(
    path.join(second.setup, `usage-dashboard-${installed.bundleSha256}`, "usage.css"),
    "tampered",
  );
  await assert.rejects(installUsageDashboard(options), /differs from its content digest/);
  assert.equal(readFileSync(second.publisher, "utf8"), installedPublisher);
});
