/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  registerControlUiReloadGuard,
  canReloadControlUiDocument,
} from "../../app/document-reload-guard.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { enqueueChatMessage, readChatQueueForScope, updateQueuedMessage } from "./chat-queue.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { QUEUED_MESSAGE_EDIT_CONFLICT_ERROR } from "./queued-message-edit.ts";

const recovery = vi.hoisted(() => ({
  review: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn<(options: { onAction?: () => void; message: string }) => boolean>(() => true),
}));
vi.mock("./components/private-composer-recovery-dialog.ts", () => ({
  reviewPrivateComposerDraft: recovery.review,
}));
vi.mock("../../lib/toast.ts", () => ({ showToast: recovery.toast }));

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  recovery.review.mockReset();
  recovery.toast.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createControllerFixture(withClient = false) {
  const controller = new ChatStateController<ChatPageHost>({
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  });
  controller.hostConnected();
  const state = createPageState(createInitializationContext(), controller.createRenderLifecycle(), {
    dispatchEvent: () => true,
    querySelector: () => null,
  });
  if (withClient) {
    state.client = createTestGatewayClient(async () => ({}));
  }
  controller.attach(state);
  return { controller, state };
}

describe("queued edit page callbacks", () => {
  it.each([
    [QUEUED_MESSAGE_EDIT_CONFLICT_ERROR, QUEUED_MESSAGE_EDIT_CONFLICT_ERROR, null, null],
    [
      QUEUED_MESSAGE_EDIT_CONFLICT_ERROR,
      OFFLINE_QUEUE_STORAGE_ERROR,
      null,
      OFFLINE_QUEUE_STORAGE_ERROR,
    ],
    [
      "History could not be refreshed",
      OFFLINE_QUEUE_STORAGE_ERROR,
      "History could not be refreshed",
      OFFLINE_QUEUE_STORAGE_ERROR,
    ],
  ] as const)(
    "clears only resolved edit feedback when opening a queued editor (%s, %s)",
    (lastError, chatError, expectedLastError, expectedChatError) => {
      const { controller, state } = createControllerFixture(true);
      try {
        const queued = enqueueChatMessage(state, "queued original")!;
        state.chatMessage = "separate composer draft";
        state.lastError = lastError;
        state.chatError = chatError;

        state.editQueuedChatMessage(queued.id);

        expect(state.chatQueuedEdit?.draftText).toBe("queued original");
        expect(state.chatMessage).toBe("separate composer draft");
        state.chatMessage = "";
        expect(canReloadControlUiDocument()).toBe(false);
        expect(state.lastError).toBe(expectedLastError);
        expect(state.chatError).toBe(expectedChatError);
      } finally {
        controller.hostDisconnected();
      }
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );

  it.each(["later edit", "another reload guard", "confirmed discard", "private fallback"] as const)(
    "keeps private-draft discard scoped during %s",
    async (scenario) => {
      const { controller, state } = createControllerFixture();
      state.sessionKey = "agent:main:dashboard:incognito-private-review";
      state.chatMessage = "captured private text";
      if (scenario === "private fallback") {
        storeChatComposerMemoryFallback(
          state,
          { sessionKey: state.sessionKey },
          {
            message: "private fallback",
            attachments: [],
          },
        );
        state.chatMessage = "";
      }
      const pending = createDeferred<boolean>();
      recovery.review.mockReturnValue(pending.promise);
      const reloadAllowed: boolean[] = [];
      state.captureComposerRecoveryReload = () => async () => {
        const allowed = canReloadControlUiDocument();
        reloadAllowed.push(allowed);
        return allowed;
      };
      const releaseOther =
        scenario === "another reload guard"
          ? registerControlUiReloadGuard(
              () => false,
              () => undefined,
            )
          : () => undefined;
      try {
        expect(canReloadControlUiDocument(true)).toBe(false);
        recovery.toast.mock.lastCall?.[0].onAction?.();
        expect(recovery.review).toHaveBeenCalledOnce();
        if (scenario === "later edit") {
          state.handleChatDraftChange("newer private edit", []);
        }
        pending.resolve(true);
        await pending.promise;
        expect(state.chatMessage).toBe(scenario === "later edit" ? "newer private edit" : "");
        if (scenario === "private fallback") {
          expect(state.chatComposerFallbackByScope).toEqual({});
        }
        expect(reloadAllowed).toEqual(
          scenario === "later edit" ? [] : [scenario !== "another reload guard"],
        );
        if (scenario === "later edit") {
          expect(recovery.toast.mock.lastCall?.[0].message).toContain("draft changed");
        }
      } finally {
        releaseOther();
        controller.hostDisconnected();
      }
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );
});

describe("ArrowUp queued message recall", () => {
  const arrowUp = {
    key: "ArrowUp" as const,
    selectionStart: 0,
    selectionEnd: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 38,
  };

  it("moves the newest queued message back into an empty composer", () => {
    const { controller, state } = createControllerFixture(true);
    try {
      enqueueChatMessage(state, "first queued")!;
      enqueueChatMessage(state, "second queued")!;

      expect(state.handleChatInputHistoryKey(arrowUp).handled).toBe(true);
      expect(state.chatMessage).toBe("second queued");
      expect(readChatQueueForScope(state, state.sessionKey).map((item) => item.text)).toEqual([
        "first queued",
      ]);

      // A non-empty draft keeps the remaining queue intact.
      state.handleChatInputHistoryKey(arrowUp);
      expect(readChatQueueForScope(state, state.sessionKey)).toHaveLength(1);
      state.chatMessage = "";
    } finally {
      controller.hostDisconnected();
    }
  });

  it("withdraws a dispatched steer on the server before recalling it", async () => {
    const { controller, state } = createControllerFixture();
    const requests: Array<[string, unknown]> = [];
    state.client = createTestGatewayClient(async (method, params) => {
      requests.push([method, params]);
      return { ok: true, aborted: true, runIds: ["steer-run"] };
    });
    state.connected = true;
    try {
      const queued = enqueueChatMessage(state, "steer me back")!;
      updateQueuedMessage(state, queued.id, (item) => ({
        ...item,
        queueMode: "steer",
        sendRunId: "steer-run",
        serverQueued: true,
      }));

      expect(state.handleChatInputHistoryKey(arrowUp).handled).toBe(true);
      await vi.waitFor(() => expect(state.chatMessage).toBe("steer me back"));
      expect(requests).toEqual([["chat.abort", expect.objectContaining({ runId: "steer-run" })]]);
      state.chatMessage = "";
    } finally {
      controller.hostDisconnected();
    }
  });
});
