import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readGroguPrivateProfileDocument } from "../src/agents/grogu-private-profile.js";
import {
  callNative,
  createPrivateArtifactDirectory,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";
import {
  inspectRenderedWorkerTriggerScript,
  isEffectiveWorkerSchemaPin,
} from "./worker-trigger-templates.js";

/** Tracked, non-personal behavior that every Grogu install must keep. */
export const REQUIRED_CHANNEL_QUEUE_MODES: Readonly<Record<string, string>> = Object.freeze({
  telegram: "followup",
});

const modelRef = z.string().regex(/^[^/\s]+\/\S+$/, "Expected provider/model");
const workerContractMarker = z.enum([
  "GROGU_PRIVATE_SIGNAL_V1",
  "GROGU_DETERMINISTIC_POLL_V1",
  "GROGU_GMAIL_AUTH_HEALTH_V1",
  "GROGU_BACKUP_OBSERVABILITY_V1",
]);
const passiveWorkerContractSchema = z
  .object({
    jobId: z.string().min(1),
    contractVersion: z.literal(1),
    markers: z.array(workerContractMarker).min(1),
    requireTrigger: z.literal(false),
  })
  .strict();
const collectorWorkerContractSchema = z
  .object({
    jobId: z.string().min(1),
    contractVersion: z.literal(1),
    templateId: z.enum(["gmail-metadata-v1", "messages-metadata-v1"]),
    schemaSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .refine(isEffectiveWorkerSchemaPin, "schema hash must come from an effective probe"),
    triggerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolsAllow: z.array(z.string().min(1)).min(1),
    markers: z.array(workerContractMarker).min(1),
    requireTrigger: z.literal(true).optional(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const expectedTool =
      contract.templateId === "gmail-metadata-v1"
        ? "gmail__gmail_search"
        : "seaglass__recent_messages";
    if (
      new Set(contract.toolsAllow).size !== contract.toolsAllow.length ||
      !contract.toolsAllow.includes(expectedTool) ||
      contract.toolsAllow.some(
        (tool) => tool.includes("*") || ["exec", "message"].includes(tool.toLowerCase()),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolsAllow"],
        message: "worker contract toolsAllow is not exact",
      });
    }
  });
const modelPolicySchema = z
  .object({
    automaticModel: modelRef,
    ownerOverrides: z
      .object({
        configPaths: z.array(z.string().min(1)).default([]),
        jobIds: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ configPaths: [], jobIds: [] }),
    workerContracts: z
      .array(z.union([collectorWorkerContractSchema, passiveWorkerContractSchema]))
      .optional(),
  })
  .strict();

export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type PolicyViolation = Readonly<{ where: string; found: unknown; expected: unknown }>;

// Only the route fields matter; list rows carry evolving read-view metadata.
const policyJobSchema = z
  .object({
    id: z.string().min(1),
    trigger: z
      .object({
        script: z.string().min(1),
      })
      .passthrough()
      .optional(),
    payload: z
      .object({
        kind: z.string().min(1),
        message: z.string().optional(),
        model: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
        toolsAllow: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type PolicyJob = z.infer<typeof policyJobSchema>;

// Catalog and allowlist entries describe what the owner may pick, not automatic selection.
const NON_SELECTOR_KEYS = new Set(["models", "modelPolicy", "modelOverrides"]);
const isSelectorKey = (key: string) => /model$/i.test(key);

export function readModelPolicy(profileFile: string): ModelPolicy {
  const bindings = readGroguPrivateProfileDocument(profileFile)?.bindings;
  const raw =
    bindings && typeof bindings === "object" && "modelPolicy" in bindings
      ? bindings.modelPolicy
      : undefined;
  if (raw === undefined) {
    throw new Error("Private bindings.modelPolicy is required for policy checks");
  }
  return modelPolicySchema.parse(raw);
}

function collectConfigSelectors(
  value: unknown,
  path: string,
  inSelector: boolean,
  out: { path: string; ref: string }[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (inSelector && typeof item === "string") {
        out.push({ path: `${path}[${index}]`, ref: item });
      } else {
        collectConfigSelectors(item, `${path}[${index}]`, false, out);
      }
    });
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (NON_SELECTOR_KEYS.has(key)) {
      continue;
    }
    const childPath = path ? `${path}.${key}` : key;
    const selector = isSelectorKey(key) || (inSelector && ["primary", "fallbacks"].includes(key));
    if (selector && typeof child === "string") {
      // An empty decision model is the native "disabled" value, not a request route.
      if (child !== "") {
        out.push({ path: childPath, ref: child });
      }
    } else {
      collectConfigSelectors(child, childPath, selector, out);
    }
  }
}

export function evaluatePolicy(
  config: unknown,
  jobs: readonly PolicyJob[],
  policyInput: ModelPolicy,
): PolicyViolation[] {
  const policy = modelPolicySchema.parse(policyInput);
  const violations: PolicyViolation[] = [];
  const expected = policy.automaticModel;
  const selectors: { path: string; ref: string }[] = [];
  collectConfigSelectors(config, "", false, selectors);
  for (const selector of selectors) {
    if (selector.ref !== expected && !policy.ownerOverrides.configPaths.includes(selector.path)) {
      violations.push({ where: `config.${selector.path}`, found: selector.ref, expected });
    }
  }
  const queue = (config as { messages?: { queue?: { byChannel?: Record<string, unknown> } } })
    ?.messages?.queue?.byChannel;
  for (const [channel, mode] of Object.entries(REQUIRED_CHANNEL_QUEUE_MODES)) {
    if (queue?.[channel] !== mode) {
      violations.push({
        where: `config.messages.queue.byChannel.${channel}`,
        found: queue?.[channel] ?? null,
        expected: mode,
      });
    }
  }
  for (const job of jobs) {
    if (job.payload.kind !== "agentTurn" || policy.ownerOverrides.jobIds.includes(job.id)) {
      continue;
    }
    const routes = [job.payload.model, ...(job.payload.fallbacks ?? [])];
    for (const route of routes) {
      if (route !== undefined && route !== expected) {
        violations.push({ where: `job:${job.id}`, found: route, expected });
      }
    }
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const contract of policy.workerContracts ?? []) {
    const job = jobsById.get(contract.jobId);
    const collectorContract = "templateId" in contract ? contract : null;
    const expectedContract = collectorContract
      ? {
          contractVersion: collectorContract.contractVersion,
          templateId: collectorContract.templateId,
          schemaSha256: collectorContract.schemaSha256,
          triggerSha256: collectorContract.triggerSha256,
          toolsAllow: collectorContract.toolsAllow,
          markers: collectorContract.markers,
          trigger: true,
        }
      : {
          contractVersion: contract.contractVersion,
          markers: contract.markers,
          trigger: false,
        };
    if (!job) {
      violations.push({
        where: `job:${contract.jobId}:contract`,
        found: null,
        expected: expectedContract,
      });
      continue;
    }
    const missing = contract.markers.filter((marker) => !job.payload.message?.includes(marker));
    const triggerMissing = collectorContract !== null && !job.trigger?.script.trim();
    const triggerSha256 = job.trigger?.script
      ? createHash("sha256").update(job.trigger.script).digest("hex")
      : null;
    const renderedTemplate = (() => {
      try {
        return job.trigger?.script ? inspectRenderedWorkerTriggerScript(job.trigger.script) : null;
      } catch {
        return null;
      }
    })();
    const toolsAllowMatches =
      collectorContract === null ||
      isDeepStrictEqual(job.payload.toolsAllow ?? [], collectorContract.toolsAllow);
    const templateMatches =
      collectorContract === null ||
      (renderedTemplate?.templateId === collectorContract.templateId &&
        renderedTemplate.schemaSha256 === collectorContract.schemaSha256 &&
        isDeepStrictEqual(renderedTemplate.toolsAllow, collectorContract.toolsAllow));
    if (
      missing.length > 0 ||
      triggerMissing ||
      (collectorContract !== null && triggerSha256 !== collectorContract.triggerSha256) ||
      !toolsAllowMatches ||
      !templateMatches
    ) {
      violations.push({
        where: `job:${contract.jobId}:contract`,
        found: {
          missingMarkers: missing,
          trigger: Boolean(job.trigger?.script.trim()),
          triggerSha256,
          toolsAllow: job.payload.toolsAllow ?? [],
          templateId: renderedTemplate?.templateId ?? null,
          schemaSha256: renderedTemplate?.schemaSha256 ?? null,
        },
        expected: expectedContract,
      });
    }
  }
  return violations;
}

const configSnapshotSchema = z
  .object({ valid: z.literal(true), runtimeConfig: z.record(z.string(), z.unknown()) })
  .passthrough();
const cronPageSchema = z
  .object({
    jobs: z.array(z.unknown()),
    snapshotRevision: z.string().min(1),
    hasMore: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .passthrough();

const MAX_CRON_PAGES = 50;

export async function checkLivePolicy(profile: OperatorProfile) {
  const policy = readModelPolicy(profile.profileFile);
  const directory = await createPrivateArtifactDirectory(profile.recoveryDir);
  const snapshot = configSnapshotSchema.parse(
    await callNative(profile, "config.get", {}, directory),
  );
  const jobs: PolicyJob[] = [];
  let offset = 0;
  let revision: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_CRON_PAGES) {
      throw new Error("Native cron.list did not terminate within the page budget");
    }
    const result = cronPageSchema.parse(
      await callNative(
        profile,
        "cron.list",
        { includeDisabled: true, compact: false, limit: 200, offset },
        directory,
      ),
    );
    if (revision !== undefined && result.snapshotRevision !== revision) {
      throw new Error("Native jobs changed during the policy read; rerun the check");
    }
    revision = result.snapshotRevision;
    for (const job of result.jobs) {
      const parsed = policyJobSchema.safeParse(job);
      if (!parsed.success) {
        throw new Error("Native cron.list returned a job without a readable route");
      }
      jobs.push(parsed.data);
    }
    if (!result.hasMore) {
      break;
    }
    if (result.nextOffset === null || result.nextOffset <= offset) {
      throw new Error("Native cron.list returned a non-advancing page cursor");
    }
    offset = result.nextOffset;
  }
  const violations = evaluatePolicy(snapshot.runtimeConfig, jobs, policy);
  const receipt = await writePrivateReceipt(directory, "policy-check.json", {
    schemaVersion: 1,
    automaticModel: policy.automaticModel,
    checkedJobs: jobs.length,
    violations,
  });
  return {
    passed: violations.length === 0,
    checkedJobs: jobs.length,
    violations,
    receipt,
  };
}
