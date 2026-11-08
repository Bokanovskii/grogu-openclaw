import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning visibility" });

suite.define(() => {
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
