import { createServer, type Server } from "node:http";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { handleMcpAppSandboxHttpRequest } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  embedSandboxPublicScripts,
  prepareSandboxPublicScripts,
} from "../../../src/gateway/sandbox-public-resources.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../../../src/plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../../../src/plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../../src/plugins/registry-lifecycle.js";

export const sourceAuthorization = "Bearer synthetic-widget-source-credential";
export const edgeCookie = "synthetic_widget_edge=allowed";
const defaultScripts = new Map([
  [
    "/__openclaw__/renderer/static.js",
    "document.querySelector('#static-renderer').textContent='Static renderer ready';",
  ],
  [
    "/__openclaw__/renderer/dynamic.js",
    "document.querySelector('#dynamic-renderer').textContent='Dynamic renderer ready';",
  ],
]);

export async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Widget proof server did not bind a TCP port"));
      } else {
        resolve(address.port);
      }
    });
  });
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startProtectedSource(options: {
  html: string;
  upstream: string;
  documentPath: string;
  boardPath: string;
  sameOriginSandbox: boolean;
  scripts?: ReadonlyMap<string, string | Buffer>;
}) {
  const scripts = options.scripts ?? defaultScripts;
  const registry = createEmptyPluginRegistry();
  createPluginBoardWidgetContentKindRegistrar(registry)(
    createPluginRecord({
      id: "renderer-fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
    {
      kind: "renderer-fixture",
      label: "Synthetic renderer",
      resources: {
        surface: "renderer",
        paths: [...scripts.keys()],
        async readPublicResource(resourcePath) {
          const script = scripts.get(resourcePath);
          return script
            ? {
                body: typeof script === "string" ? Buffer.from(script) : script,
                contentType: "application/javascript",
              }
            : undefined;
        },
      },
      validateSource() {},
      composeDocument: () => "",
    },
  );
  markPluginRegistryActive(registry);
  const html = options.sameOriginSandbox
    ? embedSandboxPublicScripts(options.html, await prepareSandboxPublicScripts(registry))
    : options.html;
  const sourceRequests: Array<{ authorized: boolean; destination?: string }> = [];
  const boardRequests: string[] = [];
  const shellRequests: boolean[] = [];
  const rendererRequests: Array<{ authorized: boolean; destination?: string }> = [];
  const omittedHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.upstream);
      const authorizedEdge = request.headers.cookie?.split("; ").includes(edgeCookie) === true;
      const renderer = scripts.get(url.pathname);
      if (renderer) {
        const destination = request.headers["sec-fetch-dest"];
        rendererRequests.push({
          authorized: authorizedEdge,
          ...(typeof destination === "string" ? { destination } : {}),
        });
      }
      if (url.pathname === "/mcp-app-sandbox") {
        shellRequests.push(authorizedEdge);
      }
      if (options.sameOriginSandbox && !authorizedEdge && url.pathname !== "/widget-login") {
        response.writeHead(302, { Location: "/widget-login", "Cache-Control": "no-store" });
        response.end("Authentication required");
        return;
      }
      if (options.sameOriginSandbox && handleMcpAppSandboxHttpRequest(request, response, true)) {
        return;
      }
      if (renderer) {
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(renderer);
        return;
      }
      if (url.pathname === options.documentPath) {
        const authorized = request.headers.authorization === sourceAuthorization;
        const destination = request.headers["sec-fetch-dest"];
        sourceRequests.push({
          authorized,
          ...(typeof destination === "string" ? { destination } : {}),
        });
        response.writeHead(authorized ? 200 : 302, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          ...(!authorized ? { Location: "/widget-login" } : {}),
        });
        response.end(authorized ? options.html : "Authentication required");
        return;
      }
      if (url.pathname === "/widget-login") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        });
        response.end("<!doctype html><title>Synthetic sign-in</title>Sign in to view this widget.");
        return;
      }
      if (url.pathname === options.boardPath) {
        const ticket = url.searchParams.get("bt") ?? "";
        boardRequests.push(ticket);
        const authorized = ticket === "ticket" || ticket === "renewed-ticket";
        response.writeHead(authorized ? 200 : 401, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(authorized ? html : "Invalid widget ticket");
        return;
      }
      const upstream = await fetch(url, { headers: { Accept: request.headers.accept ?? "*/*" } });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!omittedHeaders.has(name)) {
          response.setHeader(name, value);
        }
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (upstream.headers.get("content-type")?.startsWith("text/html")) {
        response.setHeader(
          "Content-Security-Policy",
          buildControlUiCspHeader({
            inlineScriptHashes: computeInlineScriptHashes(body.toString("utf8")),
          }),
        );
      }
      response.end(body);
    })().catch((error: unknown) => {
      console.error("Synthetic widget ingress failed", error);
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  server.once("close", () => markPluginRegistryRetired(registry));
  const port = await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/`,
    registry,
    html,
    sourceRequests,
    boardRequests,
    shellRequests,
    rendererRequests,
  };
}
