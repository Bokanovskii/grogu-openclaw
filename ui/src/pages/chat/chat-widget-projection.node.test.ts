import { expect, it } from "vitest";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";

it("projects one native document slot from duplicate answer embeds and its tool receipt", () => {
  const shortcode = '[embed ref="cv_fixture" /]';
  const messages = [
    { role: "user", content: "Show the result.", timestamp: 1 },
    {
      role: "assistant",
      content: `The first part. ${shortcode}\nThe second part. ${shortcode}`,
      timestamp: 3,
    },
  ];
  const toolMessages = [
    {
      role: "toolResult",
      toolCallId: "canvas-call",
      toolName: "canvas_render",
      timestamp: 2,
      content: JSON.stringify({
        kind: "canvas",
        view: {
          id: "cv_fixture",
          url: "/__openclaw__/canvas/documents/cv_fixture/index.html",
        },
        presentation: { target: "assistant_message", sandbox: "scripts" },
      }),
    },
  ];
  const before = structuredClone({ messages, toolMessages });
  const items = buildChatItems(createProps({ messages, toolMessages, showToolCalls: false }));
  const rendered = items
    .filter((item) => item.kind === "group")
    .flatMap((group) => group.messages.map((entry) => safeNormalizeMessage(entry.message)));
  const blocks = rendered.flatMap((message) => message?.content ?? []);
  expect(blocks.filter((block) => block.type === "canvas")).toMatchObject([
    { preview: { viewId: "cv_fixture", sandbox: "scripts" } },
  ]);
  expect(
    blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  ).toContain("The first part. \nThe second part.");
  expect({ messages, toolMessages }).toEqual(before);
  expect(
    items
      .filter((item) => item.kind === "group")
      .flatMap((group) => group.messages)
      .filter((entry) => entry.key === "canvas:doc:cv_fixture"),
  ).toHaveLength(1);
});
