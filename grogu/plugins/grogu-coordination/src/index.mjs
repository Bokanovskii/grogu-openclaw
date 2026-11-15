import { readFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";

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
        appendSystemContext: isMain ? `${policy}\n\n${mainPolicy}\n\n${quietHoursContext}` : policy,
        ...(subject ? { appendContext: subject } : {}),
      };
    });
  },
});
