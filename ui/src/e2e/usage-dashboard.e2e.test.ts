import type { Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { Frame, Locator, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type UsageFixture = { now: Date; parameters: object; catalog: object[]; data: object };
type UsageSession = {
  label: string;
  url: string;
  linkKind?: string;
  rows: object[];
  dailyRows: object[] | null;
};
const require = createRequire(import.meta.url);
const { usageFixture } = require("../../../grogu/usage-dashboard/usage-test-fixture.mjs") as {
  usageFixture: () => UsageFixture;
};
const { summarizeUsage, summarizeDailyUsage, sessionUsageLinks } =
  require("../../../grogu/usage-dashboard/usage-data.mjs") as {
    summarizeUsage: (data: object, catalog: object[], parameters: object) => object;
    summarizeDailyUsage: (data: object, catalog: object[], parameters: object) => object;
    sessionUsageLinks: (
      data: object,
      catalog: object[],
      parameters: object,
      usageUrl: string,
      buildSessionPath: typeof buildControlUiSessionPath,
    ) => UsageSession[];
  };
const { usageHtml } = require("../../../grogu/usage-dashboard/usage-html.mjs") as {
  usageHtml: (summary: object, sessions: UsageSession[], now: Date) => string;
};

const suite = createControlUiE2eSuite({
  name: "Usage dashboard sandbox",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const sessionRow = {
  key: sessionKey,
  kind: "direct",
  boardFace: "dashboard",
  displayName: "Synthetic usage",
  updatedAt: 1,
};

function dashboardDocument(extraSessions = 0, legacyLinks = false): string {
  const { data, catalog, parameters, now } = usageFixture();
  const summary = {
    ...summarizeUsage(data, catalog, parameters),
    daily: summarizeDailyUsage(data, catalog, parameters),
    ...(extraSessions ? { sessionsCoverage: "partial" } : {}),
  };
  const sessions = sessionUsageLinks(
    data,
    catalog,
    parameters,
    "https://example.test/usage",
    buildControlUiSessionPath,
  );
  const first = sessions[0];
  if (!first) {
    throw new Error("Missing synthetic usage session");
  }
  if (legacyLinks) {
    for (const session of sessions) {
      delete session.linkKind;
    }
  }
  sessions.push(
    ...Array.from({ length: extraSessions }, (_, index) => ({
      ...first,
      label: `Synthetic session ${index + 1}`,
    })),
  );
  return buildWidgetDocument("Synthetic usage", usageHtml(summary, sessions, now));
}

async function listenOnLoopback(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Sandbox host did not bind a TCP address");
  }
  return address.port;
}

async function withDashboard(
  html: string,
  run: (context: { page: Page; widget: Frame; board: Locator }) => Promise<void>,
): Promise<void> {
  const sandboxHost = createSandboxHostHttpServer();
  const sandboxPort = await listenOnLoopback(sandboxHost);
  try {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1200, height: 800 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(window, "open", {
            value: (url: string) => {
              document.documentElement.dataset.widgetOpenedUrl = url;
              return window;
            },
          });
        });
        const widgetUrl = `${suite.server.baseUrl}__widget/synthetic-usage`;
        await page.route(widgetUrl, (route) =>
          route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
        );
        await installMockGateway(page, {
          sessionKey,
          featureMethods: ["board.get"],
          methodResponses: {
            "sessions.resolve": {
              ok: true,
              key: sessionKey,
              agentId: "main",
              displayName: sessionRow.displayName,
              boardFace: sessionRow.boardFace,
            },
            "sessions.describe": { session: sessionRow },
            "board.get": {
              sessionKey,
              revision: 1,
              tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
              widgets: [
                {
                  name: "usage",
                  tabId: "main",
                  title: "Usage",
                  contentKind: "html",
                  sizeW: 12,
                  sizeH: 8,
                  position: 0,
                  grantState: "none",
                  presentation: "frameless",
                  heightMode: "auto",
                  revision: 1,
                  frameUrl: widgetUrl,
                  instanceId: "synthetic-usage-instance",
                  viewTicket: "synthetic-usage-ticket",
                  viewTicketTtlMs: 1_200_000,
                  viewGeneration: "synthetic-usage-generation",
                  sandboxUrl: SANDBOX_HOST_PATH,
                  sandboxPort,
                  sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
                },
              ],
            },
          },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => {
          if (
            !error.message.startsWith(
              "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed",
            )
          ) {
            errors.push(error.message);
          }
        });
        await page.goto(`${suite.server.baseUrl}focus/dashboard/main/12345678`);
        const board = page.locator("openclaw-board-document openclaw-board-view");
        const outerFrame = page.locator(
          '.board-widget[data-widget-name="usage"] .board-widget__frame',
        );
        await outerFrame.waitFor();
        await expect
          .poll(() => outerFrame.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        const widget = page
          .frames()
          .find((candidate) => candidate.parentFrame()?.url().includes(SANDBOX_HOST_PATH));
        if (!widget) {
          throw new Error("Usage widget document is not mounted");
        }
        await widget.locator("#stat-total strong").waitFor();
        await run({ page, widget, board });
        expect(errors).toEqual([]);
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      sandboxHost.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

suite.define(() => {
  it("filters every section by day and navigates inside the real nested sandbox", async () => {
    await withDashboard(dashboardDocument(), async ({ page, widget, board }) => {
      const widgetUrl = widget.url();
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("300");
      await expectBrowser(widget.locator("#stat-input small")).toHaveText(
        "45 cached · 165 uncached",
      );
      await expectBrowser(widget.locator("#stat-output small")).toHaveText(
        "28 reasoning · 62 non-reasoning",
      );
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({
          path: path.join(suite.artifactDir, "usage-dashboard-desktop.png"),
        });
      }

      const day = widget.locator('[data-day="2026-11-05"]');
      await day.focus();
      await day.press("Enter");
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("100");
      await expectBrowser(widget.locator("#stat-input strong")).toHaveText("80");
      await expectBrowser(widget.locator("#stat-output small")).toHaveText(
        "8 reasoning · 12 non-reasoning",
      );
      await expectBrowser(widget.locator("#daily-date")).toHaveValue("2026-11-05");
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(1);
      await expectBrowser(widget.locator("#session-list")).toContainText("Alpha chat");
      await expectBrowser(widget.locator("#providers")).toContainText("100");
      expect(
        await widget.evaluate(() => (document.activeElement as HTMLElement)?.dataset.day),
      ).toBe("2026-11-05");

      await widget.getByRole("button", { name: "Uncached", exact: true }).click();
      await expectBrowser(widget.locator("#providers")).toContainText("60");
      await expectBrowser(widget.locator('[data-day="2026-11-05"]')).toHaveAttribute(
        "aria-label",
        /60 uncached input/,
      );
      await widget.getByRole("button", { name: "Non-reasoning", exact: true }).click();
      await expectBrowser(widget.locator("#providers")).toContainText("12");
      await expectBrowser(widget.locator('[data-day="2026-11-05"]')).toHaveAttribute(
        "aria-label",
        /12 non-reasoning output/,
      );
      await widget.getByRole("button", { name: "Output", exact: true }).click();
      await expectBrowser(widget.locator("#providers")).toContainText("20");
      await expectBrowser(widget.locator('[data-day="2026-11-05"]')).toHaveAttribute(
        "aria-label",
        /20 output tokens/,
      );
      await widget.locator("#daily-date").selectOption("2026-11-06");
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("200");
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(2);
      await widget.locator("#model-filter").selectOption("shared-model");
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("40");
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(1);
      const beta = widget.getByRole("button", { name: /Beta chat/ });
      await beta.scrollIntoViewIfNeeded();
      await beta.click();
      await expectBrowser(widget.locator("#details")).toContainText("Beta chat");
      await widget.getByRole("link", { name: "Open chat in new tab" }).click();
      await expect
        .poll(() => page.locator("html").getAttribute("data-widget-opened-url"))
        .toBe("https://example.test/chat/main/session/synthetic-b");
      expect(widget.url()).toBe(widgetUrl);

      await board.evaluate((element) => {
        element.scrollTop = 0;
      });
      await widget.getByRole("button", { name: "Sessions", exact: true }).click();
      await expect.poll(() => board.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(widget.url()).toBe(widgetUrl);

      await page.setViewportSize({ width: 393, height: 852 });
      await widget.locator("#reset").click();
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("300");
      await expect
        .poll(() =>
          widget.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBe(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await board.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expectBrowser(
          widget.getByRole("heading", { name: "Where your tokens go." }),
        ).toBeInViewport();
        await widget.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
              });
            }),
        );
        await page.screenshot({ path: path.join(suite.artifactDir, "usage-dashboard-mobile.png") });
      }
    });
  });

  it("searches and paginates sessions without changing aggregate totals", async () => {
    await withDashboard(dashboardDocument(24), async ({ widget }) => {
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("300");
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(20);
      await widget.locator("#usage-next").click();
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(6);
      await expectBrowser(widget.locator("#usage-page-status")).toHaveText("21–26 of 26");
      await widget.locator("#session-search").fill("Beta");
      await expectBrowser(widget.locator("#session-list .session")).toHaveCount(1);
      await expectBrowser(widget.locator("#session-list")).toContainText("Beta chat");
      await expectBrowser(widget.locator("#stat-total strong")).toHaveText("300");
      await expectBrowser(widget.locator("#usage-page-status")).toHaveText("1–1 of 1");
    });
  });

  it("does not offer guessed chat links from a legacy stale snapshot", async () => {
    await withDashboard(dashboardDocument(0, true), async ({ widget }) => {
      await widget.getByRole("button", { name: /Alpha chat/ }).click();
      await expectBrowser(widget.locator("#details")).toContainText("Alpha chat");
      await expectBrowser(widget.getByRole("link", { name: "Open chat in new tab" })).toHaveCount(
        0,
      );
    });
  });
});
