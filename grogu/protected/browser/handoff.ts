import { randomBytes, timingSafeEqual } from "node:crypto";
import { domainToUnicode } from "node:url";
import type { CDPSession, Page } from "playwright-core";

export const browserHandoffViewport = { width: 1280, height: 800 } as const;
const defaultLimits = { idleMs: 5 * 60_000, capMs: 10 * 60_000 };

export type BrowserHandoffState =
  | "waiting"
  | "active"
  | "origin-changed"
  | "returned"
  | "cancelled"
  | "expired"
  | "revoked";
export type BrowserHandoffEvent = {
  id: string;
  state: BrowserHandoffState;
  mode: "fresh";
  /** Committed https origin of the top-level page, or null when it cannot be controlled. */
  origin: string | null;
  displayOrigin: string | null;
  expiresAt: number;
};
export type BrowserHandoffInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "scroll"; dy: number }
  | { kind: "key"; key: "Enter" | "Tab" };
export type BrowserHandoffField = "none" | "secret" | "unsupported";
export type BrowserHandoffClaim = {
  controller: string;
  origin: string;
  displayOrigin: string;
  viewport: typeof browserHandoffViewport;
  expiresAt: number;
};
export type BrowserHandoffFrame = {
  image: Buffer;
  origin: string;
  sequence: number;
  field: BrowserHandoffField;
};

/** Member-facing operations for one live handoff. Every method rechecks controller and origin. */
export type BrowserHandoffControl = {
  id: string;
  claim: (origin: string) => Promise<BrowserHandoffClaim | "conflict">;
  frame: (controller: string) => Promise<BrowserHandoffFrame | "conflict">;
  input: (
    controller: string,
    origin: string,
    input: BrowserHandoffInput,
  ) => Promise<"ok" | "conflict" | "declined">;
  finish: (controller: string, origin: string) => Promise<"ok" | "conflict">;
  cancel: (controller: string, origin: string) => Promise<"ok" | "conflict">;
};

/** Run-owned callbacks: publish to the turn stream, expose the control, and end the turn. */
export type BrowserHandoffHost = {
  publish: (event: BrowserHandoffEvent) => void;
  register: (control: BrowserHandoffControl) => () => void;
  end: () => void;
};

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function isBrowserHandoffInput(value: unknown): value is BrowserHandoffInput {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const keys = Object.keys(value).toSorted().join(",");
  if (value.kind === "tap") {
    return (
      keys === "kind,x,y" &&
      "x" in value &&
      "y" in value &&
      within(value.x, 0, browserHandoffViewport.width - 1) &&
      within(value.y, 0, browserHandoffViewport.height - 1)
    );
  }
  if (value.kind === "scroll") {
    return keys === "dy,kind" && "dy" in value && within(value.dy, -2000, 2000);
  }
  return (
    value.kind === "key" &&
    keys === "key,kind" &&
    "key" in value &&
    (value.key === "Enter" || value.key === "Tab")
  );
}

const terminal = new Set<BrowserHandoffState>(["returned", "cancelled", "expired", "revoked"]);

export function committedHttpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Shows Unicode host names next to their ASCII form so look-alike domains stay visible. */
export function displayHttpsOrigin(origin: string): string {
  const url = new URL(origin);
  const unicode = domainToUnicode(url.hostname);
  const port = url.port ? `:${url.port}` : "";
  return unicode && unicode !== url.hostname
    ? `https://${unicode}${port} (${url.hostname})`
    : `https://${url.hostname}${port}`;
}

// Runs in a fresh isolated world so page scripts cannot replace the DOM APIs used here.
const fieldKindSource = `function kind(e) {
  if (!e) return "none";
  const tag = e.tagName;
  if (tag === "IFRAME" || tag === "FRAME" || tag === "OBJECT" || tag === "EMBED") return "frame";
  if (tag === "INPUT") {
    const type = (e.getAttribute("type") || "text").toLowerCase();
    const ac = (e.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password" || /(^|\\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\\s|$)/.test(ac)) return "secret";
    if (["button", "submit", "reset", "checkbox", "radio", "image"].includes(type)) return "none";
    return "text";
  }
  if (tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable) return "text";
  return "none";
}`;
const activeFieldExpression = `(() => { ${fieldKindSource}
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  return e === document.body || e === document.documentElement ? "none" : kind(e);
})()`;
const tapTargetExpression = (x: number, y: number) => `(() => { ${fieldKindSource}
  let e = document.elementFromPoint(${x}, ${y});
  while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(${x}, ${y}); if (!inner || inner === e) break; e = inner; }
  return e ? kind(e) : "frame";
})()`;

async function inspect(cdp: CDPSession, expression: string): Promise<string | undefined> {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "alcove-handoff",
  });
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    contextId: executionContextId,
    returnByValue: true,
  });
  return exceptionDetails || typeof result.value !== "string" ? undefined : result.value;
}

const sameToken = (expected: string | undefined, actual: string) =>
  expected !== undefined &&
  Buffer.byteLength(expected) === Buffer.byteLength(actual) &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

/**
 * Pauses the agent and lets the member drive the current https page with taps, scrolling,
 * Enter and Tab. Resolves "returned" only after an explicit Return on the claimed origin;
 * cancel, expiry and revocation resolve "ended" after asking the host to end the turn.
 */
export async function runBrowserHandoff(input: {
  page: Page;
  host: BrowserHandoffHost;
  signal: AbortSignal;
  limits?: { idleMs: number; capMs: number };
}): Promise<"returned" | "ended"> {
  const { page, host, signal } = input;
  const limits = input.limits ?? defaultLimits;
  const id = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + limits.capMs;
  let state: BrowserHandoffState = "waiting";
  let origin = committedHttpsOrigin(page.url());
  let controller: string | undefined;
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const cdp = await page.context().newCDPSession(page);

  let settle!: (result: "returned" | "ended") => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<"returned" | "ended">((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const publish = () => {
    try {
      host.publish({
        id,
        state,
        mode: "fresh",
        origin,
        displayOrigin: origin ? displayHttpsOrigin(origin) : null,
        expiresAt,
      });
    } catch (error) {
      fail(error);
      finishWith("revoked");
    }
  };
  let idleTimer: NodeJS.Timeout | undefined;
  const capTimer = setTimeout(() => finishWith("expired"), limits.capMs);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishWith("expired"), limits.idleMs);
  };
  const onNavigated = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame !== page.mainFrame() || terminal.has(state)) {
      return;
    }
    const next = committedHttpsOrigin(page.url());
    if (next !== origin || state === "active") {
      changeOrigin(next);
    }
  };
  const onAbort = () => finishWith("revoked");
  const onClosed = () => finishWith("revoked");
  let unregister = () => {};
  function changeOrigin(next: string | null) {
    controller = undefined;
    origin = next;
    if (state === "active" || state === "waiting" || state === "origin-changed") {
      state = "origin-changed";
      publish();
    }
  }
  function finishWith(next: BrowserHandoffState) {
    if (terminal.has(state)) {
      return;
    }
    state = next;
    controller = undefined;
    clearTimeout(idleTimer);
    clearTimeout(capTimer);
    page.off("framenavigated", onNavigated);
    page.off("close", onClosed);
    signal.removeEventListener("abort", onAbort);
    unregister();
    void cdp.detach().catch(() => undefined);
    publish();
    if (next !== "returned") {
      host.end();
    }
    settle(next === "returned" ? "returned" : "ended");
  }
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  // Controller and origin must both still match, and the page must still be on that origin.
  const current = (token: string, claimed: string) =>
    state === "active" &&
    sameToken(controller, token) &&
    origin === claimed &&
    committedHttpsOrigin(page.url()) === claimed;
  const verifyOrConflict = (token: string, claimed: string) => {
    if (current(token, claimed)) {
      return true;
    }
    if (state === "active" && sameToken(controller, token)) {
      const actual = committedHttpsOrigin(page.url());
      if (actual !== origin) {
        changeOrigin(actual);
      }
    }
    return false;
  };

  const control: BrowserHandoffControl = {
    id,
    claim: (claimed) =>
      serial(async () => {
        if (
          terminal.has(state) ||
          origin === null ||
          claimed !== origin ||
          committedHttpsOrigin(page.url()) !== claimed
        ) {
          return "conflict";
        }
        controller = randomBytes(32).toString("base64url");
        state = "active";
        touch();
        publish();
        return {
          controller,
          origin: claimed,
          displayOrigin: displayHttpsOrigin(claimed),
          viewport: browserHandoffViewport,
          expiresAt,
        };
      }),
    frame: (token) =>
      serial(async () => {
        const claimed = origin;
        if (claimed === null || !verifyOrConflict(token, claimed)) {
          return "conflict";
        }
        touch();
        const image = await page.screenshot({ type: "jpeg", quality: 60, animations: "disabled" });
        const field = await inspect(cdp, activeFieldExpression);
        // This is a stale-controller check, not atomic proof of compositor image provenance.
        if (!verifyOrConflict(token, claimed)) {
          return "conflict";
        }
        sequence += 1;
        return {
          image,
          origin: claimed,
          sequence,
          field: field === "none" ? "none" : field === "secret" ? "secret" : "unsupported",
        };
      }),
    input: (token, claimed, action) =>
      serial(async () => {
        if (!isBrowserHandoffInput(action)) {
          return "declined";
        }
        if (!verifyOrConflict(token, claimed)) {
          return "conflict";
        }
        touch();
        if (action.kind === "tap") {
          // Synthetic prototype only: DOM inspection and input dispatch are not atomic.
          if ((await inspect(cdp, tapTargetExpression(action.x, action.y))) !== "none") {
            return "declined";
          }
          if (!verifyOrConflict(token, claimed)) {
            return "conflict";
          }
          await page.mouse.click(action.x, action.y);
        } else if (action.kind === "key") {
          // Keys go to the focused element; focus inside an embedded frame or field is refused.
          if ((await inspect(cdp, activeFieldExpression)) !== "none") {
            return "declined";
          }
          if (!verifyOrConflict(token, claimed)) {
            return "conflict";
          }
          await page.keyboard.press(action.key);
        } else {
          await page.mouse.move(
            browserHandoffViewport.width / 2,
            browserHandoffViewport.height / 2,
          );
          await page.mouse.wheel(0, action.dy);
        }
        return "ok";
      }),
    finish: (token, claimed) =>
      serial(async () => {
        if (!current(token, claimed)) {
          return "conflict";
        }
        finishWith("returned");
        return "ok";
      }),
    cancel: (token, claimed) =>
      serial(async () => {
        if (!current(token, claimed)) {
          return "conflict";
        }
        finishWith("cancelled");
        return "ok";
      }),
  };

  if (signal.aborted) {
    void cdp.detach().catch(() => undefined);
    clearTimeout(capTimer);
    return "ended";
  }
  signal.addEventListener("abort", onAbort, { once: true });
  page.on("framenavigated", onNavigated);
  page.on("close", onClosed);
  unregister = host.register(control);
  touch();
  publish();
  return done;
}
