import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../../../src/infra/net/ssrf.js";

/**
 * Loopback-only forward proxy for the protected browser. Core SSRF policy owns
 * the allow/deny decision; this module only enforces it at connect time against
 * the pinned addresses, so DNS rebinding after a navigation check cannot reach
 * private, loopback or metadata services. It records nothing about traffic.
 */
export type EgressProxy = {
  server: string;
  username: string;
  password: string;
  close: () => Promise<void>;
};

const allowedPorts = new Set([80, 443]);
const maxSockets = 128;
const connectTimeoutMs = 15_000;
const idleTimeoutMs = 60_000;
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseConnectTarget(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s/@]+):(\d{1,5})$/.exec(authority);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const port = Number(match[2]);
  const host = match[1].replace(/^\[|\]$/g, "");
  return allowedPorts.has(port) && host ? { host, port } : undefined;
}

function forwardHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (!hopByHopHeaders.has(name) && value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

export async function startEgressProxy(
  options: { policy?: SsrFPolicy; lookupFn?: LookupFn } = {},
): Promise<EgressProxy> {
  const username = "alcove";
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const sockets = new Set<Duplex>();
  const authorized = (header: string | undefined) => {
    const actual = Buffer.from(header ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const pin = async (host: string) => {
    const pinned = await resolvePinnedHostnameWithPolicy(host, {
      policy: options.policy,
      lookupFn: options.lookupFn,
    });
    const address = pinned.addresses[0];
    if (!address) {
      throw new Error("unresolved");
    }
    return address;
  };
  const track = (socket: Duplex) => {
    if (sockets.size >= maxSockets) {
      socket.destroy();
      return false;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return true;
  };

  const server = http.createServer((request, response) => {
    if (!authorized(request.headers["proxy-authorization"])) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="alcove"' }).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    if (target.protocol !== "http:" || port !== 80 || target.username || target.password) {
      response.writeHead(403).end();
      return;
    }
    const headers = forwardHeaders(request.headers);
    headers.host = target.host;
    void pin(target.hostname.replace(/^\[|\]$/g, "")).then(
      (address) => {
        const upstream = http.request({
          host: address,
          port,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          setHost: false,
          timeout: idleTimeoutMs,
        });
        upstream.on("response", (reply) => {
          response.writeHead(reply.statusCode ?? 502, forwardHeaders(reply.headers));
          reply.pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(502);
          }
          response.end();
        });
        request.pipe(upstream);
      },
      () => {
        response.writeHead(403).end();
      },
    );
  });

  server.on("connect", (request, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!authorized(request.headers["proxy-authorization"])) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="alcove"\r\n\r\n',
      );
      return;
    }
    const target = parseConnectTarget(request.url ?? "");
    if (!target) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    void pin(target.host).then(
      (address) => {
        if (client.destroyed) {
          return;
        }
        const upstream = net.connect({ host: address, port: target.port });
        if (!track(upstream)) {
          client.destroy();
          return;
        }
        upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
        upstream.once("connect", () => {
          upstream.setTimeout(idleTimeoutMs);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      },
      () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"),
    );
  });
  // A plain-HTTP proxy must not tunnel WebSocket or other upgrades around the CONNECT checks.
  server.on("upgrade", (_request, socket: Duplex) => socket.destroy());
  server.on("connection", (socket) => {
    if (track(socket)) {
      socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Browser egress proxy failed to bind.");
  }
  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
