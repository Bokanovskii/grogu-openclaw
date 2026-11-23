import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
  type LookupFn,
  type SsrFPolicy,
} from "../../../src/infra/net/ssrf.js";
import type { AlcoveBrowserBindings, AlcoveBrowserResult } from "../alcove-browser/contract.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";

const maxSessions = 4;
const snapshotMaxChars = 20_000;
const navigationTimeoutMs = 20_000;
const snapshotTimeoutMs = 10_000;
const idleBrowserCloseMs = 60_000;
const redactedRoles = "textbox|searchbox|combobox|spinbutton";
const fieldLine = new RegExp(
  `^(\\s*)(- (?:${redactedRoles})(?: "(?:[^"\\\\]|\\\\.)*")?(?: \\[[^\\]]*\\])*)(:.*)?$`,
);

/**
 * Removes typed form values (including passwords and one-time codes) from an AI
 * snapshot. Page fields are never modified; only the text returned to the model is.
 */
export function redactSnapshot(snapshot: string): string {
  const output: string[] = [];
  let blockIndent: number | undefined;
  for (const line of snapshot.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (line.trim() === "" || indent > blockIndent) {
        continue;
      }
      blockIndent = undefined;
    }
    const match = fieldLine.exec(line);
    const value = match?.[3];
    if (!match || value === undefined || value === ":") {
      output.push(line);
      continue;
    }
    output.push(`${match[1]}${match[2]}: [redacted]`);
    if (/^:\s*[|>][-+0-9]*\s*$/.test(value)) {
      blockIndent = indent;
    }
  }
  return output.join("\n");
}

function parseNavigationUrl(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Use an absolute http or https URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http and https pages can be opened.";
  }
  if (url.username || url.password) {
    return "URLs with embedded credentials are not allowed.";
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) {
    return "Only standard web ports are allowed.";
  }
  return url;
}

export type ProtectedBrowserSession = {
  bindings: AlcoveBrowserBindings;
  close: () => Promise<void>;
};

export type ProtectedBrowserBroker = {
  openSession: (input: { signal: AbortSignal }) => ProtectedBrowserSession;
  shutdown: () => Promise<void>;
};

type Runtime = { browser: Browser; proxy: EgressProxy };

export function createProtectedBrowserBroker(
  options: {
    policy?: SsrFPolicy;
    lookupFn?: LookupFn;
    executablePath?: string;
  } = {},
): ProtectedBrowserBroker {
  let runtime: Promise<Runtime> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let slots = 0;

  const stopRuntime = async () => {
    const current = runtime;
    runtime = undefined;
    const resolved = await current?.catch(() => undefined);
    await resolved?.browser.close().catch(() => undefined);
    await resolved?.proxy.close().catch(() => undefined);
  };
  const scheduleIdleClose = () => {
    clearTimeout(idleTimer);
    if (slots === 0 && runtime) {
      idleTimer = setTimeout(() => void stopRuntime(), idleBrowserCloseMs);
      idleTimer.unref();
    }
  };
  const ensureRuntime = () => {
    clearTimeout(idleTimer);
    runtime ??= (async () => {
      const proxy = await startEgressProxy({
        policy: options.policy,
        lookupFn: options.lookupFn,
      });
      try {
        const env: Record<string, string> = {};
        for (const name of ["HOME", "PATH", "TMPDIR"] as const) {
          const value = process.env[name];
          if (value) {
            env[name] = value;
          }
        }
        const browser = await chromium.launch({
          headless: true,
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          env,
          proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
          args: [
            // Chromium bypasses proxies for loopback unless this removes the implicit rule.
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--disable-breakpad",
            "--disable-crash-reporter",
            "--disable-features=DnsOverHttps",
          ],
        });
        const started = { browser, proxy };
        browser.once("disconnected", () => {
          void proxy.close().catch(() => undefined);
          void runtime?.then((current) => {
            if (current === started) {
              runtime = undefined;
            }
          });
        });
        return started;
      } catch (error) {
        await proxy.close().catch(() => undefined);
        throw error;
      }
    })();
    const current = runtime;
    current.catch(() => {
      if (runtime === current) {
        runtime = undefined;
      }
    });
    return current;
  };

  return {
    openSession({ signal }) {
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let opening: Promise<Page> | undefined;
      let sessionClosed = false;
      let queue: Promise<unknown> = Promise.resolve();

      let holdsSlot = false;
      const close = async () => {
        sessionClosed = true;
        await opening?.catch(() => undefined);
        const current = context;
        context = undefined;
        page = undefined;
        if (holdsSlot) {
          holdsSlot = false;
          slots -= 1;
        }
        await current?.close().catch(() => undefined);
        scheduleIdleClose();
      };
      const currentPage = async (): Promise<Page> => {
        if (page && !page.isClosed()) {
          return page;
        }
        opening ??= (async () => {
          if (closed || sessionClosed) {
            throw new Error("closed");
          }
          if (!holdsSlot) {
            if (slots >= maxSessions) {
              throw new Error("busy");
            }
            slots += 1;
            holdsSlot = true;
          }
          // A closed tab (page script or browser crash) gets a fresh context, never a reused one.
          const stale = context;
          context = undefined;
          page = undefined;
          await stale?.close().catch(() => undefined);
          const { browser } = await ensureRuntime();
          context = await browser.newContext({
            acceptDownloads: false,
            serviceWorkers: "block",
            permissions: [],
            viewport: { width: 1280, height: 800 },
          });
          const created = context;
          if (closed || sessionClosed) {
            throw new Error("closed");
          }
          created.setDefaultNavigationTimeout(navigationTimeoutMs);
          created.setDefaultTimeout(snapshotTimeoutMs);
          const opened = await created.newPage();
          // One tab per session; popups and new windows are closed immediately.
          created.on("page", (extra) => {
            if (extra !== opened) {
              void extra.close().catch(() => undefined);
            }
          });
          opened.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
          page = opened;
          return opened;
        })();
        try {
          return await opening;
        } finally {
          opening = undefined;
        }
      };
      const describe = async (target: Page): Promise<AlcoveBrowserResult> => {
        const raw = await target.ariaSnapshot({ mode: "ai", timeout: snapshotTimeoutMs });
        const redacted = redactSnapshot(raw);
        return {
          status: "ok",
          url: target.url(),
          title: (await target.title()).slice(0, 300),
          snapshot: redacted.slice(0, snapshotMaxChars),
          truncated: redacted.length > snapshotMaxChars,
        };
      };
      const serial = (run: () => Promise<AlcoveBrowserResult>): Promise<AlcoveBrowserResult> => {
        const next = queue.then(async (): Promise<AlcoveBrowserResult> => {
          if (signal.aborted || sessionClosed || closed) {
            return { status: "unavailable", reason: "This turn has ended." };
          }
          try {
            return await run();
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "busy") {
              return { status: "unavailable", reason: "Too many browsers are open. Try later." };
            }
            if (message === "closed") {
              return { status: "unavailable", reason: "This turn has ended." };
            }
            if (
              /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_HTTP_RESPONSE_CODE_FAILURE/.test(message)
            ) {
              return { status: "blocked", reason: "That address is not reachable from Alcove." };
            }
            return { status: "failed", reason: "The page could not be loaded." };
          }
        });
        queue = next;
        return next;
      };
      const navigate = async (raw: string): Promise<AlcoveBrowserResult> => {
        const url = parseNavigationUrl(raw);
        if (typeof url === "string") {
          return { status: "invalid", reason: url };
        }
        try {
          // Early, readable refusal; the egress proxy enforces the same policy per connection.
          await resolvePinnedHostnameWithPolicy(url.hostname.replace(/^\[|\]$/g, ""), {
            policy: options.policy,
            lookupFn: options.lookupFn,
            signal,
          });
        } catch (error) {
          return error instanceof SsrFBlockedError
            ? { status: "blocked", reason: "Private and local network addresses are not allowed." }
            : { status: "failed", reason: "The address could not be resolved." };
        }
        const target = await currentPage();
        await target.goto(url.href, { waitUntil: "domcontentloaded" });
        return describe(target);
      };

      return {
        close,
        bindings: {
          browser: "fresh",
          open: ({ url }) => serial(() => navigate(url)),
          snapshot: () =>
            serial(async () =>
              page && !page.isClosed()
                ? describe(page)
                : { status: "invalid", reason: "Open a page first." },
            ),
          followLink: ({ ref }) =>
            serial(async () => {
              if (!page || page.isClosed()) {
                return { status: "invalid", reason: "Open a page first." };
              }
              const link = page.locator(`aria-ref=${ref}`);
              const href = await link.getAttribute("href", { timeout: snapshotTimeoutMs });
              if (!href) {
                return { status: "invalid", reason: "That ref is not a link." };
              }
              return navigate(new URL(href, page.url()).href);
            }),
          back: () =>
            serial(async () => {
              if (!page || page.isClosed()) {
                return { status: "invalid", reason: "Open a page first." };
              }
              const previous = await page.goBack({ waitUntil: "domcontentloaded" });
              return previous ? describe(page) : { status: "invalid", reason: "No earlier page." };
            }),
        },
      };
    },
    async shutdown() {
      closed = true;
      clearTimeout(idleTimer);
      await stopRuntime();
    },
  };
}
