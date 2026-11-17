/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWidgetHtml } from "./widget-export.ts";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  document.body.append(frame);
  return frame;
}

function watchDownloads() {
  const downloads: Array<[string, string]> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push([this.href, this.download]);
  });
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:widget-source");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { downloads, createUrl, revokeUrl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("widget HTML download", () => {
  it("downloads retained authenticated HTML immediately without a snapshot or fetch", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    frame.src = "https://sandbox.example/mcp-app-sandbox";
    const fetchDocument = vi.fn();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    vi.stubGlobal("fetch", fetchDocument);
    const { downloads, createUrl, revokeUrl } = watchDownloads();

    const result = downloadWidgetHtml(frame, "Isolated widget", {
      documentHtml: "<p>Authenticated document</p>",
    });

    expect(downloads).toEqual([["blob:widget-source", "Isolated-widget.html"]]);
    expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ size: 29, type: "text/html" });
    expect(revokeUrl).toHaveBeenCalledWith("blob:widget-source");
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    await result;
  });

  it("fetches a hosted document without waiting for a snapshot", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn(async () => new Response("<p>Saved widget</p>"));
    vi.stubGlobal("fetch", fetchDocument);
    const { downloads } = watchDownloads();
    const result = downloadWidgetHtml(frame, "Saved widget");

    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
    await result;
    expect(downloads).toEqual([["blob:widget-source", "Saved-widget.html"]]);
  });

  it.each([
    ["  Quarterly / status: Q3?  ", "Quarterly-status-Q3.html"],
    ["... <> ", "widget.html"],
    [`${"a".repeat(119)}📊`, `${"a".repeat(119)}.html`],
  ])("sanitizes HTML download filename %s", async (title, filename) => {
    const { downloads } = watchDownloads();
    await downloadWidgetHtml(createWidgetFrame(), title, { documentHtml: "<p>Widget</p>" });
    expect(downloads).toEqual([["blob:widget-source", filename]]);
  });

  it.each([
    [null, "widget document URL is unavailable"],
    ["https://example.com/widget.html", "widget document URL is not same-origin"],
  ])("rejects unavailable or untrusted document URL %s", async (src, error) => {
    const frame = createWidgetFrame();
    if (src === null) {
      frame.removeAttribute("src");
    } else {
      frame.src = src;
    }
    const fetchDocument = vi.fn();
    vi.stubGlobal("fetch", fetchDocument);
    await expect(downloadWidgetHtml(frame, "Widget")).rejects.toThrow(error);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("reports failed document fetches without downloading an error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    const { downloads } = watchDownloads();
    await expect(downloadWidgetHtml(createWidgetFrame(), "Missing")).rejects.toThrow(
      "widget document download failed (404)",
    );
    expect(downloads).toEqual([]);
  });
});
