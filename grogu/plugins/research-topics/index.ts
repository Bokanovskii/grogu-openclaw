import path from "node:path";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { isCronSessionKey, isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import { createDelivery } from "./delivery.js";
import { isResearchMemberBinding, ResearchLedger } from "./ledger.js";
import {
  type LedgerOperations,
  memberToolDescription,
  parseRequest,
  toolSchema,
  toolDescription,
} from "./schema.js";

export default definePluginEntry({
  id: "research-topics",
  name: "Research Topics",
  description: "Private research briefs with fair rounds and shared source limits.",
  register(api) {
    const delivery = createDelivery(api);
    const memberScoped = api.pluginConfig?.ledgerMode === "member";
    const sending = new Map<
      string,
      {
        completion: NonNullable<LedgerOperations["matchMessage"]["output"]>;
        sessionKey: string;
        runId?: string;
      }
    >();
    const callKey = (sessionKey: string, sessionId: string, toolCallId: string) =>
      JSON.stringify([sessionKey, sessionId, toolCallId]);
    let retired = false;
    let personalLedger: ResearchLedger | undefined;
    const assertActive = () => {
      if (retired) {
        throw new Error("Research Topics plugin stopped. Retry after the plugin starts.");
      }
    };
    const readActions = new Set(["get", "lookup", "list", "due", "source_list"]);
    const personal = () => {
      assertActive();
      if (!api.runtimeSource) {
        throw new Error("Research Topics requires plugin runtimeSource metadata.");
      }
      personalLedger ??= new ResearchLedger(
        path.join(api.runtime.state.resolveStateDir(), "research-topics", "ledger.sqlite"),
        api.runtimeSource,
      );
      return personalLedger;
    };
    const stop = async () => {
      retired = true;
      sending.clear();
      await personalLedger?.close();
    };
    api.lifecycle.registerRuntimeLifecycle({
      id: "research-topics",
      cleanup: ({ reason, sessionKey, runId }) => {
        for (const [key, pending] of sending) {
          if (runId ? pending.runId === runId : sessionKey && pending.sessionKey === sessionKey) {
            sending.delete(key);
          }
        }
        return sessionKey === undefined &&
          runId === undefined &&
          (reason === "restart" || reason === "disable")
          ? stop()
          : undefined;
      },
    });
    api.registerService({ id: "research-topics", start: () => {}, stop });
    api.on("before_tool_call", async (event, context) => {
      const toolCallId = event.toolCallId ?? context.toolCallId;
      if (
        memberScoped ||
        !delivery ||
        event.toolName !== "message" ||
        event.params.action !== "send" ||
        typeof event.params.message !== "string" ||
        !context.sessionKey ||
        !context.sessionId ||
        !toolCallId
      ) {
        return;
      }
      const caller = { sessionKey: context.sessionKey, sessionId: context.sessionId };
      if (!delivery.isMain(caller)) {
        return;
      }
      const ownerText = event.params.message;
      const completion = await personal().run(
        (scope) =>
          scope.execute({
            type: "matchMessage",
            input: { ownerText, caller },
          }),
        assertActive,
        false,
      );
      assertActive();
      if (completion) {
        sending.set(callKey(caller.sessionKey, caller.sessionId, toolCallId), {
          completion,
          sessionKey: caller.sessionKey,
          runId: context.runId,
        });
      }
    });
    api.on("after_tool_call", async (event, context) => {
      const toolCallId = event.toolCallId ?? context.toolCallId;
      if (
        memberScoped ||
        !delivery ||
        event.toolName !== "message" ||
        !context.sessionKey ||
        !context.sessionId ||
        !toolCallId
      ) {
        return;
      }
      const caller = { sessionKey: context.sessionKey, sessionId: context.sessionId };
      const key = callKey(caller.sessionKey, caller.sessionId, toolCallId);
      const pending = sending.get(key);
      sending.delete(key);
      if (!pending || event.error) {
        return;
      }
      const receipt = delivery.receipt(event.params, event.result, caller, toolCallId, Date.now());
      if (!receipt) {
        return;
      }
      const main = await delivery.mainSession(assertActive);
      if (main.sessionId !== caller.sessionId) {
        throw new Error("Main changed before its completion receipt was recorded.");
      }
      await personal().run(
        (scope) =>
          scope.execute({
            type: "request",
            input: {
              request: {
                action: "confirm_completion",
                ...pending.completion,
                toolCallId,
              },
              caller,
              now: Date.now(),
              verifiedReceipt: receipt,
            },
          }),
        assertActive,
        true,
      );
    });
    api.registerTool(
      {
        contextVersion: 2,
        create: (context): AnyAgentTool | null => {
          if (context.sessionKey && isIncognitoSessionKey(context.sessionKey)) {
            return null;
          }
          const binding = context.toolBindings?.research_topics;
          if (memberScoped && !isResearchMemberBinding(binding)) {
            return null;
          }
          const member = memberScoped && isResearchMemberBinding(binding) ? binding : undefined;
          const selectedDelivery = member ? member.delivery : delivery;
          return {
            name: "research_topics",
            label: "Research topics",
            description: member ? memberToolDescription : toolDescription,
            parameters: toolSchema,
            execute: async (_callId, value) => {
              let request = parseRequest(value);
              const assertCurrent = () => {
                assertActive();
                context.assertInvocationCurrent();
                context.assertInputCommitAllowed?.();
                member?.assertCurrent();
              };
              assertCurrent();
              const caller =
                context.sessionKey && context.sessionId
                  ? { sessionKey: context.sessionKey, sessionId: context.sessionId }
                  : undefined;
              if (
                request.action === "add" &&
                context.sessionKey &&
                isCronSessionKey(context.sessionKey) &&
                request.sessionRefs === undefined
              ) {
                request = { ...request, origin: "automation", sessionRefs: [] };
              }
              if (
                request.action === "link_session" &&
                context.sessionKey &&
                isCronSessionKey(context.sessionKey)
              ) {
                throw new Error(
                  "Scheduled runs are not conversations and cannot link. Use post_update for recorded conversations.",
                );
              }
              const needsDelivery = [
                "complete",
                "post_update",
                "notify_main",
                "prepare_text",
                "confirm_completion",
              ].includes(request.action);
              const requireDelivery = () => {
                if (!selectedDelivery) {
                  throw new Error(
                    "Configure Research Topics delivery before using thread updates or Main handoffs.",
                  );
                }
                selectedDelivery.authorize(caller);
                return selectedDelivery;
              };
              if (needsDelivery) {
                requireDelivery();
              }
              if (
                (request.action === "prepare_text" || request.action === "confirm_completion") &&
                !requireDelivery().isMain(caller)
              ) {
                throw new Error("Only configured Main can prepare or confirm completion texts.");
              }
              const mainSession =
                request.action === "complete"
                  ? await requireDelivery().mainSession(assertCurrent)
                  : undefined;
              const mutation = !readActions.has(request.action);
              const executeWithAdmission = (assertAdmission: () => void) =>
                (member?.ledger ?? personal()).run(
                  async (scope) => {
                    const execute = (input: Partial<LedgerOperations["request"]["input"]> = {}) =>
                      scope.execute({
                        type: "request",
                        input: {
                          request,
                          now: Date.now(),
                          caller,
                          mainSession,
                          ...input,
                        },
                      });
                    if (
                      request.action === "post_update" ||
                      request.action === "notify_main" ||
                      request.action === "confirm_completion"
                    ) {
                      const topic = await scope.execute({
                        type: "publication",
                        input: { id: request.id, expectedRevision: request.expectedRevision },
                      });
                      assertCurrent();
                      if (request.action === "notify_main") {
                        return requireDelivery().notify(request, topic, assertCurrent);
                      }
                      if (request.action === "confirm_completion") {
                        const verifiedReceipt = await requireDelivery().recoverReceipt(
                          caller,
                          topic,
                          request.toolCallId,
                          assertCurrent,
                        );
                        return execute({ verifiedReceipt });
                      }
                      const verifiedReceipt = await requireDelivery().post(
                        request,
                        topic,
                        assertCurrent,
                      );
                      return topic.status === "completion_pending"
                        ? execute({ verifiedReceipt })
                        : verifiedReceipt;
                    }
                    const result = await execute();
                    return request.action === "prepare_text"
                      ? { topic: result, route: requireDelivery().route }
                      : result;
                  },
                  () => {
                    assertCurrent();
                    assertAdmission();
                  },
                  mutation,
                );
              const details =
                mutation && member
                  ? await member.withMutationAdmission(executeWithAdmission)
                  : await executeWithAdmission(() => {});
              return { content: [{ type: "text", text: JSON.stringify(details) }], details };
            },
          };
        },
      },
      { optional: true },
    );
  },
});
