import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ASSETS = ["usage-data.mjs", "usage-html.mjs", "usage-client.js", "usage.css"];
const DATA_IMPORT =
  /^import \{ summarizeDailyUsage, summarizeUsage, sessionUsageLinks, usageParameters \} from "(\.\/personal-dashboard-usage\.mjs|\.\/usage-dashboard-[a-f0-9]{64}\/usage-data\.mjs)";$/gm;
const HTML_IMPORT =
  /^import \{ usageHtml \} from "(\.\/personal-dashboard-html\.mjs|\.\/usage-dashboard-[a-f0-9]{64}\/usage-html\.mjs)";$/gm;
const ROUTE_BUILDER =
  'const { buildControlUiSessionPath } = await import(pathToFileURL(path.join(CORE, "dist/plugin-sdk/session-discussion.js")).href);';
const CALL_OLD = "sessionUsageLinks(data, catalog, parameters, usageUrl)";
const CALL_NEW =
  "sessionUsageLinks(data, catalog, parameters, usageUrl, buildControlUiSessionPath)";
const HEX = /^[a-f0-9]{64}$/;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedDirectory(directory) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Usage publisher requires an owner-only state directory");
  }
}

function readPrivateFile(file, maximumBytes) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      !process.getuid ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > maximumBytes
    ) {
      throw new Error("Usage publisher file is not a trusted regular file");
    }
    return { bytes: readFileSync(descriptor), mode: stat.mode & 0o777 };
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(file, bytes, mode = 0o600) {
  const descriptor = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(file, { force: true });
    throw error;
  }
  closeSync(descriptor);
}

function replaceAtomically(file, bytes, mode) {
  const temporary = path.join(path.dirname(file), `.usage-publisher-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeExclusive(temporary, bytes, mode);
    created = true;
    renameSync(temporary, file);
  } catch (error) {
    if (created) {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function replaceExactlyOne(source, expression, replacement) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error("The existing Usage publisher no longer matches the supported contract");
  }
  return source.replace(expression, replacement);
}

export function updatePublisherSource(source, digest) {
  if (!HEX.test(digest)) {
    throw new Error("Invalid Usage dashboard bundle digest");
  }
  let next = replaceExactlyOne(
    source,
    DATA_IMPORT,
    `import { summarizeDailyUsage, summarizeUsage, sessionUsageLinks, usageParameters } from "./usage-dashboard-${digest}/usage-data.mjs";`,
  );
  next = replaceExactlyOne(
    next,
    HTML_IMPORT,
    `import { usageHtml } from "./usage-dashboard-${digest}/usage-html.mjs";`,
  );
  const builders = next.split(ROUTE_BUILDER).length - 1;
  if (builders === 0) {
    if (next.includes("buildControlUiSessionPath")) {
      throw new Error("Unexpected session route builder in existing Usage publisher");
    }
    next = replaceExactlyOne(next, /^(const CORE = "[^"\n]+";)$/gm, `$1\n${ROUTE_BUILDER}`);
  } else if (builders !== 1) {
    throw new Error("Unexpected duplicate session route builder in Usage publisher");
  }
  const calls = next.split(CALL_OLD).length - 1;
  const updatedCalls = next.split(CALL_NEW).length - 1;
  if (calls === 1 && updatedCalls === 0) {
    next = next.replace(CALL_OLD, CALL_NEW);
  } else if (calls !== 0 || updatedCalls !== 1) {
    throw new Error("The existing Usage publisher has an unsupported session projection");
  }
  return next;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function readCommittedBundle(sourceRoot, stateDir) {
  if (!path.isAbsolute(sourceRoot)) {
    throw new Error("Usage dashboard source must be an absolute Git worktree");
  }
  const root = realpathSync(sourceRoot);
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).trim();
  if (
    git(["rev-parse", "--show-toplevel"]) !== root ||
    contains(root, stateDir) ||
    contains(stateDir, root)
  ) {
    throw new Error("Usage dashboard source must be isolated from the live state directory");
  }
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit) || git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Commit and review a clean Usage dashboard source before installation");
  }
  const bundleHash = createHash("sha256");
  const assets = [...ASSETS, "publisher-install.mjs"]
    .map((name) => {
      const file = path.join(root, "grogu", "usage-dashboard", name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error("Usage dashboard bundle contains an invalid source file");
      }
      const bytes = readFileSync(file);
      const committed = execFileSync("git", ["show", `${commit}:grogu/usage-dashboard/${name}`], {
        cwd: root,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (!bytes.equals(committed)) {
        throw new Error("Usage dashboard source differs from its committed files");
      }
      if (name !== "publisher-install.mjs") {
        bundleHash.update(name).update("\0").update(bytes).update("\0");
      }
      return { name, bytes };
    })
    .filter((asset) => asset.name !== "publisher-install.mjs");
  if (
    git(["rev-parse", "HEAD"]) !== commit ||
    git(["status", "--porcelain", "--untracked-files=all"])
  ) {
    throw new Error("Usage dashboard source changed while it was inspected");
  }
  return { root, commit, digest: bundleHash.digest("hex"), assets };
}

function statePaths(stateDir) {
  if (!path.isAbsolute(stateDir)) {
    throw new Error("Usage publisher state directory must be absolute");
  }
  checkedDirectory(stateDir);
  const state = realpathSync(stateDir);
  const setup = path.join(state, "setup");
  checkedDirectory(setup);
  return {
    state,
    setup,
    publisher: path.join(setup, "personal-dashboard-usage-only.mjs"),
    lock: path.join(setup, "personal-dashboard-publisher"),
    backups: path.join(setup, "usage-dashboard-backups"),
  };
}

function validatePublisherRuntime(source, coreDir) {
  const coreMatch = /^const CORE = ("[^"\n]+");$/m.exec(source);
  if (!coreMatch || realpathSync(JSON.parse(coreMatch[1])) !== realpathSync(coreDir)) {
    throw new Error("Usage publisher runtime does not match the requested lock runtime");
  }
}

async function withPublisherLock(coreDir, lock, operation) {
  if (!path.isAbsolute(coreDir)) {
    throw new Error("Usage publisher runtime must be absolute");
  }
  const moduleUrl = pathToFileURL(path.join(realpathSync(coreDir), "dist/plugin-sdk/file-lock.js"));
  const { withFileLock } = await import(moduleUrl.href);
  return withFileLock(
    lock,
    { stale: 0, retries: { retries: 0 }, staleRecovery: "remove-if-definitely-stale" },
    operation,
  );
}

function ensureBackup(paths, previous) {
  try {
    mkdirSync(paths.backups, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  checkedDirectory(paths.backups);
  const digest = hash(previous);
  const destination = path.join(paths.backups, `${digest}.mjs`);
  try {
    writeExclusive(destination, previous);
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      hash(readPrivateFile(destination, 1024 * 1024).bytes) !== digest
    ) {
      throw error;
    }
  }
  return digest;
}

function ensureBundle(paths, bundle) {
  const destination = path.join(paths.setup, `usage-dashboard-${bundle.digest}`);
  try {
    checkedDirectory(destination);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const temporary = path.join(paths.setup, `.usage-dashboard-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      for (const asset of bundle.assets) {
        writeExclusive(path.join(temporary, asset.name), asset.bytes);
      }
      renameSync(temporary, destination);
    } catch (failure) {
      rmSync(temporary, { recursive: true, force: true });
      throw failure;
    }
    checkedDirectory(destination);
  }
  for (const asset of bundle.assets) {
    if (
      !readPrivateFile(path.join(destination, asset.name), 1024 * 1024).bytes.equals(asset.bytes)
    ) {
      throw new Error("An existing Usage dashboard bundle differs from its content digest");
    }
  }
}

export async function installUsageDashboard({ sourceRoot, stateDir, coreDir, apply = false }) {
  const paths = statePaths(stateDir);
  const bundle = readCommittedBundle(sourceRoot, paths.state);
  const inspect = () => {
    const previous = readPrivateFile(paths.publisher, 1024 * 1024);
    const source = previous.bytes.toString("utf8");
    validatePublisherRuntime(source, coreDir);
    const next = Buffer.from(updatePublisherSource(source, bundle.digest));
    execFileSync(process.execPath, ["--check", "--input-type=module"], {
      input: next,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { previous, next };
  };
  if (!apply) {
    const { previous, next } = inspect();
    return {
      applied: false,
      sourceCommit: bundle.commit,
      bundleSha256: bundle.digest,
      changed: !previous.bytes.equals(next),
    };
  }
  return withPublisherLock(coreDir, paths.lock, async () => {
    const { previous, next } = inspect();
    if (previous.bytes.equals(next)) {
      ensureBundle(paths, bundle);
      return {
        applied: true,
        changed: false,
        sourceCommit: bundle.commit,
        bundleSha256: bundle.digest,
        publisherSha256: hash(next),
      };
    }
    ensureBundle(paths, bundle);
    const backupSha256 = ensureBackup(paths, previous.bytes);
    if (!readPrivateFile(paths.publisher, 1024 * 1024).bytes.equals(previous.bytes)) {
      throw new Error("The Usage publisher changed during installation");
    }
    replaceAtomically(paths.publisher, next, previous.mode);
    return {
      applied: true,
      changed: true,
      sourceCommit: bundle.commit,
      bundleSha256: bundle.digest,
      backupSha256,
      publisherSha256: hash(next),
    };
  });
}

export async function rollbackUsageDashboard({
  stateDir,
  coreDir,
  backupSha256,
  expectedPublisherSha256,
}) {
  if (!HEX.test(backupSha256) || !HEX.test(expectedPublisherSha256)) {
    throw new Error("Usage publisher rollback requires exact SHA-256 digests");
  }
  const paths = statePaths(stateDir);
  return withPublisherLock(coreDir, paths.lock, async () => {
    checkedDirectory(paths.backups);
    const current = readPrivateFile(paths.publisher, 1024 * 1024);
    const backup = readPrivateFile(path.join(paths.backups, `${backupSha256}.mjs`), 1024 * 1024);
    validatePublisherRuntime(current.bytes.toString("utf8"), coreDir);
    validatePublisherRuntime(backup.bytes.toString("utf8"), coreDir);
    if (hash(current.bytes) !== expectedPublisherSha256 || hash(backup.bytes) !== backupSha256) {
      throw new Error("Usage publisher rollback refused a changed publisher or backup");
    }
    if (!readPrivateFile(paths.publisher, 1024 * 1024).bytes.equals(current.bytes)) {
      throw new Error("The Usage publisher changed during rollback");
    }
    replaceAtomically(paths.publisher, backup.bytes, current.mode);
    return { rolledBack: true, publisherSha256: backupSha256 };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.umask(0o077);
    const { values } = parseArgs({
      options: {
        source: { type: "string" },
        state: { type: "string" },
        core: { type: "string" },
        apply: { type: "boolean", default: false },
        rollback: { type: "string" },
        expected: { type: "string" },
      },
    });
    if (!values.state || !values.core) {
      throw new Error("--state and --core are required");
    }
    if (values.rollback) {
      if (!values.apply || !values.expected) {
        throw new Error("Rollback requires --apply and --expected");
      }
      console.log(
        JSON.stringify(
          await rollbackUsageDashboard({
            stateDir: values.state,
            coreDir: values.core,
            backupSha256: values.rollback,
            expectedPublisherSha256: values.expected,
          }),
        ),
      );
    } else {
      if (
        !values.source ||
        realpathSync(fileURLToPath(import.meta.url)) !==
          path.join(realpathSync(values.source), "grogu/usage-dashboard/publisher-install.mjs")
      ) {
        throw new Error("--source must identify this installer's own Git worktree");
      }
      console.log(
        JSON.stringify(
          await installUsageDashboard({
            sourceRoot: values.source,
            stateDir: values.state,
            coreDir: values.core,
            apply: values.apply,
          }),
        ),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Usage dashboard installation failed");
    process.exitCode = 1;
  }
}
