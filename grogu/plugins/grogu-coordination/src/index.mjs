import { readFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";

// Inputs that continue the owner's own turn or request keep the chat's chosen model.
const OWNER_SOURCE_TOOLS = new Set([
  "openclaw_agent_consult",
  "session-companion",
  "sessions.recover",
  "session_goal_resume",
  "exec_approval_followup",
  "stalled-turn-recovery",
]);

const primaryOf = (model) => (typeof model === "string" ? model : model?.primary)?.trim();

// Scheduled jobs, memory flushes, and heartbeats with a heartbeat model have model settings
// that core owns.
const isSystemRun = ({ trigger, jobId, inputProvenance: provenance }, heartbeatModel) =>
  provenance !== undefined &&
  provenance.kind !== "external_user" &&
  !OWNER_SOURCE_TOOLS.has(provenance.sourceTool) &&
  trigger !== "cron" &&
  trigger !== "memory" &&
  !jobId &&
  !provenance.jobId &&
  !(trigger === "heartbeat" && heartbeatModel);

export default definePluginEntry({
  id: "grogu-coordination",
  name: "Grogu shared policy",
  description: "Stable shared instructions and one Main text coordinator.",
  register(api) {
    const readPolicy = (name, limit) => {
      const text = readFileSync(new URL(`../policy/${name}`, import.meta.url), "utf8").trim();
      if (!text || text.length > limit) {
        throw new Error(`Grogu ${name} must be present and at most ${limit} characters`);
      }
      return text;
    };
    const policy = readPolicy("AGENTS.md", 8_000);
    const mainPolicy = readPolicy("main.md", 4_000);
    const quietHours = api.pluginConfig.quietHours;
    const quietHoursContext = quietHours
      ? `Automatic text quiet hours: ${quietHours.start}-${quietHours.end}, ${
          new Intl.DateTimeFormat("en", { timeZone: quietHours.timeZone }).resolvedOptions()
            .timeZone
        }.`
      : "No installation quiet-hours window is configured. Apply the owner's current instructions.";
    const agents = new Set(api.pluginConfig.agentIds);
    const jobs = new Map();
    for (const job of api.pluginConfig.jobs) {
      if (!agents.has(job.agentId) || jobs.has(job.id)) {
        throw new Error("Grogu jobs need unique ids and explicitly selected agents");
      }
      jobs.set(job.id, job);
    }
    const intake = [...jobs.values()].filter((job) => job.role === "intake");
    if (!api.pluginConfig.mainAgentId && intake.length > 1) {
      throw new Error("Configure mainAgentId when more than one intake job is present");
    }
    const mainAgentId = api.pluginConfig.mainAgentId ?? intake[0]?.agentId;
    if (mainAgentId && !agents.has(mainAgentId)) {
      throw new Error("Grogu Main must belong to an explicitly selected agent");
    }
    const mainKey = mainAgentId
      ? api.config.session?.scope === "global"
        ? "global"
        : buildAgentMainSessionKey({
            agentId: mainAgentId,
            mainKey: api.config.session?.mainKey,
          })
      : undefined;
    // Compaction can drop the owner's route from Main's conversation, so rebuild it every turn
    // from the route Research Topics enforces. Read it live: this instance keeps its
    // registration-time config snapshot.
    const ownerRouteContext = () => {
      const delivery =
        api.runtime.config.current().plugins?.entries?.["research-topics"]?.config?.delivery;
      if (!delivery || delivery.agentId !== mainAgentId) {
        return undefined;
      }
      const { channel, target, accountId } = delivery;
      const route = JSON.stringify({ channel, target, ...(accountId ? { accountId } : {}) });
      return `Owner text route for automatic texts (copy these message fields exactly): ${route}`;
    };
    let retired = false;
    api.lifecycle.onDispose(() => {
      retired = true;
    });
    api.on("before_prompt_build", (_event, ctx) => {
      if (retired || !agents.has(ctx.agentId)) {
        return undefined;
      }
      ctx.hookInvocation?.assertActive();
      const isMain = ctx.agentId === mainAgentId && ctx.sessionKey === mainKey;
      const job = jobs.get(ctx.jobId);
      const subject =
        job?.agentId === ctx.agentId && job.sourceSessionKey
          ? `Originating subject: ${job.sourceSessionKey} (routing reference only).`
          : undefined;
      return {
        appendSystemContext: isMain
          ? [policy, mainPolicy, quietHoursContext, ownerRouteContext()]
              .filter(Boolean)
              .join("\n\n")
          : policy,
        ...(subject ? { appendContext: subject } : {}),
      };
    });
    // A chat's model choice is for the owner's own messages. Runs the system starts in that
    // chat use the agent's configured model, for this run only.
    api.on("before_model_resolve", (_event, ctx) => {
      if (retired || !agents.has(ctx.agentId)) {
        return undefined;
      }
      ctx.hookInvocation?.assertActive();
      const config = api.runtime.config.current();
      const agent = config.agents?.entries?.[ctx.agentId];
      const heartbeatModel =
        primaryOf(agent?.heartbeat?.model) || primaryOf(config.agents?.defaults?.heartbeat?.model);
      if (!isSystemRun(ctx, heartbeatModel)) {
        return undefined;
      }
      const primary = primaryOf(agent?.model) || primaryOf(config.agents?.defaults?.model);
      const slash = primary?.indexOf("/") ?? -1;
      if (slash < 1 || slash === primary.length - 1) {
        throw new Error(
          "Grogu automatic runs require an agent or default model in provider/model form.",
        );
      }
      const providerOverride = primary.slice(0, slash);
      const modelOverride = primary.slice(slash + 1);
      return providerOverride === ctx.modelProviderId && modelOverride === ctx.modelId
        ? undefined
        : { providerOverride, modelOverride };
    });
  },
});
