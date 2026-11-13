import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("paints a script-free widget draft during a silent turn and removes it on failure", async () => {
    await suite.withPage(
      // The completed widget's sandbox host registers a service worker.
      { ...createControlUiE2eContextOptions(), serviceWorkers: "allow" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          agentModel: "fixture/fixture-model",
          models: [
            {
              id: "fixture-model",
              name: "Fixture model",
              provider: "fixture",
              contextWindow: 100000,
              reasoning: false,
            },
          ],
          methodResponses: {
            "canvas.document.view": canvasView(
              buildWidgetDocument(
                "Build results",
                "<h2>Finished build report</h2><p>All builds passed.</p>",
              ),
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Show the build results as a widget.");
        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "run ID");
        let seq = 0;
        const emit = (stream: string, data: Record<string, unknown>) =>
          gateway.emitGatewayEvent("agent", {
            runId,
            seq: ++seq,
            stream,
            data,
            ts: Date.now(),
            sessionKey: "agent:main:main",
            agentId: "main",
          });
        await emit("thinking", { text: "Planning a compact build report." });
        await emit("usage", { outputTokens: 1200 });
        const partial = `<style>body{padding:24px}h2{font-size:22px}p{line-height:1.6}</style>
        <h2>Build results</h2><p>Compile: passed</p>`;
        await emit("tool", {
          phase: "input_delta",
          name: "show_widget",
          toolCallId: "widget-1",
          widgetDraft: {
            title: "Build results",
            receivedChars: partial.length,
            offset: 0,
            html: partial,
          },
        });
        const surface = page.locator(".chat-thread-inner");
        const card = page.locator("openclaw-widget-draft");
        await card.getByText("Building widget", { exact: true }).waitFor();
        const preview = card.locator("iframe:not([hidden])").contentFrame();
        await preview.getByRole("heading", { name: "Build results" }).waitFor();
        expect(await card.count()).toBe(1);
        const frame = await takeControlUiScreenshotFrame(page, surface, [composer], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "widget-stream.png"), frame.png);
        expect(await page.getByText("Planning a compact build report.").isVisible()).toBe(false);
        const requests: string[] = [];
        await page.route("https://widget-draft.invalid/**", async (route) => {
          requests.push(route.request().url());
          await route.abort();
        });
        const next = `<p>Tests: passed</p>
        <meta http-equiv="refresh" content="0;url=https://widget-draft.invalid/navigation">
        <script>fetch('https://widget-draft.invalid/script')</script>
        <img src="https://widget-draft.invalid/image" onerror="parent.document.title='unsafe'">
        <iframe src="https://widget-draft.invalid/frame"></iframe>
        <style>body{background-image:url(https://widget-draft.invalid/style)}</style>`;
        const arrival = Date.now();
        await emit("tool", {
          phase: "input_delta",
          name: "show_widget",
          toolCallId: "widget-1",
          widgetDraft: {
            title: "Build results",
            receivedChars: partial.length + next.length,
            offset: partial.length,
            html: next,
          },
        });
        await preview.getByText("Tests: passed").waitFor();
        console.info(`[widget-draft] arrival-to-visible ${Date.now() - arrival}ms`);
        expect(await card.locator("iframe:not([hidden])").getAttribute("sandbox")).toBe("");
        expect(await preview.locator("script,meta[http-equiv=refresh],iframe").count()).toBe(0);
        expect(requests).toEqual([]);
        const after = await takeControlUiScreenshotFrame(page, surface, [card], {
          animations: "disabled",
          scrollTo: card,
          elements: [surface],
        });
        await writeFile(path.join(suite.artifactDir, "widget-preview.png"), after.png);
        await writeFile(
          path.join(suite.artifactDir, "widget-preview-chat.png"),
          after.elements[0]!.png,
        );
        const mobile = await takeControlUiScreenshotFrame(page, surface, [card], {
          animations: "disabled",
          scrollTo: card,
          viewport: { width: 390, height: 844 },
        });
        await writeFile(path.join(suite.artifactDir, "widget-preview-mobile.png"), mobile.png);
        // Script-only batches sanitize to the visible document; later markup must still paint.
        let htmlLength = partial.length + next.length;
        for (const piece of [
          "<script>const rows = [",
          "1, 2, 3",
          "];</script><p>Deploy: queued</p>",
        ]) {
          await emit("tool", {
            phase: "input_delta",
            name: "show_widget",
            toolCallId: "widget-1",
            widgetDraft: {
              title: "Build results",
              receivedChars: htmlLength + piece.length,
              offset: htmlLength,
              html: piece,
            },
          });
          htmlLength += piece.length;
          await card
            .getByText(`${htmlLength.toLocaleString("en-US")} characters received`)
            .waitFor();
          await card.evaluate(
            (element) =>
              (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
          );
          await Promise.all(
            page
              .frames()
              .filter((child) => !child.isDetached())
              .map((child) => child.waitForLoadState("load")),
          );
        }
        await preview.getByText("Deploy: queued").waitFor();
        await emit("tool", {
          phase: "result",
          name: "show_widget",
          toolCallId: "widget-1",
          isError: true,
          result: { content: [{ type: "text", text: "Widget validation failed." }] },
        });
        await card.getByText("Widget failed", { exact: true }).waitFor();
        expect(await card.locator("iframe").count()).toBe(0);
        await emit("tool", {
          phase: "input_delta",
          name: "show_widget",
          toolCallId: "widget-2",
          widgetDraft: {
            title: "Build results",
            receivedChars: partial.length,
            offset: 0,
            html: partial,
          },
        });
        await expect.poll(() => page.locator("openclaw-widget-draft").count()).toBe(2);
        const previewHandle = {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_widget_draft",
          title: "Build results",
          url: "/__openclaw__/canvas/documents/cv_widget_draft/index.html",
          sandbox: "scripts",
        };
        await emit("tool", {
          phase: "result",
          name: "show_widget",
          toolCallId: "widget-2",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  kind: "canvas",
                  view: { id: previewHandle.viewId, url: previewHandle.url },
                  presentation: {
                    target: "assistant_message",
                    title: "Build results",
                    sandbox: "scripts",
                  },
                }),
              },
            ],
          },
        });
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: "agent:main:main",
          state: "delta",
          seq: 1,
          message: { role: "assistant", content: [{ type: "canvas", preview: previewHandle }] },
        });
        await page
          .locator(".chat-tool-card__widget-host iframe")
          .contentFrame()
          .frameLocator("iframe")
          .getByRole("heading", { name: "Finished build report" })
          .waitFor();
        expect(await page.locator("openclaw-widget-draft iframe").count()).toBe(0);
        expect(await page.locator(".chat-tool-card__widget-host").count()).toBe(1);
        const handoff = await takeControlUiScreenshotFrame(page, surface, [composer], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "widget-handoff.png"), handoff.png);
      },
    );
  });
});
