/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { currentThemeBranding, setCurrentThemeBranding } from "../../../app/theme-branding.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

let view: HTMLDivElement;

const defaultBranding = currentThemeBranding();

beforeEach(() => {
  view = document.createElement("div");
});

afterEach(() => {
  setCurrentThemeBranding(defaultBranding);
});

it("lets Grogu eat live reasoning ahead of the run metrics in place of the claw", () => {
  const avatar = "data:image/png;base64,iVBORw0KGgo=";
  const parts = [{ kind: "reading-indicator" as const, key: "reading", startedAt: 1_000 }];
  const renderWorking = (options: Parameters<typeof renderStreamGroup>[1]) =>
    render(
      renderStreamGroup(parts, {
        assistant: { agentId: "grogu", name: "Grogu Local (Sparky)", avatar },
        runOutputTokens: 373,
        ...options,
      }),
      view,
    );
  const rowOrder = () =>
    [...(view.querySelector(".chat-working-indicator")?.children ?? [])].map(
      (child) => child.classList[0],
    );
  const eating = () =>
    view.querySelector(".chat-grogu-eater")?.classList.contains("chat-grogu-eater--eating");

  renderWorking({ runReasoning: "checking the forecast" });
  expect(view.querySelector(".chat-reading-indicator")).toBeNull();
  expect(view.querySelector(".chat-grogu-eater")?.getAttribute("aria-hidden")).toBe("true");
  expect(
    [...view.querySelectorAll(".chat-grogu-eater__pose")].map((pose) => pose.classList[1]),
  ).toEqual([
    "chat-grogu-eater__pose--look",
    "chat-grogu-eater__pose--blink",
    "chat-grogu-eater__pose--reach",
    "chat-grogu-eater__pose--bite",
    "chat-grogu-eater__pose--chew",
  ]);
  expect(rowOrder()).toEqual([
    "chat-grogu-eater",
    "chat-working-indicator__reasoning",
    "chat-working-indicator__status",
  ]);
  expect(view.querySelector(".chat-working-indicator__tokens")?.textContent).toBe(
    "373 output tokens",
  );
  expect(eating()).toBe(true);

  renderWorking({ runReasoning: "checking the forecast for Hoth" });
  expect(view.querySelector(".chat-working-indicator__reasoning")?.textContent).toBe(
    "checking the forecast for Hoth",
  );

  renderWorking({});
  expect(rowOrder()).toEqual(["chat-grogu-eater", "chat-working-indicator__status"]);
  expect(eating()).toBe(false);

  // A theme's own indicator and other agents, even with avatars, keep their glyph.
  renderWorking({ branding: { ...currentThemeBranding(), workingIndicator: "dots" } });
  expect(view.querySelector(".chat-grogu-eater")).toBeNull();
  expect(view.querySelector(".chat-reading-indicator--neutral")).not.toBeNull();
  renderWorking({
    assistant: { agentId: "main", name: "Groot", avatar },
    runReasoning: "checking the forecast",
  });
  expect(view.querySelector(".chat-grogu-eater")).toBeNull();
  expect(view.querySelector(".chat-reading-indicator svg")).not.toBeNull();
  expect(rowOrder()).toEqual([
    "chat-bubble",
    "chat-working-indicator__reasoning",
    "chat-working-indicator__status",
  ]);
});

it("parks a still Grogu in the finished-turn recap in place of the claw", () => {
  const renderRecap = (grogu: boolean) =>
    render(renderTurnRecapRow({ runtimeMs: 12_000, outputTokens: 42 }, { grogu }), view);

  renderRecap(true);
  expect(view.querySelector(".chat-turn-recap__claw")).toBeNull();
  expect(view.querySelector(".chat-turn-recap__grogu .chat-grogu-eater")).not.toBeNull();
  expect(
    view.querySelector(".chat-grogu-eater")?.classList.contains("chat-grogu-eater--eating"),
  ).toBe(false);
  expect(view.querySelector(".chat-turn-recap")?.textContent).toContain("Done in 12 seconds");

  renderRecap(false);
  expect(view.querySelector(".chat-grogu-eater")).toBeNull();
  expect(view.querySelector(".chat-turn-recap__claw svg")).not.toBeNull();

  // Another theme brand icon stays the theme's choice.
  setCurrentThemeBranding({ ...defaultBranding, brandIcon: "mark" });
  renderRecap(true);
  expect(view.querySelector(".chat-grogu-eater")).toBeNull();
  expect(view.querySelector(".chat-turn-recap__claw")).not.toBeNull();
});
