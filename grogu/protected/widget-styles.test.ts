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
        window.mount = (html, theme, draft, baseline, themeTokens) => {
          window.host?.dispose();
          document.body.dataset.readyCount = "0";
          delete document.body.dataset.atTop;
          const frame = document.createElement("iframe");
          window.host = WidgetHost.createWidgetHost(frame, {
            html, theme, draft, themeTokens,
            sandboxUrl: baseline ? "/api/protected/v1/widget-sandbox?baseline" : undefined,
            onReady() { document.body.dataset.readyCount = String(Number(document.body.dataset.readyCount) + 1); },
            onScrollTopChange(atTop) { document.body.dataset.atTop = String(atTop); },
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
          server.close((error) => {
            if (error) {
              reject(new Error("Could not close the widget proof server.", { cause: error }));
            } else {
              resolve();
            }
          });
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
      themeTokens?: Record<string, string>,
    ) {
      await page.evaluate(
        (input) => {
          Reflect.apply(Reflect.get(window, "mount"), window, [
            input.html,
            input.theme,
            input.draft,
            input.baseline,
            input.themeTokens,
          ]);
        },
        { html, theme, draft, baseline, themeTokens },
      );
      const inner = page.locator("iframe").contentFrame().locator("iframe").contentFrame();
      await inner.locator(selector).first().waitFor();
      return inner;
    }
    await t.test(
      "a saved artifact reports when its own viewport leaves and returns to the top",
      async () => {
        const tall = await mount(
          '<!doctype html><main style="height:4000px">Tall page</main>',
          "light",
          false,
          "main",
        );
        await page.locator('body[data-ready-count="1"]').waitFor();
        const scrollPage = (y: number) =>
          tall.locator("main").evaluate((_main, top) => window.scrollTo(0, top), y);
        await scrollPage(650);
        assert.ok(await tall.locator("main").evaluate(() => window.scrollY > 0));
        await page.locator('body[data-at-top="false"]').waitFor({ timeout: 4000 });
        await scrollPage(0);
        await page.locator('body[data-at-top="true"]').waitFor({ timeout: 4000 });
        assert.equal(await page.evaluate(() => window.scrollY), 0);
      },
    );
    await t.test("generic cards preserve the surrounding palette", async (cards) => {
      const itinerary = `<style>
        .itinerary { background: white; color: #202322; padding: 20px; font: 16px/1.5 system-ui }
        .itinerary h2 { color: inherit; font: bold 22px/1.3 system-ui; margin: 0 0 16px }
        .itinerary section { padding: 16px; border-radius: 12px; margin-top: 12px }
        .station { background: #e2efec; color: #204b40 }
        </style><main class="itinerary"><h2>Weekend by rail</h2>
        <section class="card"><strong>Saturday · Riverside</strong>
        <ul><li>Walk along the river before lunch.</li><li>Take the afternoon train to the gardens.</li></ul></section>
        <section class="card station"><strong>Meeting point</strong><br>North entrance, platform two.</section></main>
        <aside style="color:#202322"><div class="card" style="background:#e2efec">Inherited ink</div>
        <div class="card" style="background:var(--card);color:var(--text)">Themed pair</div></aside>`;
      // Minimal serialized head from a released wrapper, independent of today's CSS.
      const retained = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Weekend by rail</title><style>:root{color-scheme:light dark;--card:#17211d;--text:#e8ede7}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}</style></head><body>${itinerary}</body></html>`;
      for (const [theme, tokens] of [
        ["light", { card: "rgb(250, 250, 247)", text: "rgb(43, 48, 44)" }],
        ["dark", { card: "rgb(23, 33, 29)", text: "rgb(232, 237, 231)" }],
      ] as const) {
        for (const kind of ["saved", "draft", ...(theme === "dark" ? ["retained"] : [])]) {
          await cards.test(`${theme} ${kind}`, async () => {
            const inner = await mount(
              kind === "retained"
                ? retained
                : kind === "draft"
                  ? itinerary
                  : buildWidgetDocument("Weekend by rail", itinerary),
              theme,
              kind === "draft",
              ".itinerary",
              false,
              tokens,
            );
            await page.locator('body[data-ready-count="1"]').waitFor();
            if (kind === "saved" && process.env.ALCOVE_WIDGET_PROOF_DIR) {
              await inner.locator("main").screenshot({
                path: path.join(process.env.ALCOVE_WIDGET_PROOF_DIR, `itinerary-${theme}.png`),
              });
            }
            assert.deepEqual(
              await inner.locator(".card").evaluateAll((elements) =>
                elements.map((card) => ({
                  card: getComputedStyle(card).backgroundColor,
                  text: getComputedStyle(card).color,
                })),
              ),
              [
                { card: "rgba(0, 0, 0, 0)", text: "rgb(32, 35, 34)" },
                { card: "rgb(226, 239, 236)", text: "rgb(32, 75, 64)" },
                { card: "rgb(226, 239, 236)", text: "rgb(32, 35, 34)" },
                tokens,
              ],
            );
          });
        }
      }
    });
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
    for (const [height, expected] of [
      [10, 120],
      [315.2, 316],
      [2000, 1200],
      [Number.NaN, 1200],
    ]) {
      await page.evaluate((rawHeight) => {
        const host = Reflect.get(window, "host");
        Reflect.apply(Reflect.get(host, "setHeight"), host, [rawHeight]);
      }, height);
      assert.equal(
        await page.locator("iframe").evaluate((frame) => frame.getBoundingClientRect().height),
        expected,
      );
    }

    const draftReloaded = page
      .locator("iframe")
      .contentFrame()
      .locator("body")
      .evaluate((body) => {
        return new Promise<{ buffered: boolean; retained: boolean }>((resolve) => {
          const previous = body.querySelector("iframe");
          let buffered = false;
          let retained = true;
          const observer = new MutationObserver(() => {
            const frames = body.querySelectorAll("iframe");
            if (frames.length === 2) {
              buffered = true;
              retained &&= previous?.isConnected === true && previous.style.visibility !== "hidden";
            } else if (frames.length === 1) {
              observer.disconnect();
              resolve({ buffered, retained });
            }
          });
          observer.observe(body, { childList: true });
          body.setAttribute("data-observing", "true");
        });
      });
    await page.locator("iframe").contentFrame().locator('body[data-observing="true"]').waitFor();
    await page.evaluate(() => {
      const host = Reflect.get(window, "host");
      Reflect.apply(Reflect.get(host, "setTheme"), host, ["light"]);
      Reflect.apply(Reflect.get(host, "setTheme"), host, ["dark"]);
      Reflect.apply(Reflect.get(host, "setTheme"), host, ["dark"]);
    });
    assert.deepEqual(await draftReloaded, { buffered: true, retained: true });
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
      buildWidgetDocument(
        "Custom",
        '<div class="custom" style="color:rgb(7, 8, 9);background:white"><h2>Fixed white background</h2>Custom</div>',
      ),
      "dark",
      false,
      ".custom",
      false,
      { "text-strong": "rgb(210, 220, 230)" },
    );
    assert.equal(
      await custom.locator(".custom").evaluate((element) => getComputedStyle(element).color),
      "rgb(7, 8, 9)",
    );
    assert.equal(
      await custom
        .locator(".custom")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(255, 255, 255)",
    );
    assert.equal(
      await custom.locator("h2").evaluate((element) => getComputedStyle(element).color),
      "rgb(210, 220, 230)",
    );
    const lightFallback = custom.locator("h2").evaluate((element) => {
      return new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve(getComputedStyle(element).color);
        });
        observer.observe(document.documentElement, { attributes: true });
        element.setAttribute("data-observing-fallback", "true");
      });
    });
    await custom.locator('[data-observing-fallback="true"]').waitFor();
    await page.evaluate(() => {
      const host = Reflect.get(window, "host");
      Reflect.apply(Reflect.get(host, "setTheme"), host, [
        "light",
        { "text-strong": "rgb(22, 33, 44)" },
      ]);
    });
    assert.equal(await lightFallback, "rgb(22, 33, 44)");
    assert.equal(
      await custom
        .locator(".custom")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(255, 255, 255)",
    );
    assert.equal(await page.locator("body").getAttribute("data-error"), null);
    const tokenMarkup = `<section class="token-card" style="height:316px;background:var(--card);color:var(--text);font-family:var(--font-body)">
      <h2 style="color:var(--text-strong)">Theme snapshot</h2>
      <p>Background and text follow the host.</p>
    </section><script>
      parent.postMessage({method:"ui/notifications/sandbox-resource-loaded",params:{renderId:"wrong"}},"*");
      try { parent.document.body.dataset.unsafe="yes"; } catch {}
      addEventListener("message", event => {
        if (event.data?.type === "openclaw:widget-theme") {
          document.body.dataset.privateTokenReceived = String("not-a-widget-token" in event.data.tokens);
        }
      });
    </script>`;
    const snapshot = {
      card: "oklch(98% 0.01 150)",
      text: "rgb(11, 22, 33)",
      "text-strong": "rgb(22, 33, 44)",
      "font-body": '"Snapshot Font", monospace',
      border: "rgb(1, 2, 3)",
      "font-mono": '"</style><div data-theme-injected>bad</div><style>"',
      "not-a-widget-token": "synthetic private value",
    };
    for (const isDraft of [true, false]) {
      const themed = await mount(
        isDraft ? tokenMarkup : buildWidgetDocument("Tokens", tokenMarkup),
        "light",
        isDraft,
        ".token-card",
        false,
        snapshot,
      );
      await page.locator('body[data-ready-count="1"]').waitFor();
      const proofDir = process.env.ALCOVE_WIDGET_PROOF_DIR;
      if (proofDir && isDraft) {
        await page.screenshot({ path: path.join(proofDir, "widget-tokens-light.png") });
      }
      const styles = await themed.locator(".token-card").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          card: style.backgroundColor,
          text: style.color,
          font: style.fontFamily,
          privateValue: getComputedStyle(document.documentElement).getPropertyValue(
            "--not-a-widget-token",
          ),
        };
      });
      assert.equal(styles.card, "oklch(0.98 0.01 150)");
      assert.equal(styles.text, "rgb(11, 22, 33)");
      assert.equal(styles.font, '"Snapshot Font", monospace');
      assert.equal(styles.privateValue, "");
      assert.equal(await themed.locator("[data-theme-injected]").count(), 0);
      if (isDraft) {
        assert.equal(await page.locator("body").getAttribute("data-unsafe"), null);
        assert.equal(
          await page.locator("iframe").evaluate((frame) => {
            if (!(frame instanceof HTMLIFrameElement)) {
              throw new Error("Expected the protected widget frame.");
            }
            return frame.contentDocument;
          }),
          null,
        );
        assert.equal(
          await page.locator("iframe").contentFrame().locator("iframe").getAttribute("sandbox"),
          "",
        );
      } else {
        await themed.locator('body[data-private-token-received="false"]').waitFor();
      }
      const changed = isDraft
        ? page
            .locator("iframe")
            .contentFrame()
            .locator("body")
            .evaluate((body) => {
              return new Promise<void>((resolve) => {
                const observer = new MutationObserver(() => {
                  if (body.querySelectorAll("iframe").length === 1) {
                    observer.disconnect();
                    resolve();
                  }
                });
                observer.observe(body, { childList: true });
                body.dataset.observingTokens = "true";
              });
            })
        : themed.locator(".token-card").evaluate((element) => {
            return new Promise<void>((resolve) => {
              const observer = new MutationObserver(() => {
                observer.disconnect();
                resolve();
              });
              observer.observe(document.documentElement, { attributes: true });
              element.setAttribute("data-observing-tokens", "true");
            });
          });
      await (
        isDraft
          ? page.locator("iframe").contentFrame().locator('body[data-observing-tokens="true"]')
          : themed.locator('[data-observing-tokens="true"]')
      ).waitFor();
      await page.evaluate(
        (mode) => {
          const host = Reflect.get(window, "host");
          Reflect.apply(Reflect.get(host, "setTheme"), host, [
            mode,
            {
              card: "rgb(20, 30, 40)",
              text: "rgb(210, 220, 230)",
              "text-strong": "rgb(230, 240, 250)",
              "font-body": '"Snapshot Font", monospace',
            },
          ]);
        },
        isDraft ? "light" : "dark",
      );
      await changed;
      const updated = page.locator("iframe").contentFrame().locator("iframe").contentFrame();
      await updated.locator(".token-card").waitFor();
      assert.deepEqual(
        await updated.locator(".token-card").evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          text: getComputedStyle(element).color,
        })),
        { background: "rgb(20, 30, 40)", text: "rgb(210, 220, 230)" },
      );
      assert.notEqual(
        await updated
          .locator("html")
          .evaluate((root) => getComputedStyle(root).getPropertyValue("--border")),
        "rgb(1, 2, 3)",
      );
      if (proofDir && isDraft) {
        await page.screenshot({ path: path.join(proofDir, "widget-tokens-updated.png") });
      }
      assert.equal(await page.locator("body").getAttribute("data-ready-count"), "1");
      assert.equal(await page.locator("body").getAttribute("data-unsafe"), null);
      assert.equal(await page.locator("body").getAttribute("data-error"), null);
    }
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
