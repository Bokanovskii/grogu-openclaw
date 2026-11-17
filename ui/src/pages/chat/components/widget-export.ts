import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export async function downloadWidgetHtml(
  frame: HTMLIFrameElement,
  title: string | undefined,
  options: { documentHtml?: string } = {},
): Promise<void> {
  const rawStem = Array.from((title ?? "").trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || '<>:"/\\|?*'.includes(character)
      ? "-"
      : character;
  })
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "");
  const filename = truncateUtf16Safe(rawStem, 120).replace(/[. -]+$/g, "") || "widget";
  let blob: Blob;
  if (options.documentHtml !== undefined) {
    blob = new Blob([options.documentHtml], { type: "text/html" });
  } else {
    const src = frame.getAttribute("src");
    if (!src) {
      throw new Error("widget document URL is unavailable");
    }
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("widget document URL is not same-origin");
    }
    const response = await globalThis.fetch(url.href);
    if (!response.ok) {
      throw new Error(`widget document download failed (${response.status})`);
    }
    blob = await response.blob();
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${filename}.html`;
    link.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
