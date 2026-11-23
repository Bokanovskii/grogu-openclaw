import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { ProtectedError } from "../errors.js";
import { browserHandoffResponse } from "./handoff-http.js";
import {
  browserHandoffViewport,
  runBrowserHandoff,
  type BrowserHandoffControl,
  type BrowserHandoffEvent,
} from "./handoff.js";

// Secretless, loopback-only client fixture. It does not simulate production identity admission.
const profileId = "synthetic-member";
const chatId = "synthetic-chat";
const runId = "synthetic-run";
const origin = "https://seats.synthetic.example";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: browserHandoffViewport });
await context.route("**/*", (route) =>
  route.fulfill({
    status: route.request().url() === `${origin}/` ? 200 : 404,
    contentType: "text/html",
    body:
      route.request().url() === `${origin}/`
        ? `<!doctype html><title>Choose a synthetic seat</title>
          <style>body{font:24px sans-serif;padding:32px}button{font:inherit;padding:24px;margin:8px}</style>
          <h1>Choose a seat</h1><p>No booking or payment is made.</p>
          <button style="position:absolute;left:32px;top:200px;width:200px;height:80px"
            onclick="document.title='Seat A1 selected';this.textContent='A1 selected'">A1</button>
          <button style="position:absolute;left:260px;top:200px;width:200px;height:80px"
            onclick="document.title='Seat A2 selected';this.textContent='A2 selected'">A2</button>`
        : "<!doctype html><p>Unsupported fixture page</p>",
  }),
);
const page = await context.newPage();
await page.goto(`${origin}/`);
let control: BrowserHandoffControl | undefined;
let latest: BrowserHandoffEvent | undefined;
let ended = false;
let resumed = false;
const abort = new AbortController();
const streams = new Set<import("node:http").ServerResponse>();
let ready!: () => void;
const registered = new Promise<void>((resolve) => {
  ready = resolve;
});
const result = runBrowserHandoff({
  page,
  signal: abort.signal,
  host: {
    publish(event) {
      latest = event;
      for (const stream of streams) {
        stream.write(`${JSON.stringify({ type: "browser-handoff", handoff: event })}\n`);
      }
    },
    register(next) {
      control = next;
      ready();
      return () => {
        control = undefined;
      };
    },
    end() {
      ended = true;
    },
  },
}).then((outcome) => {
  resumed = outcome === "returned";
});
await registered;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/fixture" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(
        JSON.stringify({
          profileId,
          chatId,
          runId,
          handoff: latest,
          ended,
          resumed,
          title: await page.title(),
        }),
      );
      return;
    }
    if (req.headers["x-grogu-profile"] !== profileId) {
      throw new ProtectedError(403, "profile_mismatch", "Use the synthetic fixture profile.");
    }
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.write(`${JSON.stringify({ type: "start", runId })}\n`);
      if (latest) {
        res.write(`${JSON.stringify({ type: "browser-handoff", handoff: latest })}\n`);
      }
      streams.add(res);
      res.on("close", () => {
        streams.delete(res);
        if (control) {
          abort.abort();
        }
      });
      return;
    }
    const match =
      /^\/api\/protected\/v1\/chats\/synthetic-chat\/runs\/synthetic-run\/browser-handoffs\/([A-Za-z0-9_-]{22})\/(claim|frame|input|return|cancel)$/u.exec(
        url.pathname,
      );
    const admitted = control;
    if (!admitted || !match || !match[2] || match[1] !== admitted.id) {
      throw new ProtectedError(404, "not_found", "Fixture handoff not found.");
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    const request = new Request(url, { method: req.method, headers });
    const response = await browserHandoffResponse({
      request,
      action: match[2],
      control: admitted,
      readBody: async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) {
            throw new ProtectedError(413, "too_large", "Fixture input is too large.");
          }
          chunks.push(chunk);
        }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new ProtectedError(400, "invalid_request", "Invalid fixture input.");
        }
        return Object.fromEntries(Object.entries(data));
      },
      revalidate: async () => {
        if (control !== admitted || abort.signal.aborted) {
          throw new ProtectedError(409, "handoff_conflict", "Fixture handoff ended.");
        }
      },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error instanceof ProtectedError ? error.status : 500;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        error: {
          code: error instanceof ProtectedError ? error.code : "fixture_failed",
          message: error instanceof ProtectedError ? error.message : "Synthetic fixture failed.",
        },
      }),
    );
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    console.log(JSON.stringify({ fixture: `http://127.0.0.1:${address.port}/fixture` }));
  }
});
const stop = async () => {
  abort.abort();
  for (const stream of streams) {
    stream.end();
  }
  server.close();
  server.closeAllConnections();
  await result;
  await browser.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
