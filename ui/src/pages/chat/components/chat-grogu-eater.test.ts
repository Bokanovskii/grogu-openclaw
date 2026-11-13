/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, expect, it } from "vitest";
import { currentThemeBranding } from "../../../components/neutral-mark.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";

let view: HTMLDivElement;

beforeEach(() => {
  view = document.createElement("div");
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
