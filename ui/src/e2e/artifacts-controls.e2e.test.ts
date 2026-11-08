import { expect, it } from "vitest";
import type {
  AgentsWorkspaceEntry,
  AgentsWorkspaceGetResult,
  AgentsWorkspaceListResult,
} from "../../../packages/gateway-protocol/src/schema/agents-workspace.ts";
import type { AgentsListResult } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Artifacts selection and sorting",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("resets the directory on agent selection and applies both sort choices before previewing", async () => {
    const agents: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "scout", name: "Scout" },
      ],
    };
    const files: AgentsWorkspaceEntry[] = [
      { path: "Alpha.md", name: "Alpha.md", kind: "file", updatedAtMs: 10 },
      { path: "Zebra.md", name: "Zebra.md", kind: "file", updatedAtMs: 20 },
    ];
    const root: AgentsWorkspaceListResult = {
      agentId: "main",
      path: "",
      entries: [{ path: "reports", name: "reports", kind: "directory" }, ...files],
      totalEntries: 3,
      offset: 0,
    };
    const content = "Artifact preview from the selected agent.";
    const preview: AgentsWorkspaceGetResult = {
      agentId: "scout",
      file: {
        path: "Alpha.md",
        name: "Alpha.md",
        encoding: "utf8",
        mimeType: "text/markdown",
        size: content.length,
        updatedAtMs: 10,
        content,
      },
    };
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": agents,
            "agents.workspace.list": root,
            "agents.workspace.get": preview,
          },
        });
        await page.goto(`${suite.server.baseUrl}artifacts`);
        const artifacts = page.locator("openclaw-artifacts-page");
        await artifacts.getByRole("button", { name: /reports/ }).waitFor();
        await gateway.setMethodResponse("agents.workspace.list", {
          ...root,
          path: "reports",
          entries: [],
          totalEntries: 0,
        } satisfies AgentsWorkspaceListResult);
        await artifacts.getByRole("button", { name: /reports/ }).click();
        await artifacts.locator(".artifacts-crumb--current", { hasText: "reports" }).waitFor();

        await gateway.setMethodResponse("agents.workspace.list", {
          ...root,
          agentId: "scout",
          entries: files,
          totalEntries: 2,
        } satisfies AgentsWorkspaceListResult);
        await artifacts.getByRole("combobox", { name: "Agent", exact: true }).selectOption("scout");
        const names = artifacts.locator(".artifacts-entry__name");
        await artifacts.getByRole("button", { name: /Zebra.md/ }).waitFor();
        expect(await names.allTextContents()).toEqual(["Zebra.md", "Alpha.md"]);

        const sort = artifacts.getByRole("combobox", { name: "Sort files", exact: true });
        await sort.selectOption("name");
        await names.first().filter({ hasText: "Alpha.md" }).waitFor();
        expect(await names.allTextContents()).toEqual(["Alpha.md", "Zebra.md"]);
        await sort.selectOption("recent");
        await names.first().filter({ hasText: "Zebra.md" }).waitFor();
        expect(await names.allTextContents()).toEqual(["Zebra.md", "Alpha.md"]);

        await artifacts.getByRole("button", { name: /Alpha.md/ }).click();
        await artifacts.locator(".artifacts-preview__markdown", { hasText: content }).waitFor();
        const requests = await gateway.getRequests();
        expect(
          requests
            .filter(({ method }) => method === "agents.workspace.list")
            .map(({ params }) => params),
        ).toContainEqual({ agentId: "main", path: "reports", limit: 500 });
        expect(
          requests
            .filter(({ method }) => method === "agents.workspace.list")
            .map(({ params }) => params),
        ).toContainEqual({ agentId: "scout", limit: 500 });
        expect(
          requests
            .filter(({ method }) => method === "agents.workspace.get")
            .map(({ params }) => params),
        ).toContainEqual({ agentId: "scout", path: "Alpha.md" });
      },
    );
  });
});
