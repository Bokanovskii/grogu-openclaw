import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronJobsListResponse, cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation groups",
  startServerBeforeBrowser: true,
});
const now = Date.parse("2026-11-12T18:00:00Z");
const groups = [
  {
    id: "research",
    label: "Research",
    description: "Follow useful questions and keep the findings together.",
    order: 2,
  },
  {
    id: "news",
    label: "News",
    description: "Stay informed without checking the headlines.",
    order: 1,
  },
  {
    id: "upkeep",
    label: "Upkeep",
    description: "Keep things healthy in the background.",
    order: 3,
  },
];
const jobs: CronJob[] = (
  [
    {
      id: "morning",
      name: "morning-digest",
      displayName: "Your morning briefing",
      groupId: "news",
      description: "Find the stories that matter to you.",
      notificationDescription: "There is a useful story to share.",
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/Los_Angeles" },
      state: { nextRunAtMs: now + 3_600_000, lastRunAtMs: now - 86_400_000, lastRunStatus: "ok" },
    },
    {
      id: "research",
      name: "continuous-research",
      displayName: "Explore your open questions",
      groupId: "research",
      description: "Research your questions and bring the findings back to the right conversation.",
      notificationDescription: "A finding changes a decision or answers an open question.",
      schedule: { kind: "every", everyMs: 1_800_000 },
      state: { runningAtMs: now - 30_000 },
      sessionTarget: "session:agent:main:background:research",
    },
    {
      id: "review",
      name: "research-review",
      displayName: "Review recent findings",
      groupId: "research",
      description: "Check sources and connect related discoveries.",
      notificationDescription: "A finding needs your attention.",
      schedule: { kind: "every", everyMs: 7_200_000 },
      state: { nextRunAtMs: now + 7_200_000 },
    },
    {
      id: "health",
      name: "health-check",
      displayName: "Keep the service healthy",
      groupId: "upkeep",
      description: "Look for service errors and failed deliveries.",
      notificationDescription: "Something needs your help.",
      schedule: { kind: "every", everyMs: 3_600_000 },
      enabled: false,
      state: { lastRunAtMs: now - 3_600_000, lastRunStatus: "error" },
    },
    {
      id: "reminder",
      name: "A reminder",
      description: "Review your notes for tomorrow.",
      schedule: { kind: "at", at: "2026-11-13T16:00:00Z" },
      state: { nextRunAtMs: now + 86_400_000 },
    },
  ] satisfies Array<Pick<CronJob, "id" | "name" | "schedule" | "state"> & Partial<CronJob>>
).map((job): CronJob =>
  Object.assign(
    {
      enabled: true,
      createdAtMs: now - 86_400_000,
      updatedAtMs: now,
      configRevision: `${job.id}-revision`,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Synthetic automation task",
        model: "example/research-model",
      },
    } satisfies Partial<CronJob>,
    job,
  ),
);

suite.define(() => {
  it("groups automations and describes them in plain words", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1100 }, locale: "en-US" },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(
              cronJobsListResponse(jobs, { groups, snapshotRevision: "group-proof" }),
            ),
            "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
            "cron.runs": {
              entries: [],
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.status": { enabled: true, jobs: jobs.length },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const row = page.locator('[data-test-id="cron-row-research"]');
        await row.waitFor();
        const surface = page.locator(".cron-page");
        const frame = await takeControlUiScreenshotFrame(page, surface, [row], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "automations-desktop.png"), frame.png);
        expect(await page.locator("[data-cron-group] > summary").allTextContents()).toEqual(
          expect.arrayContaining([
            expect.stringContaining("News"),
            expect.stringContaining("Research"),
            expect.stringContaining("Other"),
          ]),
        );
        const news = page.locator('[data-cron-group="news"]');
        expect(await news.textContent()).toContain("Every day at 08:00");
        expect(await row.textContent()).toContain("Texts you when");
        expect(await row.textContent()).toContain("example/research-model");
        await news.locator("summary").click();
        expect(await news.locator(".cron-table__row").isVisible()).toBe(false);
        await news.locator("summary").press("Enter");
        expect(await news.locator(".cron-table__row").isVisible()).toBe(true);

        await page.setViewportSize({ width: 400, height: 1000 });
        const narrow = await takeControlUiScreenshotFrame(page, surface, [row], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "automations-narrow.png"), narrow.png);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      },
    );
  });
});
