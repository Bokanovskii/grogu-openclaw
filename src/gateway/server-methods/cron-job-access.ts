import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import type { CronJob, CronJobPatch } from "../../cron/types.js";
import {
  createAgentDatabaseAdmissionErrorShape,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  cronJobMatchesCallerReadScope,
  cronJobMatchesCallerScope,
  readCronCallerScope,
  type CronCallerScope,
} from "./cron-caller-scope.js";
import {
  createCronSessionVisibility,
  cronJobIsVisible,
  cronJobVisibilityTarget,
} from "./cron-visibility.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

type CronJobIdParams = { id?: string; jobId?: string };

export function isLegacyCreatorPromptUpdate(
  job: CronJob,
  patch: CronJobPatch,
  callerScope: CronCallerScope | undefined,
): boolean {
  // A prompt edit keeps the legacy execution policy; it cannot establish new
  // authority or transfer management to another session/account.
  return (
    callerScope?.sessionKey !== undefined &&
    job.owner?.sessionKey === callerScope.sessionKey &&
    job.owner?.accountId === callerScope.accountId &&
    job.scheduledToolPolicy === undefined &&
    job.payload.kind === "agentTurn" &&
    patch.payload !== undefined &&
    (patch.payload.kind === undefined || patch.payload.kind === "agentTurn") &&
    Object.keys(patch).every((key) => key === "payload") &&
    Object.keys(patch.payload).every((key) => key === "kind" || key === "message")
  );
}

export function respondRefusedCronAgent(agentId: string | undefined, respond: RespondFn): boolean {
  const refusal = agentId ? readAgentDatabaseAdmissionRefusal(agentId) : undefined;
  if (!refusal) {
    return false;
  }
  respond(false, undefined, createAgentDatabaseAdmissionErrorShape(refusal));
  return true;
}

export function assertCronReadCurrent(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  >,
) {
  options.signal?.throwIfAborted();
  if (options.hasCurrentClientAuthority?.() === false) {
    throw new Error("Cron history authority closed");
  }
  assertActiveAgentRuntimeAuthority(options.client, options.context);
}

export function resolveCronJobId(params: CronJobIdParams): string | undefined {
  // Exact store lookups; clipboard/UI padding must not fake "id not found".
  return normalizeOptionalString(params.id ?? params.jobId);
}

export function respondInvalidCronParams(respond: RespondFn, method: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${reason}`),
  );
}

export function respondMissingCronJobId(respond: RespondFn, method: string): void {
  respondInvalidCronParams(respond, method, "missing id");
}

export function respondCronJobNotFound(
  respond: RespondFn,
  jobId: string,
  options: { preserveCronGetWireMessage?: boolean } = {},
): void {
  const message = options.preserveCronGetWireMessage
    ? `cron job not found: ${jobId}. List automations and retry with a current job id.`
    : `Automation not found: ${jobId}. List automations and retry with a current job id.`;
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `${message} For cross-session management, use a fresh authenticated configured channel owner or Control UI administrator turn or the Automations page.`,
      {
        details: { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId },
      },
    ),
  );
}

type ScopedCronMethod =
  | "cron.get"
  | "cron.scratch.get"
  | "cron.scratch.set"
  | "cron.remove"
  | "cron.run";

export function scopedCronJobHandler<P extends CronJobIdParams>(
  method: ScopedCronMethod,
  validate: Validator<P>,
  run: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & {
      params: P;
    },
    loaded: {
      jobId: string;
      callerScope: CronCallerScope | undefined;
      job: CronJob;
      assertCurrent: () => void;
    },
  ) => ReturnType<GatewayRequestHandler>,
  scope: {
    accessMode?: "read" | "manage";
    allowCurrentJob?: boolean;
    checkVisibility?: boolean;
    preserveCronGetWireMessage?: boolean;
  } = {},
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(method, validate, async (options) => {
    const { params, respond, client, context } = options;
    const jobId = resolveCronJobId(params);
    if (!jobId) {
      respondMissingCronJobId(respond, method);
      return;
    }
    const visibilityRead = createCronSessionVisibility(client, () => context.getRuntimeConfig());
    try {
      const loaded = await context.cron.readJob(jobId);
      const prepareVisibility = scope.checkVisibility && visibilityRead.resolve() !== undefined;
      if (scope.checkVisibility) {
        assertCronReadCurrent(options);
      }
      if (prepareVisibility) {
        await visibilityRead.prepare([
          cronJobVisibilityTarget(loaded, context.cron.getDefaultAgentId()),
        ]);
        assertCronReadCurrent(options);
      }
      const callerScope = readCronCallerScope(client);
      const job = prepareVisibility ? context.cron.getJob(jobId) : loaded;
      const visibility = scope.checkVisibility ? visibilityRead.resolve() : undefined;
      const matchesCaller = (candidate: CronJob, currentScope: CronCallerScope | undefined) =>
        scope.accessMode === "read"
          ? cronJobMatchesCallerReadScope({
              job: candidate,
              callerScope: currentScope,
              defaultAgentId: context.cron.getDefaultAgentId(),
              allowCurrentJob: scope.allowCurrentJob,
            })
          : cronJobMatchesCallerScope({
              job: candidate,
              callerScope: currentScope,
              defaultAgentId: context.cron.getDefaultAgentId(),
              allowCurrentJob: scope.allowCurrentJob,
            });
      if (
        !job ||
        (scope.checkVisibility &&
          !cronJobIsVisible(job, visibility, context.cron.getDefaultAgentId())) ||
        !matchesCaller(job, callerScope)
      ) {
        respondCronJobNotFound(respond, jobId, scope);
        return;
      }
      const assertCurrent = () => {
        assertCronReadCurrent(options);
        const currentJob = context.cron.getJob(jobId);
        const currentScope = readCronCallerScope(client);
        const currentVisibility = scope.checkVisibility ? visibilityRead.resolve() : undefined;
        if (
          !currentJob ||
          (scope.checkVisibility &&
            !cronJobIsVisible(currentJob, currentVisibility, context.cron.getDefaultAgentId())) ||
          !matchesCaller(currentJob, currentScope)
        ) {
          throw new Error("Cron job access changed before reply");
        }
      };
      // Consume authorized reads in this frame; mutations retain their lock-time commit guards.
      return await run(options, { jobId, callerScope, job, assertCurrent });
    } finally {
      visibilityRead.release();
    }
  });
}
