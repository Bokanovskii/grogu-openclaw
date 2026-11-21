import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { closeSessionTranscriptReconcileWorkerPool } from "../../src/config/sessions/session-transcript-reconcile-pool.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { migrateProtectedSubjects } from "./admission-store.js";
import { ProtectedError } from "./errors.js";
import { createProtectedHttp } from "./http.js";

void test("removal immediately denies the person and interrupts their active turn", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-revocation-test-${randomUUID()}`);
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  const issuer = "https://access.example";
  const ownerSubject = "00000000-0000-4000-8000-000000000001";
  const memberSubject = "00000000-0000-4000-8000-000000000002";
  const allowed = new Set([ownerSubject, memberSubject]);
  const expiresAt = Date.now() + 60_000;
  const started = Promise.withResolvers<void>();
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [...allowed] });
  const app = createProtectedHttp({
    origin: "https://alcove.example",
    accessIssuer: issuer,
    ownerSubject,
    onRemoveSubject: (subject) => allowed.delete(subject),
    stateDir,
    usersRoot: await root(usersDir),
    verifyIdentity: async (request) => {
      const subject = request.headers.get("x-test-subject") ?? "";
      if (!allowed.has(subject)) {
        throw new ProtectedError(401, "unauthorized", "Sign in.");
      }
      return {
        issuer,
        subject,
        sessionId: `session-${subject}`,
        expiresAt,
        assertCurrent() {},
        async revalidate() {},
      };
    },
    maxChatsPerUser: 3,
    maxFileBytes: 1024,
    turns: {
      models: [{ provider: "sparky", id: "synthetic", label: "Synthetic" }],
      async run(turn) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          turn.signal.addEventListener("abort", () => reject(new Error("synthetic stop")), {
            once: true,
          });
        });
      },
      async steer() {
        assert.fail("A removed person's turn cannot be steered.");
      },
    },
  });
  t.after(async () => {
    await app.shutdown();
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const call = (
    pathname: string,
    method: "GET" | "POST",
    subject: string,
    data?: object,
    profileId?: string,
  ) =>
    app.fetch(
      new Request(`https://alcove.example/api/protected/v1${pathname}`, {
        method,
        headers: {
          origin: "https://alcove.example",
          "x-test-subject": subject,
          ...(profileId ? { "x-grogu-profile": profileId } : {}),
          ...(data ? { "content-type": "application/json" } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
    );
  const activeSince = Date.now();
  const me = await (await call("/me", "GET", memberSubject)).json();
  const initialPeople = await (await call("/admin/people", "GET", ownerSubject)).json();
  const initialMember = initialPeople.people.find(
    (person: { subject?: string }) => person.subject === memberSubject,
  );
  assert.ok(initialMember);
  assert.ok(initialMember.lastActiveAt >= activeSince);
  assert.ok(initialMember.lastActiveAt <= Date.now());
  const created = await (await call("/chats", "POST", memberSubject, {})).json();
  const stream = await call(
    `/chats/${created.chat.id}/turns`,
    "POST",
    memberSubject,
    { text: "Synthetic turn", provider: "sparky", model: "synthetic" },
    me.user.id,
  );
  assert.equal(stream.status, 200);
  await started.promise;
  const { people } = await (await call("/admin/people", "GET", ownerSubject)).json();
  const member = people.find((person: { subject?: string }) => person.subject === memberSubject);
  assert.ok(member);
  const lastActiveAt = member.lastActiveAt;
  const removal = await call(`/admin/people/${member.id}/remove`, "POST", ownerSubject, {});
  assert.equal(removal.status, 200);
  assert.equal((await removal.json()).policy, "identity_unavailable");
  assert.match(await stream.text(), /"code":"interrupted"/u);
  assert.equal((await call("/me", "GET", memberSubject)).status, 401);
  const usageResponse = await call(`/admin/people/${member.id}/usage`, "GET", ownerSubject);
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.chatCount, 1);
  assert.equal(usage.lastActiveAt, lastActiveAt);
  assert.equal(usage.daily[0]?.errors, 1);
  assert.equal(usage.daily[0]?.missingUsage, 1);
  assert.equal(usage.daily[0]?.missingMessages, 1);
  assert.doesNotMatch(JSON.stringify(usage), /Synthetic turn/u);
});
