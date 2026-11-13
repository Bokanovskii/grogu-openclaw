import { readFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildAgentMainSessionKey,
  isIncognitoSessionKey,
  parseAgentSessionKey,
} from "openclaw/plugin-sdk/routing";

export default definePluginEntry({
  id: "grogu-coordination",
  name: "Grogu shared policy",
  description: "Shared assistant policy and native Main coordination.",
  register(api) {
    const policy = readFileSync(new URL("../policy/AGENTS.md", import.meta.url), "utf8").trim();
    if (!policy || policy.length > 8_000) {
      throw new Error("Grogu shared policy must be present and at most 8,000 characters");
    }
    const { agentIds, jobs } = api.pluginConfig;
    const agents = new Set(agentIds);
    const team = new Map();
    for (const job of jobs) {
      if (!agents.has(job.agentId) || team.has(job.id)) {
        throw new Error("Grogu coordination jobs need unique ids and explicitly selected agents");
      }
      team.set(job.id, job);
    }
    const orderedJobs = [...team.values()].toSorted((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const intakeJobs = orderedJobs.filter((job) => job.role === "intake");
    if (intakeJobs.length > 1) {
      throw new Error("Grogu coordination needs one intake owner for Main follow-through");
    }
    const coordinator = intakeJobs[0];
    const mainSessionKey = coordinator
      ? api.config.session?.scope === "global"
        ? "global"
        : buildAgentMainSessionKey({
            agentId: coordinator.agentId,
            mainKey: api.config.session?.mainKey,
          })
      : undefined;
    const directory = orderedJobs
      .map((job) => `- ${job.label}: ${job.role}; agent ${job.agentId}`)
      .join("\n");
    const systemContext = `${policy}\n\n## Cooperating roles\n\n${directory}`;
    const observations = new Map();
    const removedJobs = new Set();
    let scheduler;
    let schedulerSignal;

    function nudgeMain(reference) {
      if (
        !coordinator ||
        !mainSessionKey ||
        removedJobs.has(coordinator.id) ||
        schedulerSignal?.aborted
      ) {
        return;
      }
      const accepted = api.runtime.system.enqueueSystemEvent(
        "Grogu coordination: review new permitted side-chat context and canonical saved findings, " +
          "not only the latest reference. Read recent relevant human turns before steering an " +
          "existing topic; match decisions and interests, not only exact old product names. " +
          "This hint is not source evidence, an owner request, a task completion or a delivery " +
          "receipt. Preserve the existing source, task and notification owners and access rules.\n" +
          `Latest change: ${JSON.stringify(reference)}`,
        {
          agentId: coordinator.agentId,
          sessionKey: mainSessionKey,
          contextKey: "grogu-coordination",
          replace: true,
        },
      );
      if (accepted) {
        api.runtime.system.requestHeartbeat({
          source: "hook",
          intent: "event",
          reason: "grogu-coordination",
          agentId: coordinator.agentId,
          sessionKey: mainSessionKey,
        });
      }
    }

    api.on("message_received", (event, ctx) => {
      const source = parseAgentSessionKey(ctx.sessionKey);
      if (
        !coordinator ||
        source?.agentId !== coordinator.agentId ||
        ctx.sessionKey === mainSessionKey ||
        isIncognitoSessionKey(ctx.sessionKey)
      ) {
        return;
      }
      nudgeMain({
        kind: "side-chat",
        sessionKey: ctx.sessionKey,
        messageId: event.messageId,
        timestamp: event.timestamp,
      });
    });

    api.on("cron_changed", (event, ctx) => {
      const emittingScheduler = ctx.getCron?.();
      if (
        !emittingScheduler ||
        (scheduler && emittingScheduler !== scheduler) ||
        schedulerSignal?.aborted ||
        ctx.abortSignal?.aborted
      ) {
        return;
      }
      scheduler ??= emittingScheduler;
      const job = team.get(event.jobId);
      if (!job || event.agentId !== job.agentId) {
        return;
      }
      if (event.action === "removed") {
        observations.delete(job.id);
        removedJobs.add(job.id);
        return;
      }
      if (event.action === "added") {
        removedJobs.delete(job.id);
        return;
      }
      if (
        removedJobs.has(job.id) ||
        !["started", "finished"].includes(event.action) ||
        !Number.isFinite(event.runAtMs)
      ) {
        return;
      }
      const previous = observations.get(job.id);
      if (
        previous &&
        (event.runAtMs < previous.runAtMs ||
          (event.runAtMs === previous.runAtMs &&
            previous.phase === "finished" &&
            event.action === "started"))
      ) {
        return;
      }
      observations.set(job.id, {
        runAtMs: event.runAtMs,
        phase: event.action,
        status: event.action === "finished" ? (event.status ?? "unknown") : "running",
        delivery: event.action === "finished" ? (event.deliveryStatus ?? "unknown") : "unknown",
      });
      if (
        event.action === "finished" &&
        event.status === "ok" &&
        event.job?.enabled !== false &&
        ["intake", "personal", "financial", "purchase-watch", "research"].includes(job.role) &&
        !(previous?.runAtMs === event.runAtMs && previous.phase === "finished")
      ) {
        nudgeMain({ kind: "automation", jobId: job.id, runAtMs: event.runAtMs });
      }
    });
    api.on("cron_reconciled", (_event, ctx) => {
      observations.clear();
      removedJobs.clear();
      scheduler = ctx.getCron?.();
      schedulerSignal = ctx.abortSignal;
    });
    api.lifecycle.onDispose(() => {
      observations.clear();
      removedJobs.clear();
    });
    api.on("before_prompt_build", (_event, ctx) => {
      if (!agents.has(ctx.agentId)) {
        return;
      }
      ctx.hookInvocation?.assertActive();
      if (schedulerSignal?.aborted) {
        observations.clear();
      }
      const currentJob = team.get(ctx.jobId);
      const activity = orderedJobs.map((job) => {
        const observed = observations.get(job.id);
        return observed
          ? `- ${job.label}: ${observed.status}; delivery ${observed.delivery}; run started ${new Date(observed.runAtMs).toISOString()}`
          : `- ${job.label}: activity/delivery not observed in this plugin generation`;
      });
      const subject =
        currentJob?.agentId === ctx.agentId && currentJob.sourceSessionKey
          ? `\nOriginating subject: ${currentJob.sourceSessionKey} (routing reference only, not a send grant).`
          : "";
      const relatedSubjects =
        currentJob?.agentId === ctx.agentId && ["intake", "personal"].includes(currentJob.role)
          ? orderedJobs
              .filter(
                (job) =>
                  job.agentId === ctx.agentId &&
                  job.role === "purchase-watch" &&
                  job.sourceSessionKey,
              )
              .map(
                (job) =>
                  `\nRelated shopping subject: ${job.label} -> ${job.sourceSessionKey} (routing reference only, not a read/send grant).`,
              )
              .join("")
          : "";
      return {
        appendSystemContext: systemContext,
        appendContext:
          `Cooperating-job observations (not source, task or delivery receipts):\n${activity.join("\n")}${subject}${relatedSubjects}\n` +
          "Read the relevant canonical task/purchase/confirmed-delivery records only when this job's source scope permits it.",
      };
    });
  },
});
