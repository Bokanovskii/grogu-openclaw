import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import plugin from "./index.mjs";

const configuration = {
  agentIds: ["assistant", "reviewer"],
  jobs: [
    { id: "intake", agentId: "assistant", label: "Personal intake", role: "intake" },
    {
      id: "shopping",
      agentId: "assistant",
      label: "Shopping research",
      role: "purchase-watch",
      sourceSessionKey: "agent:assistant:dashboard:shopping",
    },
    { id: "review", agentId: "reviewer", label: "Operations review", role: "review" },
  ],
};

function register(config = configuration) {
  const hooks = new Map();
  const disposers = [];
  let scheduler = {};
  plugin.register({
    registrationMode: "full",
    pluginConfig: config,
    on(name, handler) {
      hooks.set(name, handler);
    },
    lifecycle: {
      onDispose(handler) {
        disposers.push(handler);
      },
    },
  });
  return {
    prompt(ctx) {
      return hooks.get("before_prompt_build")({ prompt: "Current job", messages: [] }, ctx);
    },
    changed(event, ctx = {}) {
      hooks.get("cron_changed")(event, { getCron: () => scheduler, ...ctx });
    },
    reconciled(cron = {}) {
      scheduler = cron;
      const controller = new AbortController();
      hooks.get("cron_reconciled")(
        { reason: "reload", enabled: true },
        { getCron: () => cron, abortSignal: controller.signal },
      );
      return controller;
    },
    dispose() {
      for (const dispose of disposers) {
        dispose();
      }
    },
  };
}

test("supplies the complete canonical policy to selected agents without replacing their prompt or tool policy", () => {
  const host = register();
  const canonical = readFileSync(new URL("../policy/AGENTS.md", import.meta.url), "utf8").trim();
  for (const agentId of configuration.agentIds) {
    const result = host.prompt({ agentId });
    assert(result.appendSystemContext.startsWith(`${canonical}\n\n`));
    assert.match(result.appendSystemContext, /00:00-06:00/);
    assert.match(result.appendSystemContext, /actual notification time/);
    assert.match(result.appendSystemContext, /pending.*not.*delivered/);
    assert.match(
      result.appendSystemContext,
      /Quiet-hour or uncertain-time holds finish exactly `NO_REPLY`/,
    );
    assert.equal(result.systemPrompt, undefined);
    assert.equal(result.toolsAllow, undefined);
    assert.equal(result.prependContext, undefined);
  }
  assert.equal(host.prompt({ agentId: "unrelated" }), undefined);
  assert.equal(host.prompt({}), undefined);
});

test("keeps changing activity outside the stable system context and does not copy event content", () => {
  const host = register();
  const before = host.prompt({ agentId: "assistant", jobId: "shopping", runId: "first" });
  host.changed({
    action: "started",
    jobId: "intake",
    agentId: "assistant",
    runAtMs: 1_000,
    summary: "PRIVATE SOURCE BODY",
  });
  const after = host.prompt({ agentId: "assistant", jobId: "shopping", runId: "second" });
  assert.equal(after.appendSystemContext, before.appendSystemContext);
  assert.notEqual(after.appendContext, before.appendContext);
  assert.match(after.appendContext, /Personal intake: running; delivery unknown/);
  assert(!JSON.stringify(after).includes("PRIVATE SOURCE BODY"));
  assert.match(after.appendContext, /Originating subject: agent:assistant:dashboard:shopping/);
  const otherAgent = host.prompt({ agentId: "reviewer", jobId: "shopping" });
  assert(!otherAgent.appendContext.includes("Originating subject:"));
  assert(!otherAgent.appendContext.includes("agent:assistant:dashboard:shopping"));
  const intake = host.prompt({ agentId: "assistant", jobId: "intake" });
  assert.match(
    intake.appendContext,
    /Related shopping subject: Shopping research -> agent:assistant:dashboard:shopping/,
  );
});

test("does not let late observations erase newer work or manufacture confirmed delivery", () => {
  const host = register();
  host.changed({ action: "started", jobId: "intake", agentId: "assistant", runAtMs: 2_000 });
  host.changed({
    action: "finished",
    jobId: "intake",
    agentId: "assistant",
    runAtMs: 1_000,
    status: "ok",
    deliveryStatus: "delivered",
  });
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: running; delivery unknown/,
  );
  host.changed({
    action: "finished",
    jobId: "intake",
    agentId: "assistant",
    runAtMs: 2_000,
    status: "ok",
    delivered: true,
  });
  host.changed({ action: "started", jobId: "intake", agentId: "assistant", runAtMs: 2_000 });
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: ok; delivery unknown/,
  );
  host.changed({ action: "started", jobId: "intake", agentId: "reviewer", runAtMs: 3_000 });
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: ok; delivery unknown/,
  );
  host.changed({
    action: "finished",
    jobId: "intake",
    agentId: "assistant",
    runAtMs: 2_000,
    status: "ok",
    deliveryStatus: "delivered",
  });
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: ok; delivery delivered/,
  );
});

test("does not retain observations from retired scheduler scopes", () => {
  const host = register();
  const oldScheduler = {};
  const scope = host.reconciled(oldScheduler);
  const started = { action: "started", jobId: "intake", agentId: "assistant", runAtMs: 1_000 };
  host.changed(started, { getCron: () => oldScheduler });
  scope.abort();
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: activity\/delivery not observed/,
  );
  host.reconciled();
  host.changed(
    {
      ...started,
      action: "finished",
      status: "ok",
      deliveryStatus: "delivered",
    },
    { getCron: () => oldScheduler },
  );
  assert.match(
    host.prompt({ agentId: "assistant" }).appendContext,
    /Personal intake: activity\/delivery not observed/,
  );
});

test("retires observations on scheduler reconciliation, removal and plugin disposal", () => {
  const started = { action: "started", jobId: "intake", agentId: "assistant", runAtMs: 1_000 };
  for (const retirement of ["reconciliation", "removal", "disposal"]) {
    const host = register();
    host.changed(started);
    assert.match(host.prompt({ agentId: "assistant" }).appendContext, /Personal intake: running/);
    if (retirement === "reconciliation") {
      host.reconciled();
    } else if (retirement === "removal") {
      host.changed({ action: "removed", jobId: "intake", agentId: "assistant" });
      host.changed({ ...started, action: "finished", status: "error" });
    } else {
      host.dispose();
    }
    assert.match(
      host.prompt({ agentId: "assistant" }).appendContext,
      /Personal intake: activity\/delivery not observed/,
    );
    if (retirement === "removal") {
      host.changed({ action: "added", jobId: "intake", agentId: "assistant" });
      host.changed({ ...started, runAtMs: 2_000 });
      assert.match(host.prompt({ agentId: "assistant" }).appendContext, /Personal intake: running/);
    }
  }
});

test("requires unique job ids and explicit membership instead of widening the agent scope", () => {
  assert.throws(
    () => register({ ...configuration, jobs: [...configuration.jobs, configuration.jobs[0]] }),
    /unique ids/,
  );
  assert.throws(
    () =>
      register({
        ...configuration,
        jobs: [{ id: "outsider", agentId: "unrelated", label: "Other job", role: "review" }],
      }),
    /explicitly selected agents/,
  );
});
