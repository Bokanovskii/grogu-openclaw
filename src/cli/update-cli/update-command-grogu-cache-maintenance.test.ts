import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as processExec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { recordUpdatePackageCompletion } from "./update-command-package-completion.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const successfulCommand = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
  cleanup: "normal" as const,
};

async function createFixture(profile: "valid" | "invalid" | "missing" = "valid") {
  const root = tempDirs.make("grogu-package-cache-");
  const profileFile = path.join(root, "profile.json");
  if (profile !== "missing") {
    await fs.writeFile(
      profileFile,
      profile === "valid" ? '{"schemaVersion":1,"bindings":{}}' : "{}",
      { mode: 0o600 },
    );
  }
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    GROGU_PROFILE_FILE: profile === "missing" ? undefined : profileFile,
  };
  return {
    root,
    run: { runId: "synthetic-cache-update", env },
  };
}

function createResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "ok",
    mode: "npm",
    steps: [],
    durationMs: 0,
    ...overrides,
  };
}

function createTransaction(
  root: string,
  complete: PackageUpdateTransaction["complete"],
): PackageUpdateTransaction {
  return {
    backupRoot: path.join(root, "rollback"),
    complete,
    rollback: async () => ({
      name: "package-rollback",
      command: "openclaw update",
      cwd: root,
      durationMs: 0,
      exitCode: 0,
      activePackageRoot: null,
    }),
  };
}

function createParams(
  root: string,
  run: Awaited<ReturnType<typeof createFixture>>["run"],
  overrides: { mutationStarted?: boolean; dryRun?: boolean } = {},
) {
  return {
    root,
    mutationStarted: overrides.mutationStarted ?? true,
    updateStepTimeoutMs: 60_000,
    opts: { json: true, dryRun: overrides.dryRun, run },
  };
}

const noPruneCases: {
  name: string;
  profile?: "valid" | "missing";
  mutationStarted?: boolean;
  dryRun?: boolean;
  status?: UpdateRunResult["status"];
  mode?: UpdateRunResult["mode"];
}[] = [
  { name: "non-mutating", mutationStarted: false },
  { name: "dry run", dryRun: true },
  { name: "failed update", status: "error" },
  { name: "Git update", mode: "git" },
  { name: "unknown package manager", mode: "unknown" },
  { name: "non-Grogu update", profile: "missing" },
];

beforeEach(() => {
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Grogu package cache maintenance", () => {
  it.each([
    { mode: "npm", hasTransaction: true },
    { mode: "pnpm", hasTransaction: true },
    { mode: "bun", hasTransaction: true },
    { mode: "npm", hasTransaction: false },
  ] as const)(
    "prunes package caches after a successful $mode update (transaction=$hasTransaction)",
    async ({ mode, hasTransaction }) => {
      const { root, run } = await createFixture();
      const events: string[] = [];
      const command = vi.spyOn(processExec, "runCommandWithTimeout");
      command.mockImplementation(async (argv) => {
        events.push(argv.join(" "));
        return successfulCommand;
      });
      const packageTransaction = hasTransaction
        ? createTransaction(
            root,
            vi.fn<PackageUpdateTransaction["complete"]>(async () => {
              events.push("rollback cleanup settled");
            }),
          )
        : undefined;
      const result = createResult({ root, mode });

      await recordUpdatePackageCompletion(
        {
          ...createParams(root, run),
          packageTransaction,
        },
        result,
        () => {},
      );

      expect(events).toEqual(
        hasTransaction
          ? ["rollback cleanup settled", "npm cache verify", "pnpm store prune"]
          : ["npm cache verify", "pnpm store prune"],
      );
      expect(command.mock.calls.map(([argv]) => argv)).toEqual([
        ["npm", "cache", "verify"],
        ["pnpm", "store", "prune"],
      ]);
      expect(command.mock.calls[0]?.[1]).toMatchObject({
        cwd: root,
        env: { GROGU_PROFILE_FILE: run.env.GROGU_PROFILE_FILE },
        timeoutMs: 60_000,
      });
      expect(result.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "post-update-npm-cache", exitCode: 0 }),
          expect.objectContaining({ name: "post-update-pnpm-store", exitCode: 0 }),
        ]),
      );
      expect(result.status).toBe("ok");
    },
  );

  it.each(noPruneCases)("does not prune caches for the $name case", async (scenario) => {
    const { root, run } = await createFixture(scenario.profile ?? "valid");
    const command = vi.spyOn(processExec, "runCommandWithTimeout");
    const result = createResult({
      root,
      ...(scenario.status ? { status: scenario.status } : {}),
      ...(scenario.mode ? { mode: scenario.mode } : {}),
    });

    await recordUpdatePackageCompletion(
      createParams(root, run, {
        mutationStarted: scenario.mutationStarted,
        dryRun: scenario.dryRun,
      }),
      result,
      () => {},
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.steps).toEqual([]);
  });

  it("skips cache pruning while rollback cleanup remains unresolved", async () => {
    const { root, run } = await createFixture();
    const command = vi.spyOn(processExec, "runCommandWithTimeout");
    const result = createResult({ root });
    const packageTransaction = createTransaction(
      root,
      vi.fn<PackageUpdateTransaction["complete"]>(async () => ({
        name: "package-backup-retention",
        command: "openclaw update",
        cwd: root,
        durationMs: 0,
        exitCode: 1,
        advisory: {
          kind: "recoverable-maintenance",
          message: "Rollback data remains protected.",
        },
      })),
    );

    await recordUpdatePackageCompletion(
      { ...createParams(root, run), packageTransaction },
      result,
      () => {},
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual(
      expect.objectContaining({ name: "package-backup-retention" }),
    );
  });

  it("records command failures as warnings and continues cleanup", async () => {
    const { root, run } = await createFixture();
    const command = vi.spyOn(processExec, "runCommandWithTimeout");
    command
      .mockResolvedValueOnce({ ...successfulCommand, code: 7 })
      .mockResolvedValueOnce(successfulCommand);
    const result = createResult({ root });

    await recordUpdatePackageCompletion(createParams(root, run), result, () => {});

    expect(command).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "post-update-npm-cache",
        advisory: {
          kind: "recoverable-maintenance",
          message: expect.stringContaining("exited with code 7"),
        },
      }),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("The update succeeded."),
    );
  });

  it("does not swallow uncertain cache-command cleanup", async () => {
    const { root, run } = await createFixture();
    const command = vi
      .spyOn(processExec, "runCommandWithTimeout")
      .mockRejectedValue(new CommandProcessCleanupError());

    await expect(
      recordUpdatePackageCompletion(createParams(root, run), createResult({ root }), () => {}),
    ).rejects.toBeInstanceOf(CommandProcessCleanupError);
    expect(command).toHaveBeenCalledOnce();
  });

  it("warns and skips pruning when the Grogu profile cannot be admitted", async () => {
    const { root, run } = await createFixture("invalid");
    const command = vi.spyOn(processExec, "runCommandWithTimeout");
    const result = createResult({ root });

    await recordUpdatePackageCompletion(createParams(root, run), result, () => {});

    expect(command).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "post-update-cache-profile",
        advisory: expect.objectContaining({
          kind: "recoverable-maintenance",
          message: expect.stringContaining("could not be admitted"),
        }),
      }),
    );
  });
});
