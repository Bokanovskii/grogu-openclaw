import { z } from "zod";
import { readGroguPrivateProfileDocument } from "../src/agents/grogu-private-profile.js";
import {
  callNative,
  createPrivateArtifactDirectory,
  writePrivateReceipt,
  type OperatorProfile,
} from "./operator.js";

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
      .array(
        z
          .object({
            jobId: z.string().min(1),
            contractVersion: z.literal(1),
            markers: z.array(workerContractMarker).min(1),
            requireTrigger: z.boolean().optional(),
          })
          .strict(),
      )
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
  policy: ModelPolicy,
): PolicyViolation[] {
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
    const expectedContract = {
      contractVersion: contract.contractVersion,
      markers: contract.markers,
      trigger: contract.requireTrigger !== false,
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
    const triggerMissing = contract.requireTrigger !== false && !job.trigger?.script.trim();
    if (missing.length > 0 || triggerMissing) {
      violations.push({
        where: `job:${contract.jobId}:contract`,
        found: {
          missingMarkers: missing,
          trigger: Boolean(job.trigger?.script.trim()),
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
