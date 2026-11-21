import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Transport only: the origin is configured, never selected by forwarded headers. */
export function createProtectedServer(
  origin: string,
  handle: (request: Request) => Promise<Response>,
  staticClient?: (request: Request) => Promise<Response | undefined>,
) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (incoming, outgoing) => {
    const lifetime = new AbortController();
    outgoing.once("close", () => lifetime.abort());
    void (async () => {
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        outgoing.writeHead(400, { "cache-control": "no-store" }).end();
        return;
      }

      const method = incoming.method ?? "GET";
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(`${origin}${incoming.url}`, {
        method,
        headers,
        signal: lifetime.signal,
        ...(hasBody
          ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }
          : {}),
      });
      const response = (await staticClient?.(request)) ?? (await handle(request));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      await pipeline(Readable.from(response.body), outgoing);
    })().catch(() => {
      if (outgoing.headersSent) {
        outgoing.destroy();
      } else {
        outgoing.writeHead(500, {
          "cache-control": "no-store",
          "content-type": "application/json",
        });
        outgoing.end('{"error":{"code":"operation_failed","message":"The operation failed."}}');
      }
    });
  });
}

export async function closeProtectedServer(
  server: ReturnType<typeof createProtectedServer>,
  app: { shutdown: () => Promise<void> },
  stateDir: string,
) {
  const draining = app.shutdown();
  const listenerClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([listenerClosed, draining]);
  const { closePreparedModelRuntimeSnapshots } =
    await import("../../src/agents/prepared-model-runtime.lifecycle.js");
  const { closeSessionTranscriptReconcileWorkerPool } =
    await import("../../src/config/sessions/session-transcript-reconcile-pool.js");
  const { closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db-lifecycle.js");
  const { closeSkillsWatchers } = await import("../../src/skills/runtime/refresh.js");
  const { closeOpenClawStateDatabaseByPathAsync } =
    await import("../../src/state/openclaw-state-db-cache.js");
  const { resolveOpenClawStateSqlitePath } =
    await import("../../src/state/openclaw-state-db.paths.js");
  await closeSkillsWatchers();
  // Shared state still owns the lease releases from the agent database workers.
  await closePreparedModelRuntimeSnapshots();
  await closeSessionTranscriptReconcileWorkerPool();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseByPathAsync(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
  );
}
