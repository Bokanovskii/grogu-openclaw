import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { buildProtectedWidgetMeasurementDocument } from "./widget-measurement.js";

for (const browserType of [chromium, webkit]) {
  void test(
    `${browserType.name()}: measurement preserves its response CSP after document.write`,
    { timeout: 30_000 },
    async (t) => {
      const requests: string[] = [];
      const measurementDocument = buildProtectedWidgetMeasurementDocument();
      const server = createServer((request, response) => {
        if (request.url === "/widget-measurement") {
          response.writeHead(200, measurementDocument.headers);
          response.end(measurementDocument.html);
          return;
        }
        if (request.url !== "/") {
          requests.push(request.url ?? "");
        }
        response.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'",
        });
        response.end(
          '<iframe sandbox="allow-same-origin" src="/widget-measurement" inert></iframe>',
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      t.after(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(
                  new Error("Could not close the measurement proof server.", { cause: error }),
                );
              } else {
                resolve();
              }
            });
          }),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const browser = await browserType.launch({ headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${address.port}`;
      await page
        .context()
        .addCookies([{ name: "synthetic-session", value: "fixture-only", url: origin }]);
      await page.goto(origin);
      const frame = page.locator("iframe").contentFrame();
      await frame.locator("style[data-widget-base]").waitFor({ state: "attached" });
      const measured = await page.evaluate(() => {
        const measurementFrame = document.querySelector("iframe");
        const doc = measurementFrame?.contentDocument;
        if (!doc) {
          throw new Error("Measurement document is not readable.");
        }
        const base = doc.querySelector("style[data-widget-base]")?.textContent;
        doc.open();
        // Hostile markup exercises the response policy independently of the
        // client sanitizer. Production callers must also remove navigation.
        doc.write(`<!doctype html><style data-widget-base>${base}</style>
          <style>body{margin:0}.alcove{box-sizing:border-box;height:342.25px}</style>
          <main class="alcove"><h2>Measured draft</h2></main>
          <meta http-equiv="refresh" content="0;url=/blocked-refresh">
          <script>parent.document.body.dataset.stolen=document.cookie;fetch("/blocked-script")</script>
          <img src="/blocked-image" onerror="parent.document.body.dataset.stolen=document.cookie">
          <iframe src="/blocked-frame"></iframe>
          <style>@import url("/blocked-css");body{background-image:url("/blocked-background")}</style>
          <form action="/blocked-form"><button>Submit</button></form>`);
        doc.close();
        return { height: doc.querySelector("main")?.getBoundingClientRect().height };
      });
      await frame.getByRole("heading", { name: "Measured draft" }).waitFor();
      assert.equal(measured.height, 342.25);
      assert.equal(await page.locator("body").getAttribute("data-stolen"), null);
      await frame.getByRole("button", { name: "Submit" }).click({ force: true });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      assert.deepEqual(requests, []);
      assert.equal(await page.locator("body").getAttribute("data-stolen"), null);
      assert.equal(await frame.getByRole("heading", { name: "Measured draft" }).count(), 1);
      assert.equal(
        await frame.locator(".alcove").evaluate((element) => getComputedStyle(element).fontSize),
        "15px",
      );
    },
  );
}
