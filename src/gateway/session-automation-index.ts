/** Process-local index of session keys that enabled cron jobs are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { resolveCronAgentSessionKey } from "../cron/isolated-agent/session-key.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";

type SessionAutomationSource = {
  /** Current in-memory cron jobs; undefined until the cron store is loaded. */
  getJobs: () => readonly CronJob[] | undefined;
  getDefaultAgentId: () => string | undefined;
};

let source: SessionAutomationSource | null = null;
let epochCounter = 0;
let registeredEpoch = 0;

let memo: {
  jobs: readonly CronJob[] | undefined;
  defaultAgentId: string | undefined;
  cfg: OpenClawConfig;
  keys: ReadonlySet<string>;
  owners: ReadonlyMap<string, string[]>;
} | null = null;
// Keep the last publication separate from reader refreshes: cron replaces its
// jobs array before awaited persistence, so a read must not consume that delta.
let publishedKeys: ReadonlySet<string> | undefined;
let publishedOwners: ReadonlyMap<string, string[]> | undefined;

/**
 * Claimed at cron service build time so registration authority follows build
 * order: a stale service whose start resolves after a config reload cannot
 * clobber the replacement's registration.
 */
export function claimSessionAutomationEpoch(): number {
  return ++epochCounter;
}

/** Registered by the gateway cron owner; newer epochs win over stale services. */
export function registerSessionAutomationSource(
  next: SessionAutomationSource | null,
  epoch?: number,
): void {
  const effectiveEpoch = epoch ?? claimSessionAutomationEpoch();
  if (effectiveEpoch < registeredEpoch) {
    return;
  }
  registeredEpoch = effectiveEpoch;
  source = next;
  invalidateSessionAutomationIndex();
}

/**
 * Owner-compare unregistration: a stopped cron service must not clear a
 * replacement's registration when config reloads race the lazy service build.
 */
export function unregisterSessionAutomationSource(owner: SessionAutomationSource): void {
  if (source !== owner) {
    return;
  }
  source = null;
  invalidateSessionAutomationIndex();
}

/** Called from the cron onEvent hook after any job/store change. */
export function invalidateSessionAutomationIndex(): void {
  // Even an empty source retains the last reader's config so the first added
  // binding can invalidate rows that were materialized before cron loaded.
  if (!memo) {
    return;
  }
  const current = refreshAutomationKeys(memo.cfg);
  publishAutomationKeys(current.keys, current.owners);
}

/** Publish membership deltas without letting speculative reader refreshes consume them. */
function publishAutomationKeys(
  current: ReadonlySet<string>,
  owners: ReadonlyMap<string, string[]>,
) {
  const previous = publishedKeys ?? new Set<string>();
  const previousOwners = publishedOwners ?? new Map<string, string[]>();
  publishedKeys = current;
  publishedOwners = owners;
  // Install the complete snapshot before notifying synchronous consumers.
  for (const identity of new Set([
    ...previous,
    ...current,
    ...previousOwners.keys(),
    ...owners.keys(),
  ])) {
    if (
      previous.has(identity) === current.has(identity) &&
      JSON.stringify(previousOwners.get(identity)) === JSON.stringify(owners.get(identity))
    ) {
      continue;
    }
    const separator = identity.indexOf("\0");
    sessionChanges.emit({
      scope: "automation",
      facts: { kind: "unchanged" },
      sessionKey: separator < 0 ? identity : identity.slice(separator + 1),
      ...(separator < 0 ? {} : { agentId: identity.slice(0, separator) }),
    });
  }
}

function buildAutomationOwners(
  jobs: readonly CronJob[],
  cfg: OpenClawConfig,
  defaultAgentId: string | undefined,
): ReadonlyMap<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const job of jobs) {
    // Delivery and source conversations are personal chats, not automation workspaces.
    if (!job.sessionTarget.startsWith("session:")) {
      continue;
    }
    const agentId = tryResolveCronJobEffectiveAgentId(job, defaultAgentId);
    if (!agentId) {
      continue;
    }
    const resolveKey = (sessionKey: string) =>
      resolveCronAgentSessionKey({ sessionKey, agentId, cfg, mainKey: cfg.session?.mainKey });
    const key = resolveKey(job.sessionTarget.slice("session:".length));
    // Home and the chat that created or owns a job stay personal when the job runs inside them.
    if (
      ["main", job.sessionKey, job.owner?.sessionKey].some(
        (personal) => personal && resolveKey(personal) === key,
      )
    ) {
      continue;
    }
    const identity = parseAgentSessionKey(key) ? key : `${normalizeAgentId(agentId)}\0${key}`;
    owners.set(identity, [...(owners.get(identity) ?? []), job.id].toSorted());
  }
  return owners;
}

function buildAutomationKeys(
  jobs: readonly CronJob[],
  cfg: OpenClawConfig,
  defaultAgentId: string | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    for (const key of resolveCronJobBoundSessionKeys(job, { cfg, defaultAgentId })) {
      const agentId = job.owner?.agentId ?? defaultAgentId;
      if (parseAgentSessionKey(key)) {
        keys.add(key);
      } else if (agentId) {
        keys.add(`${normalizeAgentId(agentId)}\0${key}`);
      }
    }
  }
  return keys;
}

/** Replace the existing memo with a snapshot, never retaining mutable job facts. */
function refreshAutomationKeys(cfg: OpenClawConfig) {
  const jobs = source?.getJobs();
  const defaultAgentId = source?.getDefaultAgentId();
  memo = {
    jobs,
    cfg,
    defaultAgentId,
    keys: buildAutomationKeys(jobs ?? [], cfg, defaultAgentId),
    owners: buildAutomationOwners(jobs ?? [], cfg, defaultAgentId),
  };
  publishedKeys ??= memo.keys;
  publishedOwners ??= memo.owners;
  return memo;
}

/** True when an enabled cron job is bound to the canonical session key. */
export function sessionHasAutomation(
  sessionKey: string,
  cfg: OpenClawConfig,
  agentId?: string,
): boolean {
  const jobs = source?.getJobs();
  const defaultAgentId = source?.getDefaultAgentId();
  // Config publications rebuild resident rows; their reads adopt the new
  // routing config even when the cron jobs array itself has not changed.
  const configChanged = memo && memo.cfg !== cfg;
  const current =
    memo && memo.jobs === jobs && memo.cfg === cfg && memo.defaultAgentId === defaultAgentId
      ? memo
      : refreshAutomationKeys(cfg);
  if (configChanged) {
    publishAutomationKeys(current.keys, current.owners);
  }
  const identity = parseAgentSessionKey(sessionKey)
    ? sessionKey
    : agentId
      ? `${normalizeAgentId(agentId)}\0${sessionKey}`
      : undefined;
  return identity ? current.keys.has(identity) : false;
}

/** Persistent execution targets remain automation-owned while their jobs are paused. */
export function sessionAutomationJobIds(
  sessionKey: string,
  cfg: OpenClawConfig,
  agentId?: string,
): string[] | undefined {
  sessionHasAutomation(sessionKey, cfg, agentId);
  const identity = parseAgentSessionKey(sessionKey)
    ? sessionKey
    : agentId
      ? `${normalizeAgentId(agentId)}\0${sessionKey}`
      : undefined;
  const ids = identity ? memo?.owners.get(identity) : undefined;
  return ids ? [...ids] : undefined;
}
