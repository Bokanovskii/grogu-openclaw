import assert from "node:assert/strict";
import test from "node:test";
import { buildGroguCompactionConfig } from "./compaction-config.js";

test("adds the provider and history tools without lowering existing compaction bounds", () => {
  const original = {
    plugins: { load: { paths: ["/existing"] } },
    agents: {
      defaults: {
        compaction: {
          keepRecentTokens: 8192,
          maxActiveTranscriptBytes: 262144,
        },
      },
      entries: {
        grogu: {
          tools: { allow: ["read"] },
        },
      },
    },
  };

  const candidate = buildGroguCompactionConfig(original, {
    agentId: "grogu",
    pluginDirectory: "/checkout/grogu/plugins/grogu-compaction",
  });

  assert.deepEqual(candidate, {
    plugins: {
      load: { paths: ["/existing", "/checkout/grogu/plugins/grogu-compaction"] },
      entries: { "grogu-digest": { enabled: true } },
    },
    agents: {
      defaults: {
        compaction: {
          provider: "grogu-digest",
          notifyUser: false,
          keepRecentTokens: 8192,
          maxActiveTranscriptBytes: 262144,
        },
      },
      entries: {
        grogu: {
          tools: { allow: ["read", "sessions_search", "sessions_history"] },
        },
      },
    },
  });
  assert.equal("entries" in original.plugins, false);
});

test("uses alsoAllow when the agent inherits its normal tool profile", () => {
  assert.deepEqual(
    buildGroguCompactionConfig(
      { agents: { entries: { grogu: { tools: { profile: "full" } } } } },
      {
        agentId: "grogu",
        pluginDirectory: "/checkout/grogu/plugins/grogu-compaction",
      },
    ),
    {
      plugins: {
        load: { paths: ["/checkout/grogu/plugins/grogu-compaction"] },
        entries: { "grogu-digest": { enabled: true } },
      },
      agents: {
        defaults: {
          compaction: { provider: "grogu-digest", notifyUser: false },
        },
        entries: {
          grogu: {
            tools: {
              profile: "full",
              alsoAllow: ["sessions_search", "sessions_history"],
            },
          },
        },
      },
    },
  );
});
