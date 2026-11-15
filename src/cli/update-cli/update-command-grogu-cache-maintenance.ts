import { readGroguPrivateProfileDocument } from "../../agents/grogu-private-profile.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdatePackageCompletionParams } from "./update-command-finish-types.js";

const PACKAGE_CACHE_COMMANDS = [
  { name: "post-update-npm-cache", label: "npm cache verify", argv: ["npm", "cache", "verify"] },
  { name: "post-update-pnpm-store", label: "pnpm store prune", argv: ["pnpm", "store", "prune"] },
] as const;

function describeCommandFailure(result: {
  code: number | null;
  killed: boolean;
  outputLimitExceeded?: boolean;
  termination: string;
}): string {
  if (result.termination !== "exit") {
    return `ended with ${result.termination}`;
  }
  if (result.killed) {
    return "was terminated";
  }
  if (result.outputLimitExceeded) {
    return "exceeded its output limit";
  }
  return `exited with code ${result.code ?? "unknown"}`;
}

function appendWarning(result: UpdateRunResult, step: UpdateStepResult, message: string): void {
  result.steps.push({
    ...step,
    advisory: { kind: "recoverable-maintenance", message },
  });
  defaultRuntime.error(message);
}

export async function completeGroguPackageCacheMaintenance(
  params: UpdatePackageCompletionParams,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<void> {
  if (
    !params.mutationStarted ||
    params.opts.dryRun ||
    result.status !== "ok" ||
    (result.mode !== "npm" && result.mode !== "pnpm" && result.mode !== "bun")
  ) {
    return;
  }
  const run = params.opts.run;
  if (!run || run.env.GROGU_PROFILE_FILE === undefined) {
    return;
  }
  const profileFile = run.env.GROGU_PROFILE_FILE;

  const cwd = result.root ?? params.root;
  try {
    readGroguPrivateProfileDocument(profileFile);
  } catch (error) {
    assertCurrent();
    const message =
      `Package cache cleanup was skipped because the Grogu profile could not be admitted. ` +
      `${formatErrorMessage(error)} Check GROGU_PROFILE_FILE, then run a package update again.`;
    appendWarning(
      result,
      {
        name: "post-update-cache-profile",
        command: "openclaw update",
        cwd,
        durationMs: 0,
        exitCode: 0,
      },
      message,
    );
    return;
  }

  for (const { name, label, argv } of PACKAGE_CACHE_COMMANDS) {
    assertCurrent();
    const startedAt = Date.now();
    let commandResult: Awaited<ReturnType<typeof runCommandWithTimeout>>;
    try {
      commandResult = await runCommandWithTimeout([...argv], {
        cwd,
        env: run.env,
        timeoutMs: params.updateStepTimeoutMs,
        maxOutputBytes: { stdout: 8_192, stderr: 8_192 },
      });
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      assertCurrent();
      const message =
        `Package cache cleanup could not run ${label}: ${formatErrorMessage(error)}. ` +
        "The update succeeded. A later successful package update will retry cleanup.";
      appendWarning(
        result,
        {
          name,
          command: label,
          cwd,
          durationMs: Date.now() - startedAt,
          exitCode: 1,
        },
        message,
      );
      continue;
    }

    if (commandResult.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    assertCurrent();
    const step: UpdateStepResult = {
      name,
      command: label,
      cwd,
      durationMs: Date.now() - startedAt,
      exitCode: commandResult.code,
      signal: commandResult.signal,
      killed: commandResult.killed,
      outputLimitExceeded: commandResult.outputLimitExceeded,
      termination: commandResult.termination,
    };
    if (
      commandResult.code !== 0 ||
      commandResult.termination !== "exit" ||
      commandResult.killed ||
      commandResult.outputLimitExceeded
    ) {
      appendWarning(
        result,
        step,
        `Package cache cleanup ${label} ${describeCommandFailure(commandResult)}. ` +
          "The update succeeded. A later successful package update will retry cleanup.",
      );
    } else {
      result.steps.push(step);
    }
  }
}
