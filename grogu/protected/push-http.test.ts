import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { mock, test } from "node:test";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { migrateProtectedSubjects } from "./admission-store.js";

void test("only the owner can subscribe and a new request sends one private notification", async (t) => {
  const sendNotification = mock.fn(async (_subscription: unknown, _payload: string) => ({
    statusCode: 201,
  }));
  const mocked = mock.module("web-push", {
    defaultExport: {
      generateVAPIDKeys: () => ({ publicKey: "synthetic-public", privateKey: "synthetic-private" }),
      setVapidDetails() {},
      sendNotification,
    },
  });
  t.after(() => mocked.restore());
  const { createProtectedHttp } = await import("./http.js");
  const stateDir = path.resolve(".artifacts", `protected-push-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const issuer = "https://access.example";
  const ownerSubject = "00000000-0000-4000-8000-000000000001";
  const otherSubject = "00000000-0000-4000-8000-000000000002";
  const expiresAt = Date.now() + 60_000;
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [ownerSubject, otherSubject] });
  const app = createProtectedHttp({
    origin: "https://alcove.example",
    accessIssuer: issuer,
    directory: { issuer, allowedSubjects: [ownerSubject, otherSubject] },
    ownerSubject,
    stateDir,
    usersRoot: await root(usersDir),
    verifyIdentity: async (request) => ({
      issuer,
      kind: "human",
      subject: request.headers.get("x-test-subject") ?? otherSubject,
      sessionId: `session-${request.headers.get("x-test-subject") ?? otherSubject}`,
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    }),
    maxChatsPerUser: 3,
    maxFileBytes: 1024,
    turns: {
      models: [],
      async run() {
        assert.fail("A push request must not start a model.");
      },
      async steer() {
        assert.fail("A push request must not steer a model.");
      },
    },
  });
  t.after(async () => {
    await app.shutdown();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const call = (pathname: string, method: "GET" | "POST", subject: string, data?: object) =>
    app.fetch(
      new Request(`https://alcove.example${pathname}`, {
        method,
        headers: {
          origin: "https://alcove.example",
          "x-test-subject": subject,
          ...(data ? { "content-type": "application/json" } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
    );
  const subscription = {
    endpoint: "https://push.example.invalid/device",
    keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
  };
  assert.equal(
    (await call("/api/protected/v1/admin/push/subscribe", "POST", otherSubject, subscription))
      .status,
    403,
  );
  assert.equal(
    (await call("/api/protected/v1/admin/push/subscribe", "POST", ownerSubject, subscription))
      .status,
    200,
  );
  const request = {
    email: "applicant@example.invalid",
    name: "Synthetic applicant",
    note: "Private synthetic note",
  };
  assert.equal((await call("/request-access/api", "POST", otherSubject, request)).status, 201);
  assert.equal((await call("/request-access/api", "POST", otherSubject, request)).status, 201);
  await app.shutdown();
  assert.equal(sendNotification.mock.callCount(), 1);
  const payload = JSON.parse(String(sendNotification.mock.calls[0]?.arguments[1]));
  assert.deepEqual(payload, {
    title: "Alcove",
    body: "A request needs review.",
    tag: "access-request",
    url: "/settings/admin",
  });
});
