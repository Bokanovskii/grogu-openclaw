import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withEnv } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { createNestedGitEnv } from "./helpers/temp-repo.js";
import { installTestEnv } from "./test-env.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gitConfig = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "openclaw.fixture",
  GIT_CONFIG_VALUE_0: "fixture-value",
  GIT_CONFIG_KEY_9: "openclaw.orphan",
  GIT_CONFIG_VALUE_9: "orphan-value",
  git_config_value_7: "orphan-lowercase-value",
  GIT_CONFIG_PARAMETERS: "'openclaw.parameter=fixture-parameter'",
};

it.each(["live-aware", "hermetic"] as const)(
  "isolates and restores inherited Git configuration in non-live %s mode",
  (mode) => {
    const root = tempDirs.make("openclaw-git-config-isolation-");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const globalConfig = path.join(root, "gitconfig");
    fs.writeFileSync(globalConfig, "");
    withEnv(
      {
        ...gitConfig,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_DIR: path.join(root, "parent-repo"),
        GIT_COMMON_DIR: path.join(root, "parent-common"),
        GIT_OBJECT_DIRECTORY: path.join(root, "parent-objects"),
        GIT_WORK_TREE: path.join(root, "parent-worktree"),
        git_index_file: path.join(root, "parent-index"),
        LIVE: undefined,
        OPENCLAW_LIVE_TEST: undefined,
        OPENCLAW_LIVE_GATEWAY: undefined,
        OPENCLAW_LIVE_USE_REAL_HOME: undefined,
      },
      () => {
        const testEnv = installTestEnv({ mode });
        try {
          const gitEnv = createNestedGitEnv();
          expect(Object.keys(gitEnv).some((key) => key.toUpperCase() === "GIT_INDEX_FILE")).toBe(
            false,
          );
          expect(() =>
            execFileSync("git", ["init", "--quiet"], {
              cwd: repo,
              env: gitEnv,
              stdio: "pipe",
            }),
          ).not.toThrow();
          expect(fs.existsSync(path.join(repo, ".git"))).toBe(true);
          expect(Object.keys(gitConfig).filter((key) => process.env[key] !== undefined)).toEqual(
            [],
          );
          expect(process.env.GIT_CONFIG_GLOBAL).toBe(globalConfig);
        } finally {
          testEnv.cleanup();
        }
        for (const [key, value] of Object.entries(gitConfig)) {
          expect(process.env[key]).toBe(value);
        }
      },
    );
  },
);
