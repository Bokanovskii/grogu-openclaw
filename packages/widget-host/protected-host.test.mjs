import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createWidgetHost } from "./src/protected-host.ts";

// oxlint-disable unicorn/require-post-message-target-origin -- MessagePort does not accept a target origin.
test("ready fires once for the matching resource on the private sandbox channel", async (t) => {
  const dom = new JSDOM("<iframe></iframe>", { url: "https://example.test/" });
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const frame = dom.window.document.querySelector("iframe");
  let sandboxPort;
  let readyCount = 0;
  const ready = Promise.withResolvers();
  const host = createWidgetHost(frame, {
    html: "<p>Example</p>",
    theme: "light",
    onPrompt: () => assert.fail("Unexpected prompt"),
    onError: (error) => assert.fail(error.message),
    onReady: () => {
      readyCount++;
      ready.resolve();
    },
  });
  frame.contentWindow.postMessage = (_message, _origin, ports) => {
    [sandboxPort] = ports;
  };
  t.after(() => {
    host.dispose();
    sandboxPort?.close();
    globalThis.window = previousWindow;
    dom.window.close();
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        method: "ui/notifications/sandbox-proxy-ready",
        params: { sandboxUrl: "https://example.test/api/protected/v1/widget-sandbox" },
      },
    }),
  );
  assert.ok(sandboxPort);
  const resource = Promise.withResolvers();
  sandboxPort.addEventListener("message", (event) => {
    if (event.data.method === "ui/notifications/sandbox-resource-ready") {
      resource.resolve(event.data.params);
    }
  });
  sandboxPort.start();
  sandboxPort.postMessage({ method: "ui/notifications/sandbox-proxy-ready" });
  const { renderId } = await resource.promise;
  sandboxPort.postMessage({
    method: "ui/notifications/sandbox-resource-loaded",
    params: { renderId: "wrong" },
  });
  await new Promise(setImmediate);
  assert.equal(readyCount, 0);
  sandboxPort.postMessage({
    method: "ui/notifications/sandbox-resource-loaded",
    params: { renderId },
  });
  sandboxPort.postMessage({
    method: "ui/notifications/sandbox-resource-loaded",
    params: { renderId },
  });
  await ready.promise;
  await new Promise(setImmediate);
  assert.equal(readyCount, 1);
});
