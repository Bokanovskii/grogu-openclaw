import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../src/state/openclaw-state-worker-store.js";
import {
  addProtectedSubject,
  bindProtectedAdmission,
  editProtectedAccessRequest,
  listProtectedAccessRequests,
  listProtectedAdmissions,
  migrateProtectedSubjects,
  readProtectedAccessRequest,
  submitProtectedAccessRequest,
  setProtectedRequestStatus,
  withdrawProtectedAccessRequest,
} from "./admission-store.js";
import { ProtectedError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import { createProtectedStaticClient } from "./static-client.js";

void test("the public page has a separate static asset tree", async (t) => {
  const bundleDir = path.resolve(".artifacts", `protected-access-bundle-${randomUUID()}`);
  await mkdir(path.join(bundleDir, "request-access", "assets"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(bundleDir, "assets"), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(bundleDir, "index.html"), "Private app"),
    writeFile(path.join(bundleDir, "assets", "index-private.js"), "private"),
    writeFile(path.join(bundleDir, "assets", "privateApp-compiled.js"), "private entry"),
    writeFile(path.join(bundleDir, "assets", "style-shared.js"), "shared module"),
    writeFile(path.join(bundleDir, "assets", "style-compiled.css"), "shared style"),
    writeFile(path.join(bundleDir, "request-access", "index.html"), "Public request"),
    writeFile(path.join(bundleDir, "request-access", "assets", "access-public.js"), "public"),
  ]);
  t.after(() => rm(bundleDir, { recursive: true, force: true }));
  const serve = await createProtectedStaticClient(await root(bundleDir));
  const get = (pathname: string) => serve(new Request(`https://alcove.example${pathname}`));
  assert.equal(await (await get("/request-access"))?.text(), "Public request");
  assert.equal(await (await get("/settings/admin"))?.text(), "Private app");
  for (const [name, content] of [
    ["index-private.js", "private"],
    ["privateApp-compiled.js", "private entry"],
    ["style-shared.js", "shared module"],
    ["style-compiled.css", "shared style"],
  ]) {
    assert.equal(await (await get(`/assets/${name}`))?.text(), content);
  }
  assert.equal(await (await get("/request-access/assets/access-public.js"))?.text(), "public");
  assert.equal(await get("/assets/private.json"), undefined);
  assert.equal(await get("/assets/privateApp.js"), undefined);
  assert.equal(await get("/request-access/index.html"), undefined);
  assert.equal(await get("/request-access/assets/private.json"), undefined);
  assert.equal(await get("/request-access/api/status"), undefined);
});

void test("only the current owner can approve and the owner cannot be removed", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-access-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const issuer = "https://access.example";
  const ownerSubject = "00000000-0000-4000-8000-000000000001";
  const otherSubject = "00000000-0000-4000-8000-000000000002";
  const expiresAt = Date.now() + 60_000;
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [ownerSubject] });
  assert.equal((await listProtectedAdmissions(stateDir))[0]?.email, null);
  assert.equal(
    await migrateProtectedSubjects(stateDir, { issuer, subjects: [ownerSubject, otherSubject] }),
    0,
  );
  assert.equal(await addProtectedSubject(stateDir, { issuer, subject: otherSubject }), "added");
  assert.equal(await addProtectedSubject(stateDir, { issuer, subject: otherSubject }), "existing");
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
        assert.fail("An admin request must not start a model.");
      },
      async steer() {
        assert.fail("An admin request must not steer a model.");
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
  const request = await call("/request-access/api", "POST", otherSubject, {
    email: "owner@example.invalid",
    name: "Synthetic owner",
    note: "",
  });
  assert.equal(request.status, 201);
  const denied = await call("/api/protected/v1/admin/requests", "GET", otherSubject);
  assert.equal(denied.status, 403);
  const requests = await call("/api/protected/v1/admin/requests", "GET", ownerSubject);
  assert.equal(requests.status, 200);
  const { requests: rows } = await requests.json();
  assert.equal(rows.length, 1);
  const approve = await call(
    `/api/protected/v1/admin/requests/${rows[0].id}/approve`,
    "POST",
    ownerSubject,
  );
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).policy, "sync_pending");
  assert.equal(
    await bindProtectedAdmission(
      stateDir,
      {
        issuer,
        email: "owner@example.invalid",
        subject: ownerSubject,
      },
      () => {},
      () => {},
    ),
    true,
  );
  const people = await call("/api/protected/v1/admin/people", "GET", ownerSubject);
  const { people: admitted } = await people.json();
  const owner = admitted.find((person: { subject?: string }) => person.subject === ownerSubject);
  assert.ok(owner);
  assert.equal(owner.email, "owner@example.invalid");
  const removeOwner = await call(
    `/api/protected/v1/admin/people/${owner.id}/remove`,
    "POST",
    ownerSubject,
  );
  assert.equal(removeOwner.status, 403);
  const after = await call("/api/protected/v1/admin/requests", "GET", ownerSubject);
  assert.equal((await after.json()).requests[0].status, "approved");
});

void test("public requests hide duplicates and require their receipt", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-access-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const app = createProtectedHttp({
    origin: "https://alcove.example",
    accessIssuer: "https://access.example",
    directory: { issuer: "https://access.example", allowedSubjects: [] },
    stateDir,
    usersRoot: await root(usersDir),
    verifyIdentity: async () => {
      throw new ProtectedError(401, "unauthorized", "Sign in.");
    },
    maxChatsPerUser: 3,
    maxFileBytes: 1024,
    turns: {
      models: [],
      async run() {
        assert.fail("A public request must not start a model.");
      },
      async steer() {
        assert.fail("A public request must not steer a model.");
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
  let publicCalls = 0;
  const call = (
    pathname: string,
    method: "GET" | "POST",
    data?: object,
    cookie?: string,
    source?: string,
  ) => {
    if (pathname === "/request-access/api" || pathname.startsWith("/request-access/api/")) {
      publicCalls++;
    }
    return app.fetch(
      new Request(`https://alcove.example${pathname}`, {
        method,
        headers: {
          origin: "https://alcove.example",
          ...(data ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
          ...(source ? { "cf-connecting-ip": source } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
    );
  };
  const input = {
    email: "applicant@example.invalid",
    name: "Synthetic applicant",
    note: "Original note",
  };
  const first = await call("/request-access/api", "POST", input);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { accepted: true });
  const setCookie = first.headers.get("set-cookie");
  assert.match(setCookie ?? "", /HttpOnly; Secure; SameSite=Strict/u);
  const cookie = (setCookie ?? "").split(";")[0]!;
  const duplicate = await call("/request-access/api", "POST", {
    ...input,
    name: "Different name",
    note: "Different note",
  });
  assert.equal(duplicate.status, 201);
  assert.deepEqual(await duplicate.json(), { accepted: true });
  const duplicateCookie = (duplicate.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.match(duplicateCookie, /^protected_access_receipt=[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(duplicateCookie, cookie);
  assert.deepEqual(
    await (await call("/request-access/api/status", "GET", undefined, duplicateCookie)).json(),
    { request: null },
  );
  const repeated = await call("/request-access/api", "POST", input, cookie);
  assert.equal((repeated.headers.get("set-cookie") ?? "").split(";")[0], cookie);
  const status = await call("/request-access/api/status", "GET", undefined, cookie);
  assert.equal(status.status, 200);
  const result = await status.json();
  assert.equal(result.request.name, input.name);
  assert.equal(result.request.note, input.note);
  assert.deepEqual(await (await call("/request-access/api/status", "GET")).json(), {
    request: null,
  });
  for (let count = 0; count < 10; count++) {
    const edit = await call(
      "/request-access/api/edit",
      "POST",
      { name: input.name, note: `Edit ${count}` },
      cookie,
    );
    assert.equal(edit.status, 200);
  }
  const limitedEdit = await call(
    "/request-access/api/edit",
    "POST",
    { name: input.name, note: "One edit too many" },
    cookie,
  );
  assert.equal(limitedEdit.status, 429);
  const withdrawn = await call("/request-access/api/withdraw", "POST", undefined, cookie);
  assert.equal(withdrawn.status, 204);
  const after = await call("/request-access/api/status", "GET", undefined, cookie);
  assert.equal((await after.json()).request.status, "withdrawn");
  const oldPath = await call("/api/protected/v1/request-access", "POST", input);
  assert.equal(oldPath.status, 401);
  for (let count = 0; count < 10; count++) {
    const response = await call("/request-access/api", "POST", input, undefined, "2001:db8::1");
    assert.equal(response.status, 201);
  }
  const limited = await call(
    "/request-access/api",
    "POST",
    input,
    undefined,
    "2001:0db8:0:0:0:0:0:1",
  );
  assert.equal(limited.status, 429);
  const otherSource = await call("/request-access/api", "POST", input, undefined, "2001:db8::2");
  assert.equal(otherSource.status, 201);
  for (let count = 0; count < 7; count++) {
    const response = await call(
      "/request-access/api",
      "POST",
      input,
      undefined,
      "203.0.113.1, 203.0.113.2",
    );
    assert.equal(response.status, 201);
  }
  const ambiguous = await call(
    "/request-access/api",
    "POST",
    input,
    undefined,
    "203.0.113.3, 203.0.113.4",
  );
  assert.equal(ambiguous.status, 429);
  for (let count = 0; count < 60; count++) {
    const response = await call(
      "/request-access/api/status",
      "GET",
      undefined,
      undefined,
      "198.51.100.1",
    );
    assert.equal(response.status, 200);
  }
  assert.equal(
    (await call("/request-access/api/status", "GET", undefined, undefined, "198.51.100.1")).status,
    429,
  );
  const remaining = 600 - publicCalls;
  for (let index = 0; index < remaining; index++) {
    const response = await call(
      "/request-access/api/status",
      "GET",
      undefined,
      undefined,
      `192.0.2.${Math.floor(index / 50) + 1}`,
    );
    assert.equal(response.status, 200);
  }
  assert.equal(
    (await call("/request-access/api/status", "GET", undefined, undefined, "198.51.100.2")).status,
    429,
  );
});

void test("the open-request bound rejects new and duplicate submissions alike", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-access-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  let firstId = "";
  for (let index = 0; index < 50; index++) {
    const request = await submitProtectedAccessRequest(stateDir, {
      email: `member${index}@example.invalid`,
      name: "Synthetic",
      note: "",
    });
    assert.ok(request);
    firstId ||= request.request.id;
  }
  for (const email of ["member0@example.invalid", "new@example.invalid"]) {
    assert.equal(
      await submitProtectedAccessRequest(stateDir, { email, name: "Synthetic", note: "" }),
      undefined,
    );
  }
  assert.ok(
    await setProtectedRequestStatus(
      stateDir,
      { id: firstId, status: "denied", issuer: "https://access.example" },
      () => {},
      () => {},
    ),
  );
  assert.ok(
    await submitProtectedAccessRequest(stateDir, {
      email: "new@example.invalid",
      name: "Synthetic",
      note: "",
    }),
  );
  assert.ok(
    (await listProtectedAccessRequests(stateDir)).some((request) => request.id === firstId),
  );
});

void test("expired receipts cannot change access or hide an approval from the owner", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-access-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://access.example";
  const email = "expired@example.invalid";
  const submitted = await executeOpenClawStateWorker(
    captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    {
      type: "protectedAccess.submit",
      input: {
        email,
        name: "Synthetic",
        note: "",
        now: Date.now() - 365 * 24 * 60 * 60_000 - 1000,
      },
    },
  );
  assert.ok(submitted);
  assert.equal(await readProtectedAccessRequest(stateDir, submitted.receipt), undefined);
  assert.equal(
    await editProtectedAccessRequest(stateDir, {
      receipt: submitted.receipt,
      name: "Changed",
      note: "",
    }),
    undefined,
  );
  assert.equal(await withdrawProtectedAccessRequest(stateDir, submitted.receipt), false);
  assert.ok(
    await setProtectedRequestStatus(
      stateDir,
      { id: submitted.request.id, status: "approved", issuer },
      () => {},
      () => {},
    ),
  );
  assert.equal((await listProtectedAccessRequests(stateDir))[0]?.status, "approved");
  assert.equal(
    await bindProtectedAdmission(
      stateDir,
      { issuer, email, subject: "synthetic-approved-subject" },
      () => {},
      () => {},
    ),
    true,
  );
});
