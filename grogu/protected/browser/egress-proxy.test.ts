import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import type { LookupFn } from "../../../src/infra/net/ssrf.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";

const proxies: EgressProxy[] = [];
after(() => Promise.all(proxies.map((proxy) => proxy.close())));

const fixtureLookup = (address: string): LookupFn =>
  (async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as unknown as LookupFn;

async function start(options: Parameters<typeof startEgressProxy>[0] = {}) {
  const proxy = await startEgressProxy(options);
  proxies.push(proxy);
  return proxy;
}

function auth(proxy: EgressProxy) {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
}

function connect(proxy: EgressProxy, authority: string, authorization?: string): Promise<string> {
  const { port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
          authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""
        }\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0] ?? "");
      }
    });
    socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

function get(proxy: EgressProxy, url: string, authorization?: string): Promise<number> {
  const { port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: Number(port),
      path: url,
      headers: authorization ? { "proxy-authorization": authorization } : {},
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

void test("egress proxy requires its per-launch credential", async () => {
  const proxy = await start({ lookupFn: fixtureLookup("93.184.216.34") });
  assert.match(await connect(proxy, "example.test:443"), / 407 /u);
  assert.match(await connect(proxy, "example.test:443", "Basic d3Jvbmc6d3Jvbmc="), / 407 /u);
  assert.equal(await get(proxy, "http://example.test/"), 407);
});

void test("egress proxy refuses private, loopback, metadata and rebinding targets", async () => {
  const proxy = await start();
  for (const authority of ["127.0.0.1:443", "10.0.0.5:443", "169.254.169.254:80", "[::1]:443"]) {
    assert.match(await connect(proxy, authority, auth(proxy)), / 403 /u, authority);
  }
  assert.equal(await get(proxy, "http://169.254.169.254/latest/meta-data/", auth(proxy)), 403);
  const rebinding = await start({ lookupFn: fixtureLookup("127.0.0.1") });
  assert.match(await connect(rebinding, "public.test:443", auth(rebinding)), / 403 /u);
  assert.equal(await get(rebinding, "http://public.test/", auth(rebinding)), 403);
});

void test("egress proxy refuses non-web ports and URL credentials", async () => {
  const proxy = await start({ lookupFn: fixtureLookup("93.184.216.34") });
  assert.match(await connect(proxy, "public.test:22", auth(proxy)), / 403 /u);
  assert.match(await connect(proxy, "public.test:8443", auth(proxy)), / 403 /u);
  assert.equal(await get(proxy, "http://public.test:8080/", auth(proxy)), 403);
  assert.equal(await get(proxy, "http://user:pass@public.test/", auth(proxy)), 403);
});

void test("egress proxy connects allowed hosts only to the pinned address", async () => {
  // Policy admits the synthetic host, so the proxy dials the pinned address
  // instead of refusing; nothing listens there, so the tunnel then closes.
  const proxy = await start({
    policy: { allowPrivateNetwork: true },
    lookupFn: fixtureLookup("127.0.0.1"),
  });
  const status = await connect(proxy, "fixture.test:443", auth(proxy));
  assert.doesNotMatch(status, / 40[37] /u);
});
