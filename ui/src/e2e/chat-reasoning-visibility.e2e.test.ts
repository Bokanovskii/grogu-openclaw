import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning visibility" });

suite.define(() => {
  it("animates Grogu continuously in the built UI while reasoning updates", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { assistantName: "Grogu" });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").fill("Review this evidence");
        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
        const sprite = page.locator(".chat-grogu-eater__sprite");
        await sprite.waitFor();
        const originalSprite = await sprite.elementHandle();
        if (!originalSprite) {
          throw new Error("Expected Grogu's rendered sprite");
        }
        const look = sprite.locator(".chat-grogu-eater__pose--look");
        expect(
          await look.evaluate((element) => {
            const style = getComputedStyle(element);
            return [
              style.animationDuration,
              style.animationIterationCount,
              style.animationTimingFunction,
            ];
          }),
        ).toEqual(["4.2s", "infinite", "steps(1)"]);
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "main",
          runId,
          seq: 1,
          state: "status",
          phase: "starting_model",
        });
        await page
          .locator(".chat-working-indicator__status")
          .getByText("Waiting for a response…", { exact: true })
          .waitFor();
        let reasoning = "";
        for (const [index, delta] of ["Reviewing", " evidence", " now."].entries()) {
          reasoning += delta;
          await gateway.emitGatewayEvent("agent", {
            sessionKey: "main",
            runId,
            seq: index + 2,
            stream: "thinking",
            data: { text: reasoning, delta },
            ts: Date.now(),
          });
          await page.getByText(reasoning, { exact: true }).waitFor();
          expect(await originalSprite.evaluate((element) => element.isConnected)).toBe(true);
          expect(
            await sprite.evaluate((element) => {
              const animations = element.getAnimations({ subtree: true });
              return (
                animations.length > 0 &&
                animations.every(
                  (animation) => animation.effect?.getTiming().iterations === Infinity,
                )
              );
            }),
          ).toBe(true);
        }
        const bite = sprite.locator(".chat-grogu-eater__pose--bite");
        await sprite.evaluate((element) => {
          for (const animation of element.getAnimations({ subtree: true })) {
            animation.pause();
            animation.currentTime = 800;
          }
        });
        expect(await bite.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const directory = createControlUiE2eArtifactDir("grogu-eating-built-ui");
          const row = page.locator(".chat-working-indicator");
          const frame = await takeControlUiScreenshotFrame(page, row, [sprite], {
            elements: [row],
            animations: "disabled",
          });
          await writeFile(path.join(directory, "grogu-eating.png"), frame.elements[0]!.png);
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await sprite.evaluate((element) => element.getAnimations({ subtree: true }).length),
        ).toBe(0);
        expect(await look.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      },
    );
  });

  it("folds live reasoning into the answer when text starts streaming", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const reasoning = "Compare the evidence before answering.";
      const sessionKey = "agent:main:reasoning-handoff";
      const gateway = await installMockGateway(page, {
        sessionKey,
        assistantName: "Grogu",
        sessionInfo: { reasoningLevel: "on" },
        sessions: [{ key: sessionKey, kind: "direct", reasoningLevel: "on", updatedAt: 1 }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".agent-chat__composer-combobox textarea").fill("Check the evidence");
      await page.getByRole("button", { name: "Send message" }).click();
      const request = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
      await gateway.emitGatewayEvent("agent", {
        sessionKey,
        runId,
        seq: 1,
        stream: "thinking",
        data: { text: reasoning },
        ts: Date.now(),
      });
      await page.locator(".chat-working-indicator__reasoning").getByText(reasoning).waitFor();
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The answer is arriving." }],
        },
      });
      await page.locator(".chat-bubble.streaming").getByText("The answer is arriving.").waitFor();
      await expect.poll(() => page.locator(".chat-working-indicator").count()).toBe(0);
      const disclosure = page.locator(".chat-bubble.streaming .chat-thinking");
      expect(await disclosure.count()).toBe(1);
      expect(await disclosure.getAttribute("open")).toBeNull();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("reasoning-answer-handoff");
        const answer = page.locator(".chat-group.assistant").last();
        const frame = await takeControlUiScreenshotFrame(page, answer, [disclosure], {
          elements: [answer],
          animations: "disabled",
        });
        await writeFile(path.join(directory, "answer-handoff.png"), frame.elements[0]!.png);
      }
      await disclosure.locator("summary").click();
      expect(await disclosure.getByText(reasoning).isVisible()).toBe(true);
      const finalMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `${reasoning}\n\nThe complete reasoning is preserved.` },
          { type: "text", text: "The answer is complete." },
        ],
        timestamp: Date.now(),
        __openclaw: { id: "completed-reasoning", seq: 2, runId },
      };
      await gateway.setHistoryMessages([
        {
          role: "user",
          content: "Check the evidence",
          timestamp: Date.now() - 1,
          __openclaw: { id: "reasoning-prompt", seq: 1, idempotencyKey: `${runId}:user` },
        },
        finalMessage,
      ]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        runId,
        messageId: "completed-reasoning",
        messageSeq: 2,
        message: finalMessage,
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "final",
        message: finalMessage,
      });
      await page
        .locator(".chat-text")
        .getByText("The answer is complete.", { exact: true })
        .waitFor();
      await expect.poll(() => page.locator(".chat-working-indicator").count()).toBe(0);
      const completed = page.locator(".chat-thinking");
      if ((await completed.getAttribute("open")) === null) {
        await completed.locator("summary").click();
      }
      await expect
        .poll(() => completed.getByText("The complete reasoning is preserved.").isVisible())
        .toBe(true);
    });
  });

  it.each([
    { reasoningLevel: "off", withTools: false },
    { reasoningLevel: "on", withTools: false },
    { reasoningLevel: "stream", withTools: false },
    { reasoningLevel: "off", withTools: true },
    { reasoningLevel: "on", withTools: true },
    { reasoningLevel: "stream", withTools: true },
    { reasoningDefault: "on", withTools: true },
    { reasoningDefault: "off", withTools: true },
    { reasoningLevel: "off", reasoningDefault: "on", withTools: true },
  ])("keeps reasoning in work: %o", async ({ reasoningLevel, reasoningDefault, withTools }) => {
    const effectiveReasoningLevel = reasoningLevel ?? reasoningDefault;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    try {
      const page = await context.newPage();
      const sessionKey = "agent:main:dashboard:reasoning-visibility";
      const reasoningText = "Compare the evidence before answering.";
      const code = 'const label = "*literal*";\n\nconsole.log(label);\n';
      const conclusion = "Compare both outputs.";
      const finalText = "The answer is ready.";
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionInfo: { reasoningLevel, reasoningDefault },
        sessions: [
          { key: sessionKey, kind: "direct", reasoningLevel, reasoningDefault, updatedAt: 4_000 },
        ],
        historyMessages: [
          { role: "user", content: "Check the evidence.", timestamp: 1_000 },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: `${reasoningText}\n\n\`\`\`ts\n${code}\`\`\`\n\n${conclusion}`,
              },
            ],
            timestamp: 2_000,
          },
          ...(withTools
            ? [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "read-evidence",
                      name: "read",
                      arguments: { path: "evidence.txt" },
                    },
                  ],
                  timestamp: 2_500,
                },
                {
                  role: "toolResult",
                  toolCallId: "read-evidence",
                  toolName: "read",
                  content: "Evidence checked.",
                  timestamp: 3_000,
                },
              ]
            : []),
          { role: "assistant", content: [{ type: "text", text: finalText }], timestamp: 4_000 },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const answer = pane.getByText(finalText, { exact: true });
      const reasoning = pane.locator(".chat-thinking", { hasText: reasoningText });
      const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");

      for (const reload of [false, true]) {
        if (reload) {
          await page.reload();
        }
        await answer.waitFor();
        await expect.poll(() => reasoning.isVisible()).toBe(false);
        await worked.click();
        await expect.poll(() => worked.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => reasoning.isVisible()).toBe(effectiveReasoningLevel === "on");
        if (effectiveReasoningLevel === "on") {
          expect(await reasoning.getAttribute("open")).toBeNull();
          expect(await reasoning.locator("pre code").isVisible()).toBe(false);
          await reasoning.locator("summary").press(reload ? "Enter" : "Space");
          expect(await reasoning.locator("pre code").isVisible()).toBe(true);
          expect(await reasoning.locator("pre code").allTextContents()).toEqual([code]);
          expect(await reasoning.locator("p").allTextContents()).toEqual([
            reasoningText,
            conclusion,
          ]);
          // The disclosure is an unboxed row whose chevron stays inside the reasoning column.
          const chrome = await reasoning.evaluate((details) => {
            const box = details.getBoundingClientRect();
            const chevron = details.querySelector("summary .chat-tool-row__chevron");
            const mark = chevron?.getBoundingClientRect();
            return {
              border: getComputedStyle(details).borderStyle,
              chevronInside: mark !== undefined && mark.left >= box.left && mark.right <= box.right,
            };
          });
          expect(chrome).toEqual({ border: "none", chevronInside: true });
          await reasoning.locator("summary").click();
          expect(await reasoning.getAttribute("open")).toBeNull();
        }
        expect(await answer.isVisible()).toBe(true);
      }

      const menuTrigger = pane.locator(".chat-header-session-menu__trigger");
      const menu = pane.locator("wa-dropdown.chat-header-session-menu");
      const localReasoning = menu.getByRole("menuitemcheckbox", { name: "Reasoning" });
      for (const showReasoning of [false, true]) {
        await menuTrigger.click();
        await menu.getByRole("menuitem", { name: "View", exact: true }).hover();
        await localReasoning.click();
        await expect
          .poll(() => localReasoning.getAttribute("aria-checked"))
          .toBe(String(showReasoning));
        await menuTrigger.click();
        await expect
          .poll(() => reasoning.isVisible())
          .toBe(showReasoning && effectiveReasoningLevel === "on");
        expect(await answer.isVisible()).toBe(true);
      }
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
