import { FsSafeError, type Root } from "../../src/infra/fs-safe.js";

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'",
};
const asset = /^assets\/(?:index-[A-Za-z0-9_-]+\.(?:js|css)|[A-Za-z0-9_-]+\.woff2)$/u;
const standalone = new Set(["sw.js", "manifest.webmanifest", "notebook.svg"]);
const readOptions = {
  symlinks: "reject",
  hardlinks: "reject",
  maxBytes: 16 * 1024 * 1024,
} as const;

export async function createProtectedStaticClient(root: Root) {
  await root.readBytes("index.html", readOptions);
  return async (request: Request): Promise<Response | undefined> => {
    const pathname = new URL(request.url).pathname;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    if (pathname !== "/" && !standalone.has(name) && !asset.test(name)) {
      return undefined;
    }
    const type = types.get(name.slice(name.lastIndexOf(".")));
    if (!type) {
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    }
    try {
      const bytes = await root.readBytes(name, readOptions);
      return new Response(request.method === "HEAD" ? null : Uint8Array.from(bytes), {
        headers: { ...headers, "content-type": type, "content-length": String(bytes.length) },
      });
    } catch (error) {
      if (error instanceof FsSafeError) {
        return new Response(null, { status: 404, headers });
      }
      throw error;
    }
  };
}
