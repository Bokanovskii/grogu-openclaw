import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import type { LookupFn } from "../../../src/infra/net/ssrf.js";
import { createProtectedBrowserBroker, redactSnapshot } from "./broker.js";

void test("snapshot redaction removes typed field values but keeps structure", () => {
  const snapshot = [
    '- textbox "Password" [ref=e3]: hunter2',
    '- textbox "Say \\"hi\\"" [active] [ref=e4]: secret "quoted"',
    '- searchbox "Search" [ref=e5]: private query',
    '- combobox "Country" [ref=e6]: Iceland',
    '- spinbutton "Code" [ref=e7]: "123456"',
    '- textbox "Notes" [ref=e8]: |-',
    "    line one",
    "    line two",
    '- link "Home" [ref=e9]:',
    "  - /url: /home",
    '- textbox "Empty" [ref=e10]',
    '- heading "Welcome" [level=1] [ref=e11]',
  ].join("\n");
  const redacted = redactSnapshot(snapshot);
  for (const leaked of ["hunter2", "secret", "private query", "Iceland", "123456", "line one"]) {
    assert.doesNotMatch(redacted, new RegExp(leaked, "u"));
  }
  assert.match(redacted, /- textbox "Password" \[ref=e3\]: \[redacted\]/u);
  assert.match(redacted, /- textbox "Notes" \[ref=e8\]: \[redacted\]\n- link "Home"/u);
  assert.match(redacted, /\/url: \/home/u);
  assert.match(redacted, /- textbox "Empty" \[ref=e10\]\n/u);
  assert.match(redacted, /heading "Welcome"/u);
});

const executable = chromium.executablePath();
void test(
  "real Chromium snapshots never return typed passwords or codes",
  { skip: existsSync(executable) ? false : "Chromium is not installed" },
  async () => {
    const browser = await chromium.launch({ headless: true });
    after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <label>Email <input type="email" value="member@example.test"></label>
      <label>Password <input type="password" value="synthetic-password"></label>
      <label>Code <input inputmode="numeric" value="246810"></label>
      <label>Notes <textarea>first private line
second private line</textarea></label>
      <a href="https://example.test/next">Next</a>`);
    const redacted = redactSnapshot(await page.ariaSnapshot({ mode: "ai" }));
    for (const leaked of ["member@example", "synthetic-password", "246810", "private line"]) {
      assert.doesNotMatch(redacted, new RegExp(leaked, "u"));
    }
    assert.match(redacted, /link "Next"/u);
  },
);

void test("broker refuses unsafe navigation before any browser starts", async () => {
  const broker = createProtectedBrowserBroker({
    lookupFn: (async () => [{ address: "10.1.2.3", family: 4 }]) as unknown as LookupFn,
    executablePath: "/nonexistent/alcove-chromium",
  });
  after(() => broker.shutdown());
  const controller = new AbortController();
  const session = broker.openSession({ signal: controller.signal });
  const cases: Array<[string, string]> = [
    ["file:///etc/passwd", "invalid"],
    ["javascript:alert(1)", "invalid"],
    ["https://user:pass@example.test/", "invalid"],
    ["https://example.test:8443/", "invalid"],
    ["http://127.0.0.1/", "blocked"],
    ["http://169.254.169.254/", "blocked"],
    ["https://rebinding.test/", "blocked"],
  ];
  for (const [url, status] of cases) {
    assert.equal((await session.bindings.open({ url })).status, status, url);
  }
  assert.equal((await session.bindings.snapshot()).status, "invalid");
  controller.abort();
  assert.equal(
    (await session.bindings.open({ url: "https://example.test/" })).status,
    "unavailable",
  );
  await session.close();
});

async function listenOnWebPort(handler: http.RequestListener) {
  const server = http.createServer(handler);
  // macOS lets unprivileged users bind low ports only on the wildcard address,
  // so drop every non-loopback peer before it can read the synthetic page.
  server.on("connection", (socket) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress ?? "")) {
      socket.destroy();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(80, () => resolve());
    });
    return server;
  } catch {
    return undefined;
  }
}

void test(
  "broker browses a synthetic site through the pinned egress proxy",
  { skip: existsSync(executable) ? false : "Chromium is not installed" },
  async (t) => {
    const site = await listenOnWebPort((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/next"
          ? "<title>Next</title><h1>Second page</h1>"
          : `<title>Start</title><h1>Synthetic start</h1>
             <input type="password" value="synthetic-password" aria-label="Password">
             <a href="/next">Continue</a>
             <a href="http://10.9.9.9/">Private</a>`,
      );
    });
    if (!site) {
      t.skip("port 80 is unavailable for the synthetic site");
      return;
    }
    after(
      () =>
        new Promise<void>((resolve) => {
          site.close(() => resolve());
        }),
    );
    const broker = createProtectedBrowserBroker({
      policy: { allowPrivateNetwork: true, allowedHostnames: ["fixture.test"] },
      lookupFn: (async (hostname: string) => [
        { address: hostname === "fixture.test" ? "127.0.0.1" : "10.9.9.9", family: 4 },
      ]) as unknown as LookupFn,
    });
    after(() => broker.shutdown());
    const session = broker.openSession({ signal: new AbortController().signal });
    const start = await session.bindings.open({ url: "http://fixture.test/" });
    assert.equal(start.status, "ok", JSON.stringify(start));
    assert.ok(start.status === "ok");
    assert.equal(start.title, "Start");
    assert.doesNotMatch(start.snapshot, /synthetic-password/u);
    const ref = /link "Continue" \[ref=(e\d+)\]/u.exec(start.snapshot)?.[1];
    assert.ok(ref, start.snapshot);
    const next = await session.bindings.followLink({ ref });
    assert.ok(next.status === "ok", JSON.stringify(next));
    assert.equal(next.url, "http://fixture.test/next");
    const back = await session.bindings.back();
    assert.ok(back.status === "ok" && back.title === "Start", JSON.stringify(back));
    await session.close();
    assert.equal((await session.bindings.snapshot()).status, "unavailable");
  },
);
