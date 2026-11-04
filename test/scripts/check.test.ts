// Check tests cover check script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { main, PREFLIGHT_CHECKS, runCommand } from "../../scripts/check.mts";

describe("scripts/check", () => {
  function runCheck(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/check.mts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }

  it("prints help without running check stages", () => {
    const result = runCheck("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/check.mts");
    expect(result.stdout).toContain("--skip-lint");
    expect(result.stdout).not.toContain("[check]");
  });

  it("rejects unknown args before running check stages", () => {
    for (const args of [["--bogus"], ["bogus", "--help"]]) {
      const result = runCheck(...args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`unknown argument: ${args[0]}`);
      expect(result.stderr).toContain("Usage: node --import tsx scripts/check.mts");
      expect(result.stderr).not.toContain("[check]");
    }
  });

  it("runs pnpm commands through the managed child runner", async () => {
    const calls: Array<{ args: string[]; bin: string }> = [];
    const result = await runCommand(
      { args: ["lint"], name: "lint" },
      async (options: { args: string[]; bin: string }) => {
        calls.push(options);
        return 0;
      },
    );

    expect(calls).toEqual([{ args: ["lint"], bin: "pnpm" }]);
    expect(result).toMatchObject({ name: "lint", status: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips the pnpm lint stage in either hosted argument order", async () => {
    for (const args of [
      ["--skip-lint", "--base", "abc123"],
      ["--base", "abc123", "--skip-lint"],
    ]) {
      const calls: Array<{ args: string[]; name: string }> = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await main(args, async (command) => {
          calls.push({ args: command.args, name: command.name });
          return { durationMs: 0, name: command.name, status: 0 };
        });
        expect(error).toHaveBeenCalledWith(
          "[check] skipping pnpm lint (Control UI i18n verify, type-aware Oxlint, Stylelint) via --skip-lint: run pnpm check without it locally before merging",
        );
      } finally {
        error.mockRestore();
        process.exitCode = undefined;
      }

      expect(calls.map((call) => call.name)).not.toContain("lint");
      expect(calls.map((call) => call.name)).toContain("format");
      expect(calls.map((call) => call.name)).toContain("runtime import cycles");
      expect(
        calls.some((call) => call.args.includes("--base") && call.args.includes("abc123")),
      ).toBe(true);
    }
  });

  it("retains the full pnpm lint stage in the default composition", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await main([], async (command) => {
        calls.push(command.name);
        return { durationMs: 0, name: command.name, status: 0 };
      });
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }

    expect(calls).toContain("lint");
    expect(calls).toContain("format");
    expect(calls).toContain("runtime import cycles");
  });

  it("keeps script policy guards in the aggregate preflight", () => {
    expect(PREFLIGHT_CHECKS).not.toContainEqual({
      name: "environment variable count ratchet",
      args: ["check:env-var-count"],
    });
    expect(PREFLIGHT_CHECKS).toContainEqual(
      expect.objectContaining({
        name: "max-lines suppression ratchet",
        args: ["check:max-lines-ratchet"],
      }),
    );
    expect(PREFLIGHT_CHECKS).toContainEqual(
      expect.objectContaining({
        name: "assertion SAFETY comment ratchet",
        args: ["check:assertion-safety"],
      }),
    );
    expect(PREFLIGHT_CHECKS).toContainEqual({
      name: "test timeout race ratchet",
      args: ["check:test-timeout-race-ratchet"],
      usesBase: true,
    });
    expect(PREFLIGHT_CHECKS).toContainEqual({
      name: "first-party mock export ratchet",
      args: ["check:test-mock-exports"],
      usesBase: true,
    });
    expect(PREFLIGHT_CHECKS).toContainEqual({
      name: "script TypeScript erasability",
      args: ["check:script-erasability"],
    });
  });
});
