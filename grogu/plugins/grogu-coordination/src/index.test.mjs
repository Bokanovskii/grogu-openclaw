import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import plugin from "./index.mjs";

const configuration = {
  agentIds: ["assistant", "reviewer"],
  mainAgentId: "assistant",
  quietHours: { start: "01:00", end: "05:00", timeZone: "Etc/UTC" },
  jobs: [
    { id: "inbox", agentId: "assistant", label: "Inbox", role: "intake" },
    {
      id: "snow",
      agentId: "assistant",
      label: "Snow",
      role: "snow-forecast",
      sourceSessionKey: "agent:assistant:dashboard:trip",
    },
  ],
};

function register(config = configuration, session = {}, live = {}) {
  const hooks = new Map();
  let dispose;
  plugin.register({
    config: { session },
    // A fresh copy per call, so only a read made at prompt time sees later edits.
    runtime: { config: { current: () => structuredClone(live) } },
    pluginConfig: config,
    on: (name, handler) => hooks.set(name, handler),
    lifecycle: {
      onDispose: (handler) => {
        dispose = handler;
      },
    },
  });
  return {
    hooks,
    prompt: (ctx) => hooks.get("before_prompt_build")({}, ctx),
    dispose: () => dispose(),
  };
}

test("injects complete stable instructions only into the selected Main and keeps jobs scoped", () => {
  const host = register(configuration, { mainKey: "curator" });
  const shared = readFileSync(new URL("../policy/AGENTS.md", import.meta.url), "utf8").trim();
  const main = readFileSync(new URL("../policy/main.md", import.meta.url), "utf8").trim();
  const mainResult = host.prompt({ agentId: "assistant", sessionKey: "agent:assistant:curator" });
  assert.equal(
    mainResult.appendSystemContext,
    `${shared}\n\n${main}\n\nAutomatic text quiet hours: 01:00-05:00, UTC.`,
  );
  for (const sessionKey of ["agent:assistant:main", "agent:assistant:cron:inbox"]) {
    const result = host.prompt({ agentId: "assistant", sessionKey });
    assert.deepEqual(result, { appendSystemContext: shared });
  }
  assert.deepEqual(host.prompt({ agentId: "reviewer", sessionKey: "agent:reviewer:curator" }), {
    appendSystemContext: shared,
  });
  const job = host.prompt({ agentId: "assistant", jobId: "snow" });
  assert.equal(job.appendSystemContext, shared);
  assert.match(job.appendContext, /Originating subject: agent:assistant:dashboard:trip/);
  assert.equal(host.prompt({ agentId: "reviewer", jobId: "snow" }).appendContext, undefined);
  assert.equal(host.prompt({ agentId: "unrelated" }), undefined);
  assert.equal(host.prompt({}), undefined);
  host.dispose();
  assert.equal(host.prompt({ agentId: "assistant" }), undefined);
});

test("gives only Main the owner text route from the live delivery configuration", () => {
  const delivery = {
    agentId: "assistant",
    channel: "telegram",
    target: "telegram:100",
    accountId: "owner-bot",
  };
  const live = { plugins: { entries: { "research-topics": { config: { delivery } } } } };
  const host = register(configuration, {}, live);
  const main = { agentId: "assistant", sessionKey: "agent:assistant:main" };
  const routeOf = (ctx) => {
    const line = host.prompt(ctx).appendSystemContext.match(/^Owner text route.*?(\{.*\})$/m);
    return line ? JSON.parse(line[1]) : undefined;
  };
  assert.deepEqual(routeOf(main), {
    channel: "telegram",
    target: "telegram:100",
    accountId: "owner-bot",
  });
  // A later edit reaches the next turn without registering again.
  delivery.target = "telegram:200";
  delete delivery.accountId;
  assert.deepEqual(routeOf(main), { channel: "telegram", target: "telegram:200" });
  for (const ctx of [
    { agentId: "assistant", sessionKey: "agent:assistant:cron:inbox" },
    { agentId: "assistant", jobId: "snow" },
    { agentId: "reviewer", sessionKey: "agent:reviewer:main" },
  ]) {
    assert(!host.prompt(ctx).appendSystemContext.includes("telegram:200"));
  }
  delivery.agentId = "reviewer";
  assert.equal(routeOf(main), undefined);
  delivery.agentId = "assistant";
  delete live.plugins.entries["research-topics"];
  assert.equal(routeOf(main), undefined);
});

test("accepts reusable producer roles without giving every agent Main authority", () => {
  assert.throws(() => register({ ...configuration, mainAgentId: "unrelated" }), /Main must belong/);
  assert.throws(
    () => register({ ...configuration, jobs: [...configuration.jobs, configuration.jobs[0]] }),
    /unique ids/,
  );
  const empty = register({ agentIds: ["assistant"], mainAgentId: "assistant", jobs: [] });
  assert.match(
    empty.prompt({ agentId: "assistant", sessionKey: "agent:assistant:main" }).appendSystemContext,
    /# Main text coordination/,
  );
  const ambiguous = {
    agentIds: ["assistant"],
    jobs: [
      { id: "one", agentId: "assistant", role: "intake" },
      { id: "two", agentId: "assistant", role: "intake" },
    ],
  };
  assert.throws(() => register(ambiguous), /Configure mainAgentId/);
  assert.doesNotThrow(() => register({ ...ambiguous, mainAgentId: "assistant" }));
  const global = register(configuration, { scope: "global" });
  assert.match(
    global.prompt({ agentId: "assistant", sessionKey: "global" }).appendSystemContext,
    /# Main text coordination/,
  );
  assert(
    !global
      .prompt({ agentId: "reviewer", sessionKey: "global" })
      .appendSystemContext.includes("# Main text coordination"),
  );
});

test("Main text sends fill the owner route and block other destinations before dispatch", () => {
  const delivery = {
    agentId: "assistant",
    channel: "telegram",
    target: "telegram:100",
    accountId: "owner-bot",
  };
  const live = { plugins: { entries: { "research-topics": { config: { delivery } } } } };
  const host = register(configuration, {}, live);
  const main = { agentId: "assistant", sessionKey: "agent:assistant:main", toolName: "message" };
  const guard = (params, ctx = main) =>
    host.hooks.get("before_tool_call")({ toolName: "message", params }, ctx);
  const message = { action: "send", message: "Synthetic finding" };
  assert.deepEqual(guard(message), {
    params: { ...message, channel: "telegram", target: "telegram:100", accountId: "owner-bot" },
  });
  for (const fields of [
    { target: "@someone" },
    { channel: "discord" },
    { accountId: "other-bot" },
    { targets: ["telegram:200"] },
    { threadId: "99" },
    { replyTo: "88" },
    { action: "broadcast" },
  ]) {
    const result = guard({ ...message, ...fields });
    assert.equal(result.block, true);
    assert.match(result.blockReason, /Main sends only direct owner texts/);
    assert.equal(result.params, undefined);
  }
  assert.equal(
    guard(
      { ...message, target: "telegram:200" },
      {
        ...main,
        sessionKey: "agent:assistant:chat:owner",
      },
    ),
    undefined,
  );
  delivery.target = "telegram:300";
  assert.equal(guard(message).params.target, "telegram:300");
  assert.equal(guard({ ...message, target: "telegram:100" }).block, true);
  delete live.plugins.entries["research-topics"];
  assert.equal(guard(message).block, true);
  live.plugins.entries["research-topics"] = { config: { delivery } };
  host.dispose();
  assert.equal(guard(message).block, true);
});

test("runs the system starts in a chat use the agent's configured model, not the chat's choice", () => {
  const live = {
    agents: {
      defaults: { model: "shared/default-model" },
      entries: { assistant: { model: { primary: "auto/worker-model", fallbacks: [] } } },
    },
  };
  const host = register(configuration, {}, live);
  const model = (ctx) =>
    host.hooks.get("before_model_resolve")(
      { prompt: "x" },
      {
        agentId: "assistant",
        sessionKey: "agent:assistant:dashboard:trip",
        modelProviderId: "chosen",
        modelId: "owner-model",
        trigger: "user",
        ...ctx,
      },
    );
  const automatic = { providerOverride: "auto", modelOverride: "worker-model" };
  const system = (sourceTool, ctx) => ({
    inputProvenance: {
      kind: sourceTool === "sessions_send" ? "inter_session" : "internal_system",
      sourceTool,
    },
    ...ctx,
  });
  for (const ctx of [
    {},
    { trigger: "heartbeat" },
    { inputProvenance: { kind: "external_user" } },
    system("openclaw_agent_consult"),
    system("exec_approval_followup"),
    system("stalled-turn-recovery"),
    system("cron", { trigger: "cron", jobId: "inbox" }),
    system("sessions_send", { jobId: "inbox" }),
    { inputProvenance: { kind: "internal_system", sourceTool: "cron", jobId: "inbox" } },
    system("sessions_send", { trigger: "memory" }),
    system("sessions_send", { modelProviderId: "auto", modelId: "worker-model" }),
    system("sessions_send", { agentId: "unrelated" }),
  ]) {
    assert.equal(model(ctx), undefined, JSON.stringify(ctx));
  }
  for (const ctx of [
    system("sessions_send"),
    { inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" } },
    system("restart-sentinel"),
    { inputProvenance: { kind: "internal_system" } },
    system("heartbeat", { trigger: "heartbeat" }),
    system("cron", { trigger: "heartbeat" }),
    system("exec-event", { trigger: "user" }),
  ]) {
    assert.deepEqual(model(ctx), automatic, JSON.stringify(ctx));
  }
  // A configured heartbeat model owns heartbeat runs; other system runs still switch.
  live.agents.defaults.heartbeat = { model: "beat/model" };
  assert.equal(model(system("heartbeat", { trigger: "heartbeat" })), undefined);
  assert.deepEqual(model(system("restart-sentinel")), automatic);
  delete live.agents.defaults.heartbeat;
  // The configured model is read live, falling back to the shared default.
  live.agents.entries.assistant.model = { fallbacks: ["other/model"] };
  assert.deepEqual(model(system("restart-sentinel")), {
    providerOverride: "shared",
    modelOverride: "default-model",
  });
  live.agents.defaults.model = "worker";
  assert.throws(() => model(system("restart-sentinel")), /provider\/model/);
  live.agents.defaults.model = "auto/worker-model";
  host.dispose();
  assert.equal(model(system("restart-sentinel")), undefined);
});
