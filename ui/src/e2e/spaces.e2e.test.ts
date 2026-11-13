import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayWindow } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const rootDir = fileURLToPath(new URL("../../../extensions/spaces", import.meta.url));
const suite = createControlUiE2eSuite({ name: "Spaces browser" });
type Edit = {
  action: string;
  operationId: string;
  spaceId: string;
  itemId: string;
  fields: Record<string, unknown>;
};
type Query = {
  action: string;
  spaceId?: string;
  items: Array<{ id: string; url: string }>;
};
const at = Date.UTC(2026, 10, 8, 12);
const space = {
  id: "trip",
  name: "Before the trip",
  description: "Tasks to finish before leaving.",
  rules: "Keep tasks short. Ask before changing a due date.",
  kind: "todo",
  revision: 4,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const shopping = {
  ...space,
  id: "groceries",
  name: "Shopping",
  kind: "shopping",
  description: "Groceries for the week.",
};
const reading = {
  ...space,
  id: "reading",
  name: "Read Later",
  kind: "read-later",
  description: "Articles worth coming back to.",
};
const vacation = {
  ...space,
  id: "holiday",
  name: "Vacation",
  kind: "vacation",
  description: "Compare destinations, sources, and dated estimates.",
};
const item = {
  id: "train",
  spaceId: "trip",
  title: "Book the train",
  notes: "Check flexible fares.",
  status: "open",
  quantity: null,
  unit: "",
  category: "Travel",
  dueDate: "2026-11-20",
  url: "https://example.com/train",
  sourceDate: null,
  estimate: null,
  currency: null,
  parentId: null,
  revision: 2,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const home = { spaces: [space, shopping, reading, vacation], total: 4, nextOffset: null };
const nativePlugins = [{ pluginId: "spaces", rootDir, source: "./browser/index.ts" }];

async function capture(
  page: import("playwright").Page,
  name: string,
  content: import("playwright").Locator[],
) {
  const frame = await takeControlUiScreenshotFrame(
    page,
    page.locator("[data-spaces=page]"),
    content,
    { animations: "disabled", scrollTo: content[0] },
  );
  writeFileSync(path.join(suite.artifactDir, name), frame.png);
}

async function setReadingReplies(
  page: import("playwright").Page,
  spaces: Array<typeof reading>,
  operation: Record<string, unknown> | null = null,
) {
  await page.evaluate(
    ({ spaces: rows, operation: receipt }) => {
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.setRequestHandler(
        "spaces.query",
        ({ params, respond }) => {
          const query = params as Query;
          respond(
            query.action === "operation"
              ? { operation: receipt }
              : query.action === "read-later.preview"
                ? { preview: query.items.map((row) => ({ ...row, duplicate: false })) }
                : query.action === "spaces.list"
                  ? { spaces: rows, total: rows.length }
                  : {
                      space: rows.find((candidate) => candidate.id === query.spaceId),
                      items: [],
                      total: 0,
                    },
          );
        },
      );
    },
    { spaces, operation },
  );
}

suite.define(() => {
  // The real host and plugin render the flow; fixed RPC responses prove UI/wire behavior, not storage.
  it("keeps native pages and preserves drafts through live revisions, conflicts, and uncertain saves", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      const nativeSurface = page.locator(".new-session-page");
      const nativeHeading = nativeSurface.getByRole("heading").first();
      await nativeHeading.waitFor();
      writeFileSync(
        path.join(suite.artifactDir, "before-native-desktop.png"),
        (
          await takeControlUiScreenshotFrame(page, nativeSurface, [nativeHeading], {
            animations: "disabled",
          })
        ).png,
      );
      writeFileSync(
        path.join(suite.artifactDir, "before-native-phone.png"),
        (
          await takeControlUiScreenshotFrame(page, nativeSurface, [nativeHeading], {
            animations: "disabled",
            viewport: { width: 390, height: 844 },
          })
        ).png,
      );
    });
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: { "spaces.query": home },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces`);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("heading", { name: "Spaces", exact: true }).waitFor();
      await surface.getByRole("link", { name: "Before the trip" }).waitFor();
      await capture(page, "after-spaces-home-desktop.png", [
        surface.getByRole("heading", { name: "Spaces", exact: true }),
        surface.getByRole("link", { name: "Before the trip" }),
      ]);
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, "after-spaces-home-phone.png", [
        surface.getByRole("heading", { name: "Spaces", exact: true }),
        surface.getByRole("link", { name: "Before the trip" }),
      ]);
      await page.setViewportSize({ width: 1280, height: 900 });
      expect(await surface.getByRole("heading", { name: "Spaces", exact: true }).count()).toBe(1);
      await gateway.setMethodResponse("spaces.query", {
        space,
        items: [item],
        total: 1,
        nextOffset: null,
      });
      await surface.getByRole("link", { name: "Before the trip" }).click();
      await surface.getByRole("heading", { name: space.name, exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("p.spaceId")).toBe("trip");
      await surface.getByRole("button", { name: "Book the train", exact: true }).click();
      await surface.getByRole("button", { name: "Edit item", exact: true }).click();
      await surface.getByLabel("Title", { exact: true }).fill("My unsaved train plan");
      await gateway.deferNext("spaces.query");
      await surface.getByRole("button", { name: "Refresh", exact: true }).click();
      const current = { ...item, title: "Updated by Grogu", revision: 3 };
      await gateway.setMethodResponse("spaces.query", { space, items: [current], total: 1 });
      await gateway.emitGatewayEvent("spaces.changed", { spaceId: "trip", metadata: false });
      await surface
        .getByText("The saved version changed. Your draft is kept.", { exact: true })
        .waitFor();
      await gateway.resolveDeferred("spaces.query", { space, items: [item], total: 1 });
      await surface.getByRole("heading", { name: "Updated by Grogu", exact: true }).waitFor();
      expect(await surface.getByLabel("Title", { exact: true }).inputValue()).toBe(
        "My unsaved train plan",
      );
      expect(
        await surface.getByRole("button", { name: "Save item", exact: true }).isDisabled(),
      ).toBe(true);
      await capture(page, "after-conflict-desktop.png", [
        surface.getByText("The saved version changed. Your draft is kept.", { exact: true }),
      ]);
      await gateway.setOnline(false);
      await page
        .getByText("Actions are unavailable while the Gateway reconnects.", { exact: true })
        .waitFor();
      await gateway.setOnline(true);
      await surface.getByLabel("Title", { exact: true }).waitFor();
      await surface
        .getByRole("button", { name: "Refresh", exact: true })
        .waitFor({ state: "visible" });
      await expect
        .poll(() => surface.getByRole("button", { name: "Refresh", exact: true }).isEnabled())
        .toBe(true);
      expect(await surface.getByLabel("Title", { exact: true }).inputValue()).toBe(
        "My unsaved train plan",
      );
      await surface.getByRole("button", { name: "Keep draft, use current revision" }).click();
      await gateway.setMethodResponse("spaces.edit", {
        status: "conflict",
        operationId: "fixture",
        message: "The item changed again.",
        item: { ...current, revision: 4 },
      });
      await surface.getByRole("button", { name: "Save item", exact: true }).click();
      const request = await gateway.waitForRequest("spaces.edit");
      const edit = request.params as Edit;
      expect(edit).toMatchObject({
        action: "item.update",
        itemId: "train",
        spaceId: "trip",
        expectedRevision: 3,
        fields: { title: "My unsaved train plan" },
      });
      expect(edit.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      await surface.getByText("The item changed again.", { exact: true }).waitFor();
      expect(await surface.getByLabel("Title", { exact: true }).inputValue()).toBe(
        "My unsaved train plan",
      );
      await gateway.setMethodResponse("spaces.query", {
        space,
        items: [{ ...current, revision: 4 }],
        total: 1,
      });
      await surface.getByRole("button", { name: "Refresh", exact: true }).click();
      await surface
        .getByText("The saved version changed. Your draft is kept.", { exact: true })
        .waitFor();
      await surface.getByRole("button", { name: "Keep draft, use current revision" }).click();
      const count = (await gateway.getRequests("spaces.edit")).length;
      await gateway.deferNext("spaces.edit");
      await surface.getByRole("button", { name: "Save item", exact: true }).click();
      const uncertain = (await gateway.waitForRequest("spaces.edit", { after: count }))
        .params as Edit;
      await gateway.rejectDeferred("spaces.edit", { message: "Synthetic connection interrupted" });
      await surface.getByRole("button", { name: "Check save", exact: true }).waitFor();
      expect(await surface.getByLabel("Title", { exact: true }).inputValue()).toBe(
        "My unsaved train plan",
      );
      await page.evaluate(
        ({ operationId, savedItem, savedSpace }) => {
          const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          mock.setRequestHandler("spaces.query", ({ params, respond }) => {
            const query = params as Query;
            respond(
              query.action === "operation"
                ? {
                    operation: {
                      operationId,
                      status: "applied",
                      message: "Saved.",
                      item: savedItem,
                    },
                  }
                : { space: savedSpace, items: [savedItem], total: 1 },
            );
          });
        },
        {
          operationId: uncertain.operationId,
          savedItem: { ...current, title: "My unsaved train plan", revision: 5 },
          savedSpace: space,
        },
      );
      await surface.getByRole("button", { name: "Check save", exact: true }).click();
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).length).toBe(count + 1);
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, "after-selected-phone.png", [
        surface.getByRole("heading", { name: space.name, exact: true }),
      ]);
      await capture(page, "after-selected-detail-phone.png", [
        surface.getByRole("heading", { name: "My unsaved train plan", exact: true }),
      ]);
      expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });
  });

  it("sends explicit completion, restore, item-revision undo, combine, and previewed import operations", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: {
          "spaces.query": { space, items: [item], total: 1 },
          "spaces.edit": { operationId: "fixture", status: "applied", message: "Saved." },
        },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces&p.spaceId=trip`);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("button", { name: "Complete", exact: true }).waitFor();
      await surface.getByRole("button", { name: "Complete", exact: true }).click();
      expect((await gateway.waitForRequest("spaces.edit")).params).toMatchObject({
        action: "item.update",
        expectedRevision: 2,
        fields: { status: "done" },
      });
      await surface.getByText("Saved.", { exact: true }).waitFor();
      await gateway.setMethodResponse("spaces.query", {
        space,
        items: [{ ...item, status: "done", revision: 3 }],
        total: 1,
      });
      await surface.getByRole("button", { name: "Refresh", exact: true }).click();
      await surface.getByRole("button", { name: "Reopen", exact: true }).click();
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        fields: { status: "open" },
        expectedRevision: 3,
      });
      const deleted = { ...item, deletedAt: at, revision: 6 };
      await gateway.setMethodResponse("spaces.query", { space, items: [deleted], total: 1 });
      await surface.getByRole("button", { name: "Trash", exact: true }).click();
      await surface.getByRole("button", { name: "Restore", exact: true }).click();
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        action: "item.restore",
        itemId: "train",
        expectedRevision: 6,
      });
      await page.evaluate(
        ({ savedSpace, currentItem, timestamp }) => {
          (window as MockGatewayWindow).openclawControlUiE2eGateway!.setRequestHandler(
            "spaces.query",
            ({ params, respond }) => {
              const query = params as Query;
              respond(
                query.action === "history"
                  ? {
                      history: [
                        {
                          id: "history-train",
                          operationId: "past-op",
                          spaceId: "trip",
                          itemId: "train",
                          action: "item.update",
                          actor: "Grogu",
                          at: timestamp,
                          before: currentItem,
                          after: { ...currentItem, revision: 4 },
                        },
                      ],
                    }
                  : { space: savedSpace, items: [{ ...currentItem, revision: 9 }], total: 1 },
              );
            },
          );
        },
        { savedSpace: space, currentItem: item, timestamp: at },
      );
      await surface.getByRole("button", { name: "History", exact: true }).click();
      const beforeUndo = (await gateway.getRequests("spaces.edit")).length;
      await surface.getByRole("button", { name: "Undo", exact: true }).click();
      await gateway.waitForRequest("spaces.edit", { after: beforeUndo });
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        action: "undo",
        historyId: "history-train",
        expectedRevision: 9,
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces&p.spaceId=groceries`);
      const milk = {
        ...item,
        id: "milk",
        spaceId: "groceries",
        title: "Oat milk",
        quantity: 2,
        unit: "cartons",
        revision: 7,
      };
      const source = {
        ...milk,
        id: "more-milk",
        title: "Extra oat milk",
        quantity: 1,
        revision: 3,
      };
      await gateway.setMethodResponse("spaces.query", {
        space: shopping,
        items: [milk, source],
        total: 2,
      });
      await surface.getByRole("button", { name: "Refresh", exact: true }).click();
      await surface.getByRole("button", { name: "Oat milk", exact: true }).click();
      await surface.getByLabel("Source item", { exact: true }).selectOption("more-milk");
      await surface.getByRole("button", { name: "Combine into Oat milk" }).click();
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        action: "shopping.combine",
        itemId: "milk",
        expectedRevision: 7,
        sourceId: "more-milk",
        sourceRevision: 3,
      });
      await capture(page, "after-shopping-desktop.png", [
        surface.getByRole("heading", { name: "Shopping", exact: true }),
      ]);
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces&p.spaceId=reading`);
      await gateway.setMethodResponse("spaces.query", { space: reading, items: [], total: 0 });
      await surface.getByRole("button", { name: "Refresh", exact: true }).click();
      await surface.getByRole("button", { name: "Import links", exact: true }).click();
      await surface
        .getByLabel("Links, one per line (up to 100)")
        .fill("https://example.com/article\nhttps://example.com/duplicate");
      await page.evaluate(() => {
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.setRequestHandler(
          "spaces.query",
          ({ params, respond }) => {
            const query = params as Query;
            respond(
              query.action === "read-later.preview"
                ? {
                    preview: query.items.map((row, index) => ({
                      id: row.id,
                      url: row.url,
                      duplicate: index === 1,
                    })),
                  }
                : {
                    space: {
                      ...query,
                      id: "reading",
                      name: "Read Later",
                      description: "Articles worth coming back to.",
                      kind: "read-later",
                      rules: "Keep source links.",
                      revision: 4,
                    },
                    items: [],
                    total: 0,
                  },
            );
          },
        );
      });
      await surface.getByRole("button", { name: "Preview import" }).click();
      await surface.getByText("Duplicate", { exact: true }).waitFor();
      await surface.getByRole("button", { name: "Import 2 links" }).click();
      await surface.getByText("Saved.", { exact: true }).waitFor();
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        action: "read-later.import",
        duplicates: "skip",
        expectedRevision: 4,
        items: [{ url: "https://example.com/article" }, { url: "https://example.com/duplicate" }],
      });
    });
  });

  it("creates required Space metadata and research fields, and keeps a closed editor draft", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: { "spaces.query": home },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces`);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("button", { name: "New Space", exact: true }).click();
      await surface.getByRole("button", { name: "Save Space", exact: true }).click();
      expect((await gateway.getRequests("spaces.edit")).length).toBe(0);
      await surface.getByLabel("Name", { exact: true }).fill("Summer holiday");
      await surface.getByLabel("Type", { exact: true }).selectOption("vacation");
      await surface
        .getByLabel("Description", { exact: true })
        .fill("Compare destinations and dated estimates.");
      await surface
        .getByLabel("Interaction rules", { exact: true })
        .fill("Keep source links and date every estimate.");
      await page.evaluate(
        ({ timestamp, baseItem }) => {
          let savedSpace: Record<string, unknown> | undefined;
          let savedItem: Record<string, unknown> | undefined;
          const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          mock.setRequestHandler("spaces.edit", ({ params, respond }) => {
            const edit = params as Edit;
            if (edit.action === "space.create") {
              savedSpace = {
                ...edit.fields,
                id: edit.spaceId,
                revision: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              };
              respond({
                operationId: edit.operationId,
                status: "applied",
                message: "Saved.",
                space: savedSpace,
              });
            } else if (edit.action === "item.create") {
              savedItem = {
                ...baseItem,
                ...edit.fields,
                id: edit.itemId,
                spaceId: edit.spaceId,
                revision: 1,
              };
              respond({
                operationId: edit.operationId,
                status: "applied",
                message: "Saved.",
                item: savedItem,
              });
            }
          });
          mock.setRequestHandler("spaces.query", ({ respond }) =>
            respond({
              space: savedSpace,
              items: savedItem ? [savedItem] : [],
              total: savedItem ? 1 : 0,
            }),
          );
        },
        { timestamp: at, baseItem: item },
      );
      await surface.getByRole("button", { name: "Save Space", exact: true }).click();
      const created = (await gateway.waitForRequest("spaces.edit")).params as Edit;
      expect(created).toMatchObject({
        action: "space.create",
        expectedRevision: 0,
        fields: {
          name: "Summer holiday",
          description: "Compare destinations and dated estimates.",
          rules: "Keep source links and date every estimate.",
          kind: "vacation",
        },
      });
      await surface.getByRole("heading", { name: "Summer holiday", exact: true }).waitFor();
      await surface.getByRole("button", { name: "Add item", exact: true }).click();
      await surface.getByLabel("Title", { exact: true }).fill("Coastal cottage");
      await surface.getByLabel("Estimate", { exact: true }).fill("1240");
      await surface.getByLabel("Currency (for example, USD)", { exact: true }).fill("USD");
      await surface.getByLabel("Estimate / source date", { exact: true }).fill("2026-11-08");
      await surface.getByLabel("Source link", { exact: true }).fill("https://example.com/cottage");
      await surface.getByRole("button", { name: "Save item", exact: true }).click();
      await gateway.waitForRequest("spaces.edit", { after: 1 });
      expect((await gateway.getRequests("spaces.edit")).at(-1)?.params).toMatchObject({
        action: "item.create",
        expectedRevision: 0,
        fields: {
          title: "Coastal cottage",
          estimate: 1240,
          currency: "USD",
          sourceDate: "2026-11-08",
          url: "https://example.com/cottage",
        },
      });
      await surface.getByRole("heading", { name: "Coastal cottage", exact: true }).waitFor();
      await capture(page, "after-vacation-desktop.png", [
        surface.getByRole("heading", { name: "Summer holiday", exact: true }),
      ]);
      await surface.getByRole("button", { name: "Edit item", exact: true }).click();
      await surface.getByLabel("Notes", { exact: true }).fill("Unsaved questions about the beach.");
      await surface.getByLabel("Notes", { exact: true }).press("Escape");
      await surface.getByRole("button", { name: "Coastal cottage", exact: true }).click();
      await surface.getByRole("button", { name: "Edit item", exact: true }).click();
      expect(await surface.getByLabel("Notes", { exact: true }).inputValue()).toBe(
        "Unsaved questions about the beach.",
      );
      await surface.getByLabel("Notes", { exact: true }).press("Escape");
      await surface.getByRole("button", { name: "Coastal cottage", exact: true }).click();
      await surface.getByRole("button", { name: "Open details panel", exact: true }).click();
      await page
        .locator("[data-spaces=panel]")
        .getByRole("heading", { name: "Coastal cottage", exact: true })
        .waitFor();
    });
  });

  it("validates UTF-8 bytes before dispatch and allows a corrected Space description", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: {
          "spaces.query": home,
          "spaces.edit": { operationId: "fixture", status: "rejected", message: "Invalid edit." },
        },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces`);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("button", { name: "New Space", exact: true }).click();
      await surface.getByLabel("Name", { exact: true }).fill("Trip notes");
      await surface.getByLabel("Interaction rules", { exact: true }).fill("Keep source links.");
      const description = surface.getByLabel("Description", { exact: true });
      await description.fill("é".repeat(121));
      await surface.getByRole("button", { name: "Save Space", exact: true }).click();
      await surface
        .getByRole("alert")
        .filter({ hasText: "Description must fit within 240 UTF-8 bytes." })
        .waitFor();
      expect(await gateway.getRequests("spaces.edit")).toHaveLength(0);
      expect(await surface.getByRole("button", { name: "Check save", exact: true }).count()).toBe(
        0,
      );
      expect(await description.isEnabled()).toBe(true);
      await capture(page, "after-description-byte-validation.png", [description]);
      await description.fill("é".repeat(120));
      await surface.getByRole("button", { name: "Save Space", exact: true }).click();
      expect((await gateway.waitForRequest("spaces.edit")).params).toMatchObject({
        action: "space.create",
        expectedRevision: 0,
        fields: { description: "é".repeat(120) },
      });
      await surface.getByText("Invalid edit.", { exact: true }).waitFor();
      expect(await description.isEnabled()).toBe(true);
    });
  });

  it("settles only the submitted import draft across newer text, Space switching, and reconnect", async () => {
    await suite.withPage({}, async ({ page }) => {
      const otherReading = { ...reading, id: "other-reading", name: "Other reading" };
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: { "spaces.query": { space: reading, items: [], total: 0 } },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces&p.spaceId=reading`);
      await setReadingReplies(page, [reading, otherReading]);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("button", { name: "Import links", exact: true }).click();
      const text = surface.getByLabel("Links, one per line (up to 100)");
      await text.fill("https://example.com/batch-a");
      await surface.getByRole("button", { name: "Preview import", exact: true }).click();
      await gateway.deferNext("spaces.edit");
      await surface.getByRole("button", { name: "Import 1 links", exact: true }).click();
      const first = (await gateway.waitForRequest("spaces.edit")).params as Edit;
      await text.fill("https://example.com/batch-b");
      await gateway.resolveDeferred("spaces.edit", {
        operationId: first.operationId,
        status: "applied",
        message: "Saved.",
        imported: 1,
      });
      await surface.getByText("Saved 1 links. Skipped 0 duplicates.", { exact: true }).waitFor();
      expect(await text.inputValue()).toBe("https://example.com/batch-b");
      await capture(page, "after-import-newer-draft.png", [text]);

      await surface.getByRole("button", { name: "Preview import", exact: true }).click();
      await gateway.deferNext("spaces.edit");
      await surface.getByRole("button", { name: "Import 1 links", exact: true }).click();
      const switched = (await gateway.waitForRequest("spaces.edit", { after: 1 })).params as Edit;
      await surface.getByRole("link", { name: "← Spaces", exact: true }).click();
      await surface.getByRole("link", { name: "Other reading", exact: true }).click();
      await gateway.rejectDeferred("spaces.edit", { message: "Synthetic lost import reply" });
      await surface.getByRole("button", { name: "Check save", exact: true }).waitFor();
      await gateway.setOnline(false);
      await page
        .getByText("Actions are unavailable while the Gateway reconnects.", { exact: true })
        .waitFor();
      await gateway.setOnline(true);
      await surface.getByRole("button", { name: "Check save", exact: true }).waitFor();
      await setReadingReplies(page, [reading, otherReading], {
        operationId: switched.operationId,
        status: "applied",
        message: "Saved.",
        imported: 1,
      });
      await surface.getByRole("button", { name: "Check save", exact: true }).click();
      await surface.getByText("Saved 1 links. Skipped 0 duplicates.", { exact: true }).waitFor();
      await surface.getByRole("button", { name: "Import links", exact: true }).click();
      expect(await text.inputValue()).toBe("https://example.com/batch-b");
      expect(await gateway.getRequests("spaces.edit")).toHaveLength(2);

      await text.fill("https://example.com/batch-c");
      await surface.getByRole("button", { name: "Preview import", exact: true }).click();
      await gateway.deferNext("spaces.edit");
      await surface.getByRole("button", { name: "Import 1 links", exact: true }).click();
      const pending = (await gateway.waitForRequest("spaces.edit", { after: 2 })).params as Edit;
      await text.fill("https://example.com/batch-d");
      await gateway.rejectDeferred("spaces.edit", { message: "Synthetic lost import reply" });
      await surface.getByRole("button", { name: "Check save", exact: true }).waitFor();
      await gateway.setOnline(false);
      await page
        .getByText("Actions are unavailable while the Gateway reconnects.", { exact: true })
        .waitFor();
      await gateway.setOnline(true);
      await surface.getByRole("button", { name: "Check save", exact: true }).waitFor();
      await setReadingReplies(page, [reading, otherReading], {
        operationId: pending.operationId,
        status: "applied",
        message: "Saved.",
        imported: 1,
      });
      await surface.getByRole("button", { name: "Check save", exact: true }).click();
      await surface.getByText("Saved 1 links. Skipped 0 duplicates.", { exact: true }).waitFor();
      expect(await text.inputValue()).toBe("https://example.com/batch-d");
      expect(await gateway.getRequests("spaces.edit")).toHaveLength(3);
      await capture(page, "after-import-reconnect-newer-draft.png", [text]);
    });
  });

  it("updates the saved Space named new instead of treating its ID as a creation draft", async () => {
    await suite.withPage({}, async ({ page }) => {
      const existing = { ...space, id: "new", revision: 1 };
      const gateway = await installMockGateway(page, {
        nativePlugins,
        methodResponses: {
          "spaces.query": { space: existing, items: [], total: 0 },
          "spaces.edit": {
            operationId: "fixture",
            status: "rejected",
            message: "Synthetic record unchanged.",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=spaces&id=spaces&p.spaceId=new`);
      const surface = page.locator("[data-spaces=page]");
      await surface.getByRole("button", { name: "Edit Space", exact: true }).click();
      await surface.getByLabel("Name", { exact: true }).fill("Updated trip");
      await surface.getByRole("button", { name: "Save Space", exact: true }).click();
      expect((await gateway.waitForRequest("spaces.edit")).params).toMatchObject({
        action: "space.update",
        spaceId: "new",
        expectedRevision: 1,
        fields: { name: "Updated trip" },
      });
    });
  });
});
