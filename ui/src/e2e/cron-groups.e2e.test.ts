import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronJobsListResponse, cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation groups and live runs",
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
const runMessages = [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I will compare the sources before sharing a conclusion." },
      {
        type: "toolCall",
        id: "search-1",
        name: "web_search",
        arguments: { query: "Synthetic research question" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "search-1",
    toolName: "web_search",
    content: [{ type: "text", text: "Two useful sources found." }],
  },
  { role: "assistant", content: "I found two sources and am checking the details." },
];

suite.define(() => {
  it("groups automations and opens an updating run inside Automations", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1100 }, locale: "en-US" },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        const gateway = await installMockGateway(page, {
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
            "cron.history": {
              messages: runMessages,
            },
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
        await page.setViewportSize({ width: 1440, height: 1100 });
        await row.locator(".cron-table__name").click();
        await page.getByRole("button", { name: "View live run", exact: true }).click();
        const transcript = page.locator("[data-cron-run-transcript]");
        await transcript
          .getByText("I found two sources and am checking the details.", { exact: true })
          .waitFor();
        await transcript.getByText("Reasoning", { exact: true }).click();
        expect(await transcript.textContent()).toContain("I will compare the sources");
        expect(await transcript.textContent()).toContain("web_search");
        await transcript.locator(".chat-task-feed__tool-group > summary").click();
        await transcript.locator(".chat-task-feed__tool-line > summary").click();
        await transcript.getByText("Two useful sources found.", { exact: true }).waitFor();
        const liveFrame = await takeControlUiScreenshotFrame(page, transcript, [
          transcript.getByText("Two useful sources found.", { exact: true }),
          transcript.getByText("I will compare the sources before sharing a conclusion.", {
            exact: true,
          }),
        ]);
        await writeFile(path.join(suite.artifactDir, "automation-live-run.png"), liveFrame.png);
        await gateway.setMethodResponse("cron.history", {
          messages: [
            ...runMessages,
            { role: "assistant", content: "The sources agree. Here is the verified finding." },
          ],
        });
        // The timer must update the view without any Gateway event.
        await transcript
          .getByText("The sources agree. Here is the verified finding.", { exact: true })
          .waitFor();
        await gateway.setMethodResponse("cron.runs", {
          entries: [
            {
              jobId: "research",
              action: "finished",
              runAtMs: now - 30_000,
              ts: now,
              status: "ok",
              deliveryStatus: "delivered",
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        });
        const completedJobs: CronJob[] = jobs.map((job) =>
          job.id === "research"
            ? Object.assign({}, job, {
                state: {
                  lastRunAtMs: now - 30_000,
                  lastRunStatus: "ok",
                  nextRunAtMs: now + 1_800_000,
                } satisfies CronJob["state"],
              })
            : job,
        );
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(
            cronJobsListResponse(completedJobs, { groups, snapshotRevision: "completed-proof" }),
          ),
        );
        await gateway.setMethodResponse("cron.get", {
          cases: completedJobs.map((job) => ({ match: { id: job.id }, response: job })),
        });
        await gateway.emitGatewayEvent("cron", { jobId: "research", action: "finished" });
        await transcript.getByText("The result was delivered.", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "View live run", exact: true })
          .waitFor({ state: "detached" });
        expect(new URL(page.url()).pathname).toBe("/cron");
        const runFrame = await takeControlUiScreenshotFrame(
          page,
          transcript,
          [
            transcript.getByText("The sources agree. Here is the verified finding.", {
              exact: true,
            }),
          ],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "automation-run.png"), runFrame.png);
        await page.locator('[data-test-id="cron-detail-tab-settings"]').click();
        expect(await transcript.count()).toBe(0);
      },
    );
  });
});
