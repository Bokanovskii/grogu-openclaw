import path from "node:path";
import { pathToFileURL } from "node:url";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { type LedgerOperations, parseRequest, toolSchema, toolDescription } from "./schema.js";

export default definePluginEntry({
  id: "research-topics",
  name: "Research Topics",
  description: "Private research topics with shared source limits.",
  register(api) {
    let opening: Promise<SqliteWorkerStore<LedgerOperations>> | undefined;
    let retired = false;
    const databasePath = path.join(
      api.runtime.state.resolveStateDir(),
      "research-topics",
      "ledger.sqlite",
    );
    const assertActive = () => {
      if (retired) {
        throw new Error("Research Topics plugin stopped. Retry after the plugin starts.");
      }
    };
    const open = () => {
      assertActive();
      if (!api.runtimeSource) {
        throw new Error("Research Topics requires plugin runtimeSource metadata.");
      }
      opening ??= openSqliteWorkerStore<LedgerOperations>({
        databasePath,
        moduleUrl: new URL(
          `./store.worker${path.extname(api.runtimeSource)}`,
          pathToFileURL(api.runtimeSource),
        ),
        input: {},
      }).catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
      return opening;
    };
    const stop = async () => {
      retired = true;
      if (opening) {
        await (await opening).close();
      }
    };
    api.lifecycle.registerRuntimeLifecycle({
      id: "research-topics",
      cleanup: ({ reason, sessionKey, runId }) =>
        sessionKey === undefined &&
        runId === undefined &&
        (reason === "restart" || reason === "disable")
          ? stop()
          : undefined,
    });
    api.registerService({ id: "research-topics", start: () => {}, stop });
    api.registerTool(
      {
        contextVersion: 2,
        create: (context): AnyAgentTool => ({
          name: "research_topics",
          label: "Research topics",
          description: toolDescription,
          parameters: toolSchema,
          execute: async (_callId, value) => {
            const request = parseRequest(value);
            const assertCurrent = () => {
              assertActive();
              context.assertInvocationCurrent();
              context.assertInputCommitAllowed?.();
            };
            assertCurrent();
            const store = await open();
            assertCurrent();
            const details = await runSqliteWorkerStoreWrite(
              store,
              (scope) => scope.execute({ type: "request", input: { request, now: Date.now() } }),
              assertCurrent,
              [databasePath],
            );
            return { content: [{ type: "text", text: JSON.stringify(details) }], details };
          },
        }),
      },
      { optional: true },
    );
  },
});
