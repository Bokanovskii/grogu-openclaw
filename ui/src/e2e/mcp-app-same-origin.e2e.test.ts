import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import { describe, expect, it } from "vitest";
import { handleMcpAppSandboxHttpRequest } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  handleMcpAppStandaloneHttpRequest,
  issueTicket,
  resetStandaloneMcpAppTestState,
  runtime,
  view,
} from "../../../src/gateway/mcp-app-standalone.http.test-support.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";
import { appHtml } from "../test-helpers/mcp-app-conformance-fixture.ts";
import { close, edgeCookie, listen } from "./chat-widget-sandbox.fixture.test-support.ts";

const require = createRequire(import.meta.url);
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeBrowser = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

describeBrowser("Standalone MCP App single-origin hosting", () => {
  it("initializes and serves tools behind a cookie-protected edge without sharing its origin", async () => {
    resetStandaloneMcpAppTestState();
    const originalHtml = view.html;
    const module = await readFile(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
    view.html = appHtml(`data:text/javascript;base64,${module.toString("base64")}`);
    const requests: Array<{ path: string; method: string; authorized: boolean }> = [];
    let port = 0;
    let browser: Browser | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const authorized = request.headers.cookie?.split("; ").includes(edgeCookie) === true;
        requests.push({ path, method: request.method ?? "GET", authorized });
        if (!authorized) {
          response.writeHead(401);
          response.end("Synthetic edge authentication required");
          return;
        }
        if (
          handleMcpAppSandboxHttpRequest(request, response, true) ||
          (await handleMcpAppStandaloneHttpRequest(request, response, {
            gatewayPort: port,
            sameOriginSandbox: true,
          }))
        ) {
          return;
        }
        response.writeHead(404);
        response.end();
      })().catch((error: unknown) => {
        console.error("Standalone MCP fixture request failed", error);
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      });
    });
    try {
      port = await listen(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      browser = await chromium.launch({ executablePath: chromiumExecutablePath });
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: "synthetic_widget_edge",
          value: "allowed",
          url: baseUrl,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const issued = issueTicket({ sessionKey: "agent:main:main", view });
      const page = await context.newPage();
      await page.goto(`${baseUrl}${issued.url}`);
      const app = page.frameLocator("#host > iframe").frameLocator("iframe");
      await expect.poll(() => app.locator("#initialized").textContent()).toBe("ready");
      expect(await app.locator("#isolation").textContent()).toBe("isolated");
      await expect.poll(() => app.locator("#input").textContent()).toBe('{"city":"Paris"}');
      await app.locator("#list-tools").click();
      await expect.poll(() => app.locator("#tools").textContent()).toContain('"app-only"');
      expect(await app.locator("#tools").textContent()).not.toContain('"model-only"');
      expect(runtime.listTools).toHaveBeenCalledOnce();
      const frame = page.locator("#host > iframe");
      expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      const source = await frame.getAttribute("src");
      expect(source && new URL(source).origin).toBe(baseUrl);
      for (const [path, method] of [
        ["/mcp-app-sandbox", "GET"],
        ["/__openclaw__/mcp-app/view", "GET"],
        ["/__openclaw__/mcp-app/view", "POST"],
      ]) {
        const matching = requests.filter(
          (request) => request.path === path && request.method === method,
        );
        expect(matching.length).toBeGreaterThan(0);
        expect(matching.every((request) => request.authorized)).toBe(true);
      }
    } finally {
      await browser?.close();
      if (server.listening) {
        await close(server);
      }
      view.html = originalHtml;
    }
  });
});
