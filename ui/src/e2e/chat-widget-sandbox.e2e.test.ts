// Real Chromium, HTTP authentication, and sandbox isolation around mocked Gateway data.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Route } from "playwright";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  installWidgetPromptDiagnostics,
  retainWidgetPromptFailure,
} from "./chat-widget-sandbox.diagnostics.test-support.ts";
import {
  close,
  edgeCookie,
  listen,
  sourceAuthorization,
  startProtectedSource,
} from "./chat-widget-sandbox.fixture.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI authenticated widget sandbox",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:widget-sandbox-proof";
const documentId = "widget-sandbox-proof";
const documentPath = `/__openclaw__/canvas/documents/${documentId}/index.html`;
const widgetName = `canvas-${documentId}`;
const boardPath = `/__openclaw__/board/${encodeURIComponent(sessionKey)}/${widgetName}/index.html`;

function widgetDocument(moduleRenderer: boolean): string {
  return buildWidgetDocument(
    "Community pulse",
    `<style>
      body{margin:0;padding:24px;background:var(--surface);color:var(--text);font:15px system-ui}
      h1{margin:10px 0;font-size:26px}p{line-height:1.5;color:var(--text-muted)}
      .eyebrow{font-size:11px;letter-spacing:.15em;color:var(--accent)}
      label{display:block;margin-top:20px}input{box-sizing:border-box;width:100%;padding:10px;
        margin:8px 0 16px;background:var(--surface-raised);color:var(--text);border:1px solid var(--border);border-radius:6px}
      button{padding:10px 12px;margin:0 6px 8px 0;border:1px solid var(--border);
        background:var(--surface-raised);color:var(--text);border-radius:6px;cursor:pointer}
      output{display:block;margin-top:12px}.details{height:540px;padding-top:20px}
    </style>
    <div class="eyebrow">SYNTHETIC COMMUNITY DASHBOARD</div>
    <h1>Community pulse</h1>
    <p>The same interactive document is available in chat and in the dashboard.</p>
    <label>Local note<input aria-label="Local note" placeholder="State stays in this widget"></label>
    <button id="refresh">Refresh via chat</button><button id="details">Toggle details</button>
    <button id="data">Try dashboard data</button><button id="record">Record state</button>
    <button id="popup">Try native popup</button>
    <output id="popup-result" aria-label="Popup result"></output>
    <output id="result" aria-label="Widget result">Ready</output>
    <output id="static-renderer">Static renderer pending</output>
    <script${moduleRenderer ? ' type="module"' : ""} src="/__openclaw__/renderer/static.js"></script>
    <output id="dynamic-renderer">Dynamic renderer pending</output>
    <script>
      const renderer=document.createElement('script');
      renderer.src='/__openclaw__/renderer/dynamic.js';
      renderer.onload=()=>{document.querySelector('#dynamic-renderer').dataset.loaded='true';};
      document.head.appendChild(renderer);
    </script>
    <div id="extra" class="details" hidden>Additional community details</div>
    <script>
      (()=>{
        const nativeOpen=window.open;
        document.querySelector('#popup').onclick=()=>{
          document.querySelector('#popup-result').textContent=
            !navigator.userActivation.isActive?'No user activation':
              nativeOpen.call(window,'about:blank','_blank')===null?'Popup blocked':'Popup opened';
        };
      })();
    </script>
    <script>
      function open(){const extra=document.querySelector('#extra');extra.hidden=!extra.hidden;}
      document.querySelector('#refresh').onclick=()=>window.openclaw.prompt.send('Refresh the synthetic dashboard');
      document.querySelector('#details').onclick=open;
      document.querySelector('#data').onclick=async()=>{try{await window.openclaw.data.read('private-dashboard');
        document.querySelector('#result').textContent='Unexpected data access';}
        catch{document.querySelector('#result').textContent='Dashboard data is unavailable in chat';}};
      document.querySelector('#record').onclick=async()=>{await window.openclaw.state.emit({clicked:true});
        document.querySelector('#result').textContent='State recorded';};
    </script>`,
    { scriptOrigins: ["http://127.0.0.1:*"] },
  );
}

suite.define(() => {
  it.each([false, true])(
    "loads protected widgets and preserves isolated frames (sameOriginSandbox=%s)",
    async (sameOriginSandbox) => {
      // Dedicated public resources use classic scripts; embedded resources can also be modules.
      const savedHtml = widgetDocument(sameOriginSandbox);
      const proxy = await startProtectedSource({
        html: savedHtml,
        upstream: suite.server.baseUrl,
        documentPath,
        boardPath,
        sameOriginSandbox,
      });
      const html = proxy.html;
      const sandboxServer = sameOriginSandbox
        ? undefined
        : createSandboxHostHttpServer(undefined, () => proxy.registry);
      const sandboxPort = sandboxServer
        ? await listen(sandboxServer)
        : Number(new URL(proxy.baseUrl).port);
      const sandboxUrl = buildSandboxHostPath({ blockDescendantFrames: true }, sameOriginSandbox);
      const snapshot = {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
        widgets: [
          {
            name: widgetName,
            tabId: "main",
            title: "Community pulse",
            contentKind: "html",
            sizeW: 12,
            sizeH: 5,
            position: 0,
            grantState: "none",
            revision: 1,
            frameUrl: `${new URL(proxy.baseUrl).origin}${boardPath}?bt=ticket`,
            viewTicket: "ticket",
            viewTicketTtlMs: 1_200_000,
            viewGeneration: "0123456789abcdef0123456789abcdef",
            sandboxUrl,
            sandboxPort,
            sameOriginSandbox,
          },
        ],
      };
      try {
        const unauthenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
          redirect: "manual",
        });
        expect(unauthenticated.status).toBe(302);
        const authenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
          headers: { Authorization: sourceAuthorization, Cookie: edgeCookie },
        });
        expect(await authenticated.text()).toBe(savedHtml);
        if (sameOriginSandbox) {
          const unavailable = await fetch(
            new URL("/__openclaw__/renderer/static.js", proxy.baseUrl),
            {
              redirect: "manual",
            },
          );
          expect(unavailable.status).toBe(302);
        }

        let completed = false;
        await suite.withPage(
          {
            viewport: { width: 1600, height: 1000 },
            serviceWorkers: sameOriginSandbox ? "allow" : "block",
            permissions: ["local-network-access"],
            recordVideo: { dir: suite.artifactDir, size: { width: 1600, height: 1000 } },
          },
          async ({ page, context }) => {
            const shellResponses: boolean[] = [];
            page.on("response", (response) => {
              if (new URL(response.url()).pathname === "/mcp-app-sandbox") {
                shellResponses.push(response.fromServiceWorker());
              }
            });
            if (sameOriginSandbox) {
              await context.addCookies([
                {
                  name: "synthetic_widget_edge",
                  value: "allowed",
                  url: proxy.baseUrl,
                  httpOnly: true,
                  sameSite: "Strict",
                },
              ]);
              await page.goto(new URL("/widget-login", proxy.baseUrl).href);
              await page.evaluate(async () => {
                await navigator.serviceWorker.register("/sw.js");
                await navigator.serviceWorker.ready;
              });
              await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
            }
            await installWidgetPromptDiagnostics(context);
            const storageKey = controlUiBundledSettingsStorageKey(proxy.baseUrl);
            await page.addInitScript(
              ({ key, session }) => {
                // Init scripts also run in opaque widget frames, which cannot read storage.
                if (window !== window.top) {
                  return;
                }
                const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
                settings.boardSessionViews = { [session]: { activeTabId: "main" } };
                localStorage.setItem(key, JSON.stringify(settings));
              },
              { key: storageKey, session: sessionKey },
            );
            const gateway = await installMockGateway(page, {
              sessionKey,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                "board.get",
                "board.event",
                "canvas.document.view",
              ],
              historyMessages: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: `[embed ref="${documentId}" title="Community pulse" height="460" /]`,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ],
              methodResponses: {
                "canvas.document.view": { html, sandboxUrl, sandboxPort, sameOriginSandbox },
                "board.get": snapshot,
                "board.event": { ok: true, appended: true },
              },
            });
            const outer = page.locator(".chat-tool-card__preview-frame");
            let releaseConfig!: () => void;
            const configReady = new Promise<void>((resolve) => {
              releaseConfig = resolve;
            });
            const holdConfig = async (route: Route) => {
              await configReady;
              await route.fallback();
            };
            const configRoute = `**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;
            // The page hold precedes the mock bootstrap's page route; only the context
            // hold sees fetches forwarded by the Control UI service worker.
            await page.route(configRoute, holdConfig);
            await context.route(configRoute, holdConfig);
            try {
              await page.goto(controlUiSessionUrl(proxy.baseUrl, sessionKey, "dashboard"));
              await outer.waitFor();
              // Chat can render before bootstrap resolves; strict mode must still authenticate.
              const strict = outer.contentFrame();
              await strict.getByRole("heading", { name: "Community pulse" }).waitFor();
              await expect
                .poll(() => strict.locator("body").evaluate(() => document.readyState))
                .toBe("complete");
              expect(await outer.getAttribute("sandbox")).toBe("");
              await strict.getByRole("button", { name: "Toggle details" }).click();
              expect(await strict.locator("#extra").isVisible()).toBe(false);
              await strict.getByRole("button", { name: "Refresh via chat" }).click();
              expect(await gateway.getRequests("chat.send")).toEqual([]);
              expect(
                proxy.sourceRequests.filter(({ destination }) => destination !== undefined),
              ).toEqual([]);
              await page.screenshot({
                path: path.join(suite.artifactDir, "01-auth-gated-widget.png"),
              });
            } finally {
              await page.unroute(configRoute, holdConfig);
              await context.unroute(configRoute, holdConfig);
              releaseConfig();
            }
            const boardOuter = page.locator(".board-widget__frame");
            const board = boardOuter.contentFrame().frameLocator("iframe");
            await board.getByRole("heading", { name: "Community pulse" }).waitFor();
            const inline = outer.contentFrame().frameLocator("iframe");
            await inline.getByRole("heading", { name: "Community pulse" }).waitFor();
            expect(
              proxy.sourceRequests.filter(({ destination }) => destination !== undefined),
            ).toEqual([]);
            expect((await gateway.getRequests("canvas.document.view"))[0]?.params).toEqual({
              docId: documentId,
            });
            expect(proxy.boardRequests).toEqual(["ticket"]);
            for (const widget of [inline, board]) {
              await widget.getByText("Static renderer ready", { exact: true }).waitFor();
              await widget.getByText("Dynamic renderer ready", { exact: true }).waitFor();
              expect(await widget.locator("#dynamic-renderer").getAttribute("data-loaded")).toBe(
                "true",
              );
              await clickBoardWidgetControl(
                page,
                widget.getByRole("button", { name: "Toggle details" }),
              );
              await widget.getByText("Additional community details").waitFor();
              await clickBoardWidgetControl(
                page,
                widget.getByRole("button", { name: "Toggle details" }),
              );
              await widget.getByText("Additional community details").waitFor({ state: "hidden" });
              await clickBoardWidgetControl(
                page,
                widget.getByRole("button", { name: "Try native popup" }),
              );
              await widget.getByText("Popup blocked", { exact: true }).waitFor();
            }
            await page.screenshot({
              path: path.join(suite.artifactDir, "02-inline-and-sidebar.png"),
            });

            const isolation = await inline.locator("body").evaluate(() => {
              const denied = (read: () => unknown) => {
                try {
                  read();
                  return false;
                } catch {
                  return true;
                }
              };
              return {
                topDom: denied(() => window.top?.document),
                wrapperDom: denied(() => window.parent.document),
                cookies: denied(() => document.cookie),
                localStorage: denied(() => window.localStorage),
              };
            });
            expect(isolation).toEqual({
              topDom: true,
              wrapperDom: true,
              cookies: true,
              localStorage: true,
            });
            if (sameOriginSandbox) {
              expect(await outer.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
              expect(proxy.shellRequests.length).toBeGreaterThan(0);
              expect(proxy.shellRequests.every(Boolean)).toBe(true);
              expect(shellResponses.length).toBeGreaterThan(0);
              expect(shellResponses.every((fromWorker) => !fromWorker)).toBe(true);
              expect(
                proxy.rendererRequests.filter(({ destination }) => destination === "script"),
              ).toEqual([]);
              expect(
                await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
              ).toContain("/sw.js");
              expect(
                await outer
                  .contentFrame()
                  .locator("body")
                  .evaluate(() => {
                    try {
                      return Boolean(window.top?.document);
                    } catch {
                      return false;
                    }
                  }),
              ).toBe(false);
            }
            await inline.getByRole("button", { name: "Try dashboard data" }).click();
            await inline.getByText("Dashboard data is unavailable in chat").waitFor();
            expect(await gateway.getRequests("board.data.read")).toEqual([]);

            const retainedFrame = await outer.elementHandle();
            const retainedBoardFrame = await boardOuter.elementHandle();
            const note = inline.getByRole("textbox", { name: "Local note" });
            const boardNote = board.getByRole("textbox", { name: "Local note" });
            await note.fill("State survives rerenders");
            await boardNote.fill("Dashboard state survives swaps");
            for (const region of ["main", "side"]) {
              await page.locator(".chat-panel-swap").click();
              await expect
                .poll(() =>
                  page.locator('[data-panel-slot="dashboard"]').getAttribute("data-region"),
                )
                .toBe(region);
              expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
              expect(await retainedBoardFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
              expect(await note.inputValue()).toBe("State survives rerenders");
              expect(await boardNote.inputValue()).toBe("Dashboard state survives swaps");
            }
            const originalHeight = (await outer.boundingBox())?.height ?? 0;
            await clickBoardWidgetControl(
              page,
              inline.getByRole("button", { name: "Toggle details" }),
            );
            await expect
              .poll(async () => (await outer.boundingBox())?.height ?? 0)
              .toBeGreaterThan(originalHeight + 400);
            expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await note.inputValue()).toBe("State survives rerenders");
            await clickBoardWidgetControl(
              page,
              inline.getByRole("button", { name: "Toggle details" }),
            );

            await clickBoardWidgetControl(
              page,
              inline.getByRole("button", { name: "Refresh via chat" }),
            );
            const sent = asRecord((await gateway.waitForRequest("chat.send")).params);
            expect(sent).toMatchObject({
              sessionKey,
              message: "Refresh the synthetic dashboard",
              idempotencyKey: expect.any(String),
            });
            const runId = String(sent.idempotencyKey);
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId,
              seq: 1,
              state: "delta",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Refreshing community signals…" }],
              },
            });
            await page
              .getByRole("paragraph")
              .filter({ hasText: /^Refreshing community signals…$/u })
              .waitFor();
            await gateway.emitChatFinal({
              sessionKey,
              runId,
              text: "Synthetic dashboard refreshed.",
            });
            await page
              .getByRole("paragraph")
              .filter({ hasText: /^Synthetic dashboard refreshed\.$/u })
              .waitFor();
            expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await note.inputValue()).toBe("State survives rerenders");
            expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);

            await clickBoardWidgetControl(
              page,
              board.getByRole("button", { name: "Record state" }),
            );
            await board.getByText("State recorded", { exact: true }).waitFor();
            expect((await gateway.getRequests("board.event"))[0]?.params).toEqual({
              ticket: "ticket",
              payload: { clicked: true },
            });
            await page.emulateMedia({ colorScheme: "dark" });
            await expect
              .poll(() =>
                inline.locator("html").evaluate((root) => getComputedStyle(root).colorScheme),
              )
              .toBe("dark");
            // A light proxy between dark documents paints an opaque UA canvas.
            await expect
              .poll(() =>
                outer
                  .contentFrame()
                  .locator("html")
                  .evaluate((root) => getComputedStyle(root).colorScheme),
              )
              .toBe("dark");
            await expect
              .poll(() =>
                board.locator("html").evaluate((root) => getComputedStyle(root).colorScheme),
              )
              .toBe("dark");
            expect(await note.inputValue()).toBe("State survives rerenders");
            await outer.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: path.join(suite.artifactDir, "03-interactive-state-retained.png"),
            });
            await writeFile(
              path.join(suite.artifactDir, "evidence.json"),
              JSON.stringify(
                {
                  isolation,
                  sourceRequests: proxy.sourceRequests,
                  boardRequests: proxy.boardRequests,
                  canvasReads: (await gateway.getRequests("canvas.document.view")).length,
                  prompt: sent.message,
                  localNote: await note.inputValue(),
                  dashboardLocalNote: await boardNote.inputValue(),
                  retainedFrame: await retainedFrame?.evaluate((frame) => frame.isConnected),
                  retainedDashboardFrame: await retainedBoardFrame?.evaluate(
                    (frame) => frame.isConnected,
                  ),
                },
                null,
                2,
              ),
            );
            // Saved HTML has no generated wrapper; the sandbox runtime owns shortcuts.
            // A context route also sees board loads forwarded by the service worker.
            await context.route(`${new URL(boardPath, proxy.baseUrl).href}?*`, (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><input aria-label="Saved dashboard note">
                <button onclick="parent.postMessage({type:'openclaw:widget-command-palette',
                  nonce:window.shortcutNonce||window.scrollNonce},'*');
                  parent.postMessage({type:'fixture-shortcut-attempted'},'*');">Attempt shortcut</button>
                <script>window.addEventListener('message',event=>{
                  if(event.data?.type==='openclaw:widget-board-host')window.scrollNonce=event.data.nonce;
                  if(event.data?.type==='openclaw:widget-shortcut-host')window.shortcutNonce=event.data.nonce;
                });</script>`,
              }),
            );
            await gateway.setMethodResponse("board.get", {
              ...snapshot,
              revision: 2,
              widgets: [{ ...snapshot.widgets[0], revision: 2 }],
            });
            await gateway.emitGatewayEvent("board.changed", { sessionKey });
            const savedNote = board.getByRole("textbox", { name: "Saved dashboard note" });
            await savedNote.fill("Saved draft");
            expect(
              await savedNote.evaluate((element) => {
                const event = new KeyboardEvent("keydown", {
                  key: "k",
                  code: "KeyK",
                  ctrlKey: true,
                  bubbles: true,
                  cancelable: true,
                });
                element.dispatchEvent(event);
                return event.defaultPrevented;
              }),
            ).toBe(false);
            await page.keyboard.press("ControlOrMeta+K");
            const paletteInput = page.locator(".cmd-palette__input");
            await paletteInput.waitFor();
            await page.keyboard.type("Settings");
            expect(await paletteInput.inputValue()).toBe("Settings");
            await page.keyboard.press("Escape");
            await paletteInput.waitFor({ state: "hidden" });
            await expect
              .poll(() =>
                savedNote.evaluate(
                  (element) => document.hasFocus() && document.activeElement === element,
                ),
              )
              .toBe(true);
            await page.keyboard.type("!");
            expect(await savedNote.inputValue()).toBe("Saved draft!");
            expect(
              await savedNote.evaluate(() => Boolean(Reflect.get(window, "scrollNonce"))),
            ).toBe(false);
            await page.evaluate(() => {
              window.addEventListener("message", function settle(event) {
                if (event.data?.type === "fixture-shortcut-attempted") {
                  window.removeEventListener("message", settle);
                  Reflect.set(window, "shortcutForgerySettled", true);
                }
              });
            });
            await board.getByRole("button", { name: "Attempt shortcut", exact: true }).click();
            await page.waitForFunction(
              () => Reflect.get(window, "shortcutForgerySettled") === true,
            );
            expect(await page.locator(".cmd-palette__input").count()).toBe(0);
            await savedNote.focus();
            await savedNote.evaluate(() => {
              Reflect.set(
                window,
                "keyboardDescriptors",
                Object.getOwnPropertyDescriptors(KeyboardEvent.prototype),
              );
              Object.defineProperties(KeyboardEvent.prototype, {
                key: { configurable: true, get: () => "k" },
                ctrlKey: { configurable: true, get: () => true },
                metaKey: { configurable: true, get: () => false },
              });
            });
            await page.keyboard.press("j");
            expect(await savedNote.inputValue()).toBe("Saved draft!j");
            expect(await page.locator(".cmd-palette__input").count()).toBe(0);
            await savedNote.evaluate(() => {
              Object.defineProperties(
                KeyboardEvent.prototype,
                Reflect.get(window, "keyboardDescriptors"),
              );
            });
            if (sameOriginSandbox) {
              await context.unroute(`${new URL(boardPath, proxy.baseUrl).href}?*`);
              // The shared E2E bundle is a development build, whose boot unregisters
              // service workers. Restore the registration a production client keeps
              // so the reload starts under worker control.
              await page.evaluate(async () => {
                await navigator.serviceWorker.register("/sw.js");
                await navigator.serviceWorker.ready;
              });
              const shellResponsesBeforeReload = shellResponses.length;
              await page.reload();
              await inline.getByText("Dynamic renderer ready", { exact: true }).waitFor();
              expect(
                await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
              ).toContain("/sw.js");
              const reloadedShellResponses = shellResponses.slice(shellResponsesBeforeReload);
              expect(reloadedShellResponses.length).toBeGreaterThan(0);
              expect(reloadedShellResponses.every((fromWorker) => !fromWorker)).toBe(true);
            }
            completed = true;
          },
          async ({ page }) => {
            if (!completed) {
              await retainWidgetPromptFailure(page, suite.artifactDir);
            }
          },
        );
      } finally {
        await runQaGatewayFixture(
          () => close(proxy.server),
          async () => {
            if (sandboxServer) {
              await close(sandboxServer);
            }
          },
        );
      }
    },
  );
});
