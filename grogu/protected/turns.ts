import { createHash } from "node:crypto";
import type { ProtectedModel, ProtectedTurnEvent } from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import { runEmbeddedAgent } from "../../src/agents/embedded-agent-runner/run.js";
import { queueGuardedEmbeddedAgentMessageWithOutcomeAsync } from "../../src/agents/embedded-agent-runner/runs.js";
import { withoutModelRequestTelemetry } from "../../src/agents/model-request-telemetry.js";
import { createRequestModelCredential } from "../../src/agents/request-model-credential.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/legacy-sqlite-marker.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { onAgentEventForRun } from "../../src/infra/agent-events.js";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { readWidgetDraftMetadata, WIDGET_DRAFT_MAX_CHARS } from "../../src/shared/widget-draft.js";
import { chatFilesDirectory } from "./chat-files.js";
import { ProtectedError } from "./errors.js";
import { projectToolResult, type Source, type Widget } from "./tool-events.js";

export type { ProtectedModel };
export type TurnInput = {
  text: string;
  provider: ProtectedModel["provider"];
  model: string;
  credential?: { accessToken: string; expiresAt?: number };
};
export type ProtectedTurn = {
  id: string;
  runId: string;
  profileId: string;
  target: { agentId: string; sessionKey: string; storePath: string };
  input: TurnInput;
  files: AuthorizedUserFiles;
  signal: AbortSignal;
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
  delta: (text: string) => Promise<void>;
  sources: (sources: Source[]) => Promise<void>;
  widget: (widget: Widget) => Promise<void>;
  widgetDraft: (draft: Extract<ProtectedTurnEvent, { type: "widget-draft" }>) => Promise<void>;
};

export function createCanonicalProtectedTurns(options: {
  config: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  models: readonly ProtectedModel[];
  resolveSparkyKey: () => Promise<string>;
}) {
  return {
    models: options.models,
    async run(turn: ProtectedTurn) {
      const { provider, model } = turn.input;
      const accessToken =
        provider === "sparky"
          ? await options.resolveSparkyKey()
          : turn.input.credential?.accessToken;
      await turn.revalidate();
      if (!accessToken) {
        throw new ProtectedError(
          401,
          "provider_credential_required",
          "Connect this provider first.",
        );
      }
      const credential = createRequestModelCredential({
        provider,
        model,
        accessToken,
        expiresAt: turn.input.credential?.expiresAt,
        assertCurrent: turn.assertCurrent,
      });
      const admission = prepareAgentRunAdmission({
        cfg: options.config,
        operationalRunInstance: createOperationalRunInstanceRef(turn.runId),
        assertSourceCurrent: turn.assertCurrent,
        facts: {
          runId: turn.runId,
          agentId: turn.target.agentId,
          ingress: { kind: "system", boundary: "grogu-protected", state: "present" },
        },
      });
      let updates = Promise.resolve();
      let updateError: unknown;
      const draftBytes = new Map<string, number>();
      const unsubscribe = onAgentEventForRun(turn.runId, ({ stream, data }) => {
        if (
          stream !== "tool" ||
          data.phase !== "input_delta" ||
          data.name !== "show_widget" ||
          typeof data.toolCallId !== "string" ||
          !isRecord(data.widgetDraft)
        ) {
          return;
        }
        const draft = readWidgetDraftMetadata(data.widgetDraft);
        if (!draft) {
          return;
        }
        const { html, offset } = data.widgetDraft;
        const id = data.toolCallId;
        const previous = draftBytes.get(id) ?? 0;
        if (previous > WIDGET_DRAFT_MAX_CHARS || (!draftBytes.has(id) && draftBytes.size >= 32)) {
          return;
        }
        const used = previous + (typeof html === "string" ? Buffer.byteLength(html) : 0);
        draftBytes.set(id, used);
        if (used > WIDGET_DRAFT_MAX_CHARS) {
          draft.unavailable = "limit";
        }
        const chunk =
          !draft.unavailable &&
          typeof html === "string" &&
          typeof offset === "number" &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          offset + html.length <= WIDGET_DRAFT_MAX_CHARS &&
          Buffer.byteLength(html) <= WIDGET_DRAFT_MAX_CHARS
            ? { html, offset }
            : {};
        updates = updates
          .then(() =>
            turn.widgetDraft({
              type: "widget-draft",
              id,
              ...draft,
              ...chunk,
            }),
          )
          .catch((error: unknown) => {
            updateError ??= error;
          });
      });
      const onAgentToolResult = ({
        toolName,
        result: raw,
        isError,
      }: {
        toolName: string;
        result: unknown;
        isError: boolean;
      }) => {
        if (isError || !isRecord(raw)) {
          return;
        }
        const result = projectToolResult(toolName, raw.details);
        if (result.sources.length || result.widgets.length) {
          updates = updates
            .then(async () => {
              if (result.sources.length) {
                await turn.sources(result.sources);
              }
              for (const item of result.widgets) {
                await turn.widget(item);
              }
            })
            .catch((error: unknown) => {
              updateError ??= error;
            });
        }
      };
      try {
        const result = await withoutModelRequestTelemetry(() =>
          runEmbeddedAgent({
            ...turn.target,
            sessionId: turn.id,
            sessionTarget: { ...turn.target, sessionId: turn.id },
            sessionFile: formatSqliteSessionFileMarker({
              ...turn.target,
              sessionId: turn.id,
            }),
            runId: turn.runId,
            timeoutMs: 120_000,
            abortSignal: turn.signal,
            config: options.config,
            workspaceDir: options.workspaceDir,
            agentDir: options.agentDir,
            prompt: turn.input.text,
            transcriptPrompt: turn.input.text,
            trigger: "user",
            provider,
            model,
            thinkLevel: provider === "sparky" ? "ultra" : undefined,
            agentHarnessRuntimeOverride: "openclaw",
            preparedRunAdmission: admission,
            requestModelCredential: credential.handle,
            bootstrapContextMode: "lightweight",
            disableMessageTool: true,
            disableToolSearch: true,
            disableTrajectory: true,
            codeModeOverride: false,
            toolsAllow: ["web_search", "web_fetch", "show_widget"],
            toolExecutionAllow: ["web_search", "web_fetch", "show_widget"],
            clientCaps: ["inline-widgets"],
            userFileScope: {
              files: turn.files,
              directory: chatFilesDirectory(turn.id),
              cacheKey: createHash("sha256")
                .update(`${turn.profileId}:${turn.id}:${turn.runId}`)
                .digest("hex"),
            },
            onAgentToolResult,
            onPartialReply: async ({ delta }) => {
              if (delta) {
                await turn.delta(delta);
              }
            },
          }),
        );
        await updates;
        if (updateError !== undefined) {
          throw updateError instanceof Error
            ? updateError
            : new Error("Could not publish the turn update.", { cause: updateError });
        }
        await turn.revalidate();
        if (result.payloads?.some((payload) => payload.isError) || result.meta.aborted) {
          throw new ProtectedError(502, "provider_failed", "The model did not complete the reply.");
        }
      } finally {
        unsubscribe();
        admission.close();
        credential.close();
      }
    },
    async steer(input: {
      id: string;
      steeringId: string;
      text: string;
      signal: AbortSignal;
      assertCurrent: () => void;
      onSettled: () => void;
      isCurrent: () => boolean;
    }) {
      return queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
        input.id,
        input.text,
        {
          queueIdentity: input.steeringId,
          abortSignal: input.signal,
          assertCurrent: input.assertCurrent,
          allowPendingUserInputAnswer: false,
          onQueueAccepted: () => undefined,
          onQueueSettled: input.onSettled,
        },
        input.isCurrent,
      );
    },
  };
}

export type ProtectedTurns = ReturnType<typeof createCanonicalProtectedTurns>;
