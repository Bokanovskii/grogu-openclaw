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

function register(config = configuration, session = {}) {
  const hooks = new Map();
  let dispose;
  plugin.register({
    config: { session },
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
