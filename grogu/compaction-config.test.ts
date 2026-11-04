import { describe, expect, it } from "vitest";
import { buildGroguCompactionConfig } from "./compaction-config.js";

describe("buildGroguCompactionConfig", () => {
  it("adds the provider and history tools without lowering existing compaction bounds", () => {
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

    expect(candidate).toMatchObject({
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
    expect(original).not.toHaveProperty("plugins.entries");
  });

  it("uses alsoAllow when the agent inherits its normal tool profile", () => {
    expect(
      buildGroguCompactionConfig(
        { agents: { entries: { grogu: { tools: { profile: "full" } } } } },
        {
          agentId: "grogu",
          pluginDirectory: "/checkout/grogu/plugins/grogu-compaction",
        },
      ),
    ).toMatchObject({
      agents: {
        entries: {
          grogu: {
            tools: {
              profile: "full",
              alsoAllow: ["sessions_search", "sessions_history"],
            },
          },
        },
      },
    });
  });
});
