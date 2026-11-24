import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { parseRuntimeSettings } from "../settings.js";
import {
  browserHandoffViewport,
  displayHttpsOrigin,
  isBrowserHandoffInput,
  runBrowserHandoff,
  type BrowserHandoffControl,
  type BrowserHandoffEvent,
} from "./handoff.js";

void test("deployment rejects handoff even when a fresh browser is configured", () => {
  const settings = {
    origin: "https://chat.bokanovski.com",
    accessIssuer: "https://synthetic.cloudflareaccess.com",
    accessAudience: "a".repeat(64),
    port: 19789,
    stateDir: "/synthetic/state",
    allowedSubjects: [],
    browser: "fresh",
    sparkySecret: { source: "env", provider: "default", id: "SPARKY_API_KEY" },
    storageLimits: { userBytes: 100, globalBytes: 200, freeFloorBytes: 1 },
  };
  assert.equal(parseRuntimeSettings(settings).browser, "fresh");
  assert.throws(
    () => parseRuntimeSettings({ ...settings, browserHandoff: true }),
    /Browser handoff is not available for deployment/u,
  );
});

void test("handoff input admits only bounded taps, scrolls, Enter and Tab", () => {
  assert.equal(isBrowserHandoffInput({ kind: "tap", x: 0, y: 799 }), true);
  assert.equal(isBrowserHandoffInput({ kind: "scroll", dy: -2000 }), true);
  assert.equal(isBrowserHandoffInput({ kind: "key", key: "Tab" }), true);
  for (const rejected of [
    { kind: "tap", x: browserHandoffViewport.width, y: 1 },
    { kind: "tap", x: 1.5, y: 1 },
    { kind: "scroll", dy: 2001 },
    { kind: "key", key: "a" },
    { kind: "key", key: "Enter", text: "synthetic" },
    { kind: "text", text: "synthetic" },
    { kind: "type", text: "synthetic" },
  ]) {
    assert.equal(isBrowserHandoffInput(rejected), false, JSON.stringify(rejected));
  }
});

void test("display origin shows look-alike Unicode hosts with their ASCII form", () => {
  assert.equal(displayHttpsOrigin("https://example.test"), "https://example.test");
  assert.equal(
    displayHttpsOrigin("https://xn--exmple-cua.test"),
    "https://exämple.test (xn--exmple-cua.test)",
  );
});

const pages: Record<string, string> = {
  "https://synthetic.example/": `<!doctype html><body style="margin:0">
    <button id="choose" style="position:absolute;left:0;top:0;width:200px;height:60px"
      onclick="document.title='chosen'">Choose</button>
    <input id="name" style="position:absolute;left:0;top:100px;width:200px;height:40px">
    <input id="secret" type="password" style="position:absolute;left:0;top:160px;width:200px;height:40px">
    <iframe src="https://other.example/frame" style="position:absolute;left:0;top:220px;width:300px;height:200px;border:0"></iframe>
    <a id="away" href="https://other.example/" style="position:absolute;left:0;top:440px">Away</a>
  </body>`,
  "https://synthetic.example/next": "<!doctype html><title>next</title><p>Next</p>",
  "https://other.example/": "<!doctype html><title>other</title><p>Other</p>",
  "https://other.example/frame": "<!doctype html><button>Embedded</button>",
};

const executable = chromium.executablePath();
let browser: Browser | undefined;
after(() => browser?.close());

async function start(
  limits?: { idleMs: number; capMs: number },
  beforeHandoff?: () => void,
  onEvent?: (event: BrowserHandoffEvent) => void,
) {
  browser ??= await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: browserHandoffViewport });
  await context.route("https://**/*", (route) => {
    const body = pages[route.request().url()];
    return body === undefined
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ status: 200, contentType: "text/html", body });
  });
  const page = await context.newPage();
  await page.goto("https://synthetic.example/");
  const events: BrowserHandoffEvent[] = [];
  let ended = 0;
  const abort = new AbortController();
  let ready!: (control: BrowserHandoffControl) => void;
  const registered = new Promise<BrowserHandoffControl>((resolve) => {
    ready = resolve;
  });
  beforeHandoff?.();
  const result = runBrowserHandoff({
    page,
    signal: abort.signal,
    ...(limits ? { limits } : {}),
    host: {
      publish: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      register: (next) => {
        ready(next);
        return () => {};
      },
      end: () => {
        ended += 1;
      },
    },
  });
  const admitted = await registered;
  return {
    page: page satisfies Page,
    events,
    control: admitted,
    result,
    abort,
    ended: () => ended,
    close: () => context.close(),
  };
}

const origin = "https://synthetic.example";
const skip = existsSync(executable) ? false : "Chromium is not installed";

void test("member taps an ordinary control and explicitly returns", { skip }, async () => {
  const run = await start();
  try {
    assert.equal(run.events[0]?.state, "waiting");
    assert.equal(run.events[0]?.origin, origin);
    assert.equal(await run.control.claim("https://other.example"), "conflict");
    const claim = await run.control.claim(origin);
    assert.notEqual(claim, "conflict");
    if (claim === "conflict") {
      return;
    }
    const frame = await run.control.frame(claim.controller);
    assert.notEqual(frame, "conflict");
    if (frame !== "conflict") {
      assert.equal(frame.origin, origin);
      assert.equal(frame.field, "none");
      assert.equal(frame.image.subarray(0, 2).toString("hex"), "ffd8");
    }
    assert.equal(
      await run.control.input(claim.controller, origin, { kind: "tap", x: 10, y: 10 }),
      "ok",
    );
    assert.equal(await run.page.title(), "chosen");
    assert.equal(
      await run.control.input(claim.controller, origin, { kind: "key", key: "Tab" }),
      "ok",
    );
    assert.equal(await run.control.finish("stale", origin), "conflict");
    assert.equal(await run.control.finish(claim.controller, origin), "ok");
    assert.equal(await run.result, "returned");
    assert.equal(run.ended(), 0);
    assert.equal(run.events.at(-1)?.state, "returned");
  } finally {
    await run.close();
  }
});

void test("text, secret and embedded fields are never driven", { skip }, async () => {
  const run = await start();
  try {
    const claim = await run.control.claim(origin);
    assert.notEqual(claim, "conflict");
    if (claim === "conflict") {
      return;
    }
    const tap = (y: number) =>
      run.control.input(claim.controller, origin, { kind: "tap", x: 10, y });
    assert.equal(await tap(110), "declined");
    assert.equal(await tap(170), "declined");
    assert.equal(await tap(250), "declined");
    await run.page.focus("#secret");
    const frame = await run.control.frame(claim.controller);
    assert.equal(frame !== "conflict" && frame.field, "secret");
    assert.equal(
      await run.control.input(claim.controller, origin, { kind: "key", key: "Enter" }),
      "declined",
    );
    await run.page.focus("#name");
    const textFrame = await run.control.frame(claim.controller);
    assert.equal(textFrame !== "conflict" && textFrame.field, "unsupported");
    assert.equal(await run.control.cancel("stale", origin), "conflict");
    assert.equal(await run.control.cancel(claim.controller, "https://other.example"), "conflict");
    assert.equal(await run.control.cancel(claim.controller, origin), "ok");
    assert.equal(await run.result, "ended");
    assert.equal(run.ended(), 1);
    assert.equal(run.events.at(-1)?.state, "cancelled");
  } finally {
    await run.close();
  }
});

void test(
  "navigation drops the controller and a new claim replaces stale ones",
  { skip },
  async () => {
    const run = await start();
    try {
      const first = await run.control.claim(origin);
      const second = await run.control.claim(origin);
      assert.ok(first !== "conflict" && second !== "conflict");
      assert.equal(await run.control.frame(first.controller), "conflict");
      await run.page.goto("https://other.example/");
      assert.equal(run.events.at(-1)?.state, "origin-changed");
      assert.equal(run.events.at(-1)?.origin, "https://other.example");
      assert.equal(await run.control.frame(second.controller), "conflict");
      assert.equal(await run.control.finish(second.controller, origin), "conflict");
      assert.equal(await run.control.claim(origin), "conflict");
      assert.notEqual(await run.control.claim("https://other.example"), "conflict");
      run.abort.abort();
      assert.equal(await run.result, "ended");
      assert.equal(run.events.at(-1)?.state, "revoked");
      assert.equal(run.ended(), 1);
    } finally {
      await run.close();
    }
  },
);

void test("an idle handoff expires and ends the turn", { skip }, async (t) => {
  const run = await start({ idleMs: 50, capMs: 1_000 }, () =>
    t.mock.timers.enable({ apis: ["setTimeout"] }),
  );
  try {
    t.mock.timers.tick(50);
    assert.equal(await run.result, "ended");
    assert.equal(run.events.at(-1)?.state, "expired");
    assert.equal(run.ended(), 1);
  } finally {
    t.mock.timers.reset();
    await run.close();
  }
});

void test("event delivery failure rejects the handoff and ends the run", { skip }, async () => {
  const run = await start(undefined, undefined, (event) => {
    if (event.state === "origin-changed") {
      throw new Error("Synthetic event delivery failed");
    }
  });
  try {
    const failed = assert.rejects(run.result, /Synthetic event delivery failed/u);
    await run.page.goto("https://other.example/");
    await failed;
    assert.equal(run.ended(), 1);
    assert.equal(run.events.at(-1)?.state, "revoked");
  } finally {
    await run.close();
  }
});
