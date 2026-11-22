import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { ALCOVE_CONTENT_STYLES } from "../../packages/widget-host/src/styles.js";
import { buildSandboxHostDocument } from "../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../src/canvas/wrap.js";

void test(
  "Alcove styles follow the protected host across drafts and saved widgets",
  { timeout: 30_000 },
  async (t) => {
    const bundle = await build({
      entryPoints: ["packages/widget-host/src/protected-host.ts"],
      bundle: true,
      format: "iife",
      globalName: "WidgetHost",
      write: false,
    });
    const script = bundle.outputFiles[0];
    assert.ok(script);
    const shell = buildSandboxHostDocument({ profile: "protected" }, true, {
      protectedWidgetStyles: ALCOVE_CONTENT_STYLES,
    });
    const baselineShell = buildSandboxHostDocument({ profile: "protected" }, true);
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api/protected/v1/widget-sandbox")) {
        const selected = request.url.includes("?baseline") ? baselineShell : shell;
        response.writeHead(200, selected.headers);
        response.end(selected.html);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta name="viewport" content="width=device-width">
      <style>body{margin:0}iframe{display:block;width:100%;height:700px;border:0}</style>
      <div id="slot"></div><script>${script.text}</script>
      <script>
        window.mount = (html, theme, draft, baseline) => {
          window.host?.dispose();
          document.body.dataset.readyCount = "0";
          const frame = document.createElement("iframe");
          window.host = WidgetHost.createWidgetHost(frame, {
            html, theme, draft,
            sandboxUrl: baseline ? "/api/protected/v1/widget-sandbox?baseline" : undefined,
            onReady() { document.body.dataset.readyCount = String(Number(document.body.dataset.readyCount) + 1); },
            onPrompt() {}, onError(error) { document.body.dataset.error = error.message; }
          });
          document.querySelector("#slot").replaceChildren(frame);
        };
      </script>`);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}`);

    const fragment = `<main class="alcove"><div class="alcove-stack">
    <h1>Weekend in Kyoto</h1><p class="alcove-muted">Two days at a relaxed pace.</p>
    <div class="alcove-grid"><section class="alcove-card"><h2>Day one</h2>
      <p>Walk through the old streets.</p><span class="alcove-badge">Idea</span></section>
      <section class="alcove-card"><h2>Day two</h2><p>Visit a garden.</p></section></div>
    </div></main><script>document.body.dataset.ran="yes"</script>`;
    const saved = buildWidgetDocument("Trip", fragment);

    async function mount(
      html: string,
      theme: "light" | "dark",
      draft: boolean,
      selector = ".alcove-card",
      baseline = false,
    ) {
      await page.evaluate(
        (input) => {
          Reflect.apply(Reflect.get(window, "mount"), window, [
            input.html,
            input.theme,
            input.draft,
            input.baseline,
          ]);
        },
        { html, theme, draft, baseline },
      );
      const inner = page.locator("iframe").contentFrame().locator("iframe").contentFrame();
      await inner.locator(selector).first().waitFor();
      return inner;
    }
    const draft = await mount(fragment, "light", true);
    await page.locator('body[data-ready-count="1"]').waitFor();
    assert.equal(await draft.locator("body").getAttribute("data-ran"), null);
    const draftColor = await draft
      .locator(".alcove-card")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, width: element.getBoundingClientRect().width };
      });
    assert.ok(draftColor.width <= 390);
    assert.notEqual(draftColor.background, "rgba(0, 0, 0, 0)");

    const draftReloaded = page
      .locator("iframe")
      .contentFrame()
      .locator("body")
      .evaluate((body) => {
        return new Promise<void>((resolve) => {
          new MutationObserver(() => resolve()).observe(body, { childList: true });
          body.setAttribute("data-observing", "true");
        });
      });
    await page.locator("iframe").contentFrame().locator('body[data-observing="true"]').waitFor();
    await page.evaluate(() => {
      const host = Reflect.get(window, "host");
      Reflect.apply(Reflect.get(host, "setTheme"), host, ["dark"]);
    });
    await draftReloaded;
    const darkDraft = page.locator("iframe").contentFrame().locator("iframe").contentFrame();
    await darkDraft.locator(".alcove-card").first().waitFor();
    assert.notEqual(
      await darkDraft
        .locator(".alcove-card")
        .first()
        .evaluate((element) => {
          return getComputedStyle(element).backgroundColor;
        }),
      draftColor.background,
    );
    assert.equal(await darkDraft.locator("body").getAttribute("data-ran"), null);
    assert.equal(await page.locator("body").getAttribute("data-ready-count"), "1");

    const widget = await mount(saved, "light", false);
    await widget.locator('body[data-ran="yes"]').waitFor();
    const light = await widget
      .locator(".alcove-card")
      .first()
      .evaluate((element) => {
        return getComputedStyle(element).backgroundColor;
      });
    assert.equal(light, draftColor.background);
    const darkColor = widget
      .locator(".alcove-card")
      .first()
      .evaluate((element, previous) => {
        return new Promise<string>((resolve) => {
          const observer = new MutationObserver(() => {
            const color = getComputedStyle(element).backgroundColor;
            if (color !== previous) {
              observer.disconnect();
              resolve(color);
            }
          });
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style"],
          });
          element.setAttribute("data-observing", "true");
          const current = getComputedStyle(element).backgroundColor;
          if (current !== previous) {
            observer.disconnect();
            resolve(current);
          }
        });
      }, light);
    await widget.locator('.alcove-card[data-observing="true"]').first().waitFor();
    await page.evaluate(() => {
      const host = Reflect.get(window, "host");
      Reflect.apply(Reflect.get(host, "setTheme"), host, ["dark"]);
    });
    const dark = await darkColor;
    assert.notEqual(light, dark);
    const darkWidget = await mount(saved, "dark", false);
    assert.equal(
      await darkWidget
        .locator(".alcove-card")
        .first()
        .evaluate((element) => {
          return getComputedStyle(element).backgroundColor;
        }),
      dark,
    );

    const custom = await mount(
      buildWidgetDocument("Custom", '<div class="custom" style="color:rgb(7, 8, 9)">Custom</div>'),
      "light",
      false,
      ".custom",
    );
    assert.equal(
      await custom.locator(".custom").evaluate((element) => getComputedStyle(element).color),
      "rgb(7, 8, 9)",
    );
    assert.equal(await page.locator("body").getAttribute("data-error"), null);
    const proofDir = process.env.ALCOVE_WIDGET_PROOF_DIR;
    if (proofDir) {
      await page.setViewportSize({ width: 900, height: 800 });
      await mount(saved, "light", false, ".alcove-card", true);
      await page.screenshot({ path: path.join(proofDir, "widget-before.png") });
      await mount(saved, "light", false);
      await page.screenshot({ path: path.join(proofDir, "widget-after.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await mount(saved, "dark", false);
      await page.screenshot({ path: path.join(proofDir, "widget-phone-dark.png") });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setContent(
      `<!doctype html><meta name="viewport" content="width=device-width"><style>${ALCOVE_CONTENT_STYLES}</style>${fragment}`,
    );
    const standaloneLight = await page
      .locator(".alcove-card")
      .first()
      .evaluate((element) => {
        return getComputedStyle(element).backgroundColor;
      });
    await page.emulateMedia({ colorScheme: "dark" });
    const standaloneDark = await page
      .locator(".alcove-card")
      .first()
      .evaluate((element) => {
        return getComputedStyle(element).backgroundColor;
      });
    assert.notEqual(standaloneLight, standaloneDark);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    );
  },
);
