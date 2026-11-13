// Control UI tests cover the working claw's alignment and fixed size, and
// Grogu's reasoning-eater row.
import { render } from "lit";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";
import { renderChatWorkingIndicator } from "./components/chat-working-indicator.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowser = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

const claw = `
  <svg viewBox="0 0 24 24">
    <path d="M8.2 10 A5.2 5.2 0 1 0 8.2 20.4 A5.2 5.2 0 0 0 8.2 10 Z M10.2 20 C14.5 20.8 19 18.6 22.3 13.2 C21 12.9 19.7 12.7 18.4 12.8 L17.5 14.6 L16 12.9 L14.3 14.5 L13.5 13 L11.5 14.2 Z"></path>
    <path class="claw-icon__jaw" d="M5.6 12.2 C5.2 5.6 10.4 1.4 15.6 2 C19.4 2.6 21.8 5.2 22.6 8.2 C20.9 7.7 19.2 7.6 17.6 7.9 L16.9 6.3 L15.2 8.5 C13.6 9.4 12.2 10.9 11.6 12.4 L6.8 13 Z"></path>
  </svg>`;

describeBrowser("working claw browser layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("centers the claw when grouped chat styles load after the indicator styles", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 240 } });
    try {
      const css = [
        "ui/src/styles/base.css",
        "ui/src/styles/components.css",
        "ui/src/styles/chat/startup-layout.css",
        "ui/src/styles/chat/working-indicator.css",
        // Production code splitting can attach grouped chat CSS after the
        // indicator chunk. The centering invariant must not depend on order.
        "ui/src/styles/chat/grouped.css",
      ]
        .map((file) => readStyleSheet(file))
        .join("\n");
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
        <div class="chat-group assistant chat-group--working">
          <div class="chat-working-indicator">
            <div class="chat-bubble chat-reading-indicator">${claw}</div>
            <span class="chat-working-indicator__status">
              <span class="chat-working-indicator__elapsed">8s</span><span>·</span><span>72 tokens</span>
            </span>
          </div>
        </div>
      </body></html>`);

      const geometry = await page.evaluate(() => {
        const center = (selector: string) => {
          const bounds = document.querySelector(selector)!.getBoundingClientRect();
          return bounds.top + bounds.height / 2;
        };
        const svg = document.querySelector<SVGElement>(".chat-reading-indicator svg")!;
        return {
          display: getComputedStyle(document.querySelector(".chat-reading-indicator")!).display,
          layoutCenter: center(".chat-reading-indicator"),
          paintedCenter: center(".chat-reading-indicator svg"),
          statusCenter: center(".chat-working-indicator__status"),
          translate: getComputedStyle(svg).translate,
          width: getComputedStyle(svg).width,
          height: getComputedStyle(svg).height,
        };
      });

      // As a flex item, inline-flex is blockified to flex in computed style.
      expect(geometry.display).toBe("flex");
      expect(geometry.layoutCenter).toBeCloseTo(geometry.statusCenter, 3);
      expect(geometry.paintedCenter).toBeCloseTo(geometry.statusCenter, 3);
      expect(geometry.translate).toBe("none");
      expect(geometry.width).toBe("18px");
      expect(geometry.height).toBe("18px");
    } finally {
      await page.close();
    }
  });

  it("lets Grogu eat live reasoning at the start while run metrics keep the end", async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      const css = [
        "ui/src/styles/base.css",
        "ui/src/styles/components.css",
        "ui/src/styles/chat/startup-layout.css",
        "ui/src/styles/chat/working-indicator.css",
        "ui/src/styles/chat/grouped.css",
      ]
        .map((file) => readStyleSheet(file))
        .join("\n");
      const rowMarkup = (reasoning?: string) => {
        const host = document.createElement("div");
        render(
          renderChatWorkingIndicator(
            { kind: "reading-indicator", key: "reading", startedAt: Date.now() - 72_000 },
            { groguEater: true, outputTokens: 373, reasoning },
          ),
          host,
        );
        return host.innerHTML;
      };
      const load = async (dir: "ltr" | "rtl", reasoning?: string) => {
        await page.setContent(`<!doctype html><html dir="${dir}"><head><style>${css}</style></head><body>
          <div class="chat-thread chat-thread--direct"><div class="chat-group assistant chat-group--working">
            <div class="chat-group-messages">${rowMarkup(reasoning)}</div>
          </div></div></body></html>`);
      };
      const measure = () =>
        page.evaluate(() => {
          const box = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const sprite = document.querySelector<SVGElement>(".chat-grogu-eater__sprite")!;
          const row = box(".chat-working-indicator");
          const eater = box(".chat-grogu-eater");
          const reasoning = box(".chat-working-indicator__reasoning");
          const status = box(".chat-working-indicator__status");
          const text = box(".chat-working-indicator__reasoning-text");
          return {
            row: { left: row.left, right: row.right },
            eater: { left: eater.left, right: eater.right },
            sprite: [sprite.clientWidth, sprite.clientHeight],
            mirror: getComputedStyle(sprite).transform,
            reasoning: { left: reasoning.left, right: reasoning.right },
            status: { left: status.left, right: status.right },
            text: { left: text.left, right: text.right },
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
      // Pins every pose animation at one instant and reports the visible poses.
      const posesAt = (ms: number) =>
        page.evaluate((time) => {
          for (const animation of document.getAnimations()) {
            animation.pause();
            animation.currentTime = time;
          }
          return [...document.querySelectorAll<SVGGElement>(".chat-grogu-eater__pose")]
            .filter((pose) => getComputedStyle(pose).opacity === "1")
            .map((pose) => pose.classList[1]!.replace("chat-grogu-eater__pose--", ""));
        }, ms);
      const stream = "weighing the forecast against the lift schedule ".repeat(6);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await load("ltr", stream);
      const ltr = await measure();
      expect(ltr.sprite).toEqual([44, 28]);
      expect(ltr.mirror).toBe("none");
      expect(ltr.eater.left).toBeCloseTo(ltr.row.left, 0);
      expect(ltr.eater.right).toBeLessThanOrEqual(ltr.reasoning.left);
      expect(ltr.reasoning.right).toBeLessThanOrEqual(ltr.status.left);
      expect(ltr.status.right).toBeCloseTo(ltr.row.right, 0);
      // The newest reasoning stays beside the metrics; older text runs into Grogu.
      expect(ltr.text.right).toBeCloseTo(ltr.reasoning.right, 0);
      expect(ltr.text.left).toBeLessThan(ltr.reasoning.left);
      expect(ltr.documentOverflow).toBe(0);
      // One 1.6s bite: watch, reach for a crumb, bite it, chew, glance, chew again.
      const eating = [];
      for (const ms of [100, 500, 800, 1_000, 1_200, 1_350, 1_550]) {
        eating.push(await posesAt(ms));
      }
      expect(eating).toEqual([
        ["look"],
        ["reach"],
        ["bite"],
        ["chew"],
        ["look"],
        ["chew"],
        ["look"],
      ]);

      await load("rtl", stream);
      const rtl = await measure();
      expect(rtl.mirror).toBe("matrix(-1, 0, 0, 1, 0, 0)");
      expect(rtl.eater.right).toBeCloseTo(rtl.row.right, 0);
      expect(rtl.eater.left).toBeGreaterThanOrEqual(rtl.reasoning.right);
      expect(rtl.reasoning.left).toBeGreaterThanOrEqual(rtl.status.right);
      expect(rtl.status.left).toBeCloseTo(rtl.row.left, 0);
      expect(rtl.text.left).toBeCloseTo(rtl.reasoning.left, 0);
      expect(rtl.text.right).toBeGreaterThan(rtl.reasoning.right);
      expect(rtl.documentOverflow).toBe(0);

      // Without reasoning he watches and blinks; metrics still keep the end.
      await load("ltr");
      expect([await posesAt(1_000), await posesAt(3_950)]).toEqual([["look"], ["blink"]]);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await load("ltr", stream);
      const eaterAnimations = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              ({ effect }) =>
                effect instanceof KeyframeEffect && effect.target?.closest(".chat-grogu-eater"),
            ).length,
      );
      expect(eaterAnimations).toBe(0);
      expect(await posesAt(0)).toEqual(["look"]);
      const still = await measure();
      expect(still.sprite).toEqual([44, 28]);
      expect(still.status.right).toBeCloseTo(still.row.right, 0);
    } finally {
      await page.close();
    }
  });
});
