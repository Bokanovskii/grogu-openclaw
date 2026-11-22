import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeSessionTranscriptReconcileWorkerPool } from "../../src/config/sessions/session-transcript-reconcile-pool.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { migrateProtectedSubjects } from "./admission-store.js";
import { ProtectedError } from "./errors.js";
import { createProtectedHttp } from "./http.js";

for (const saveDrafts of [false, true]) {
  void test(`removal denies and interrupts the person (${saveDrafts ? "saved drafts" : "legacy store"})`, async (t) => {
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
      directory: {
        issuer,
        get allowedSubjects() {
          return [...allowed];
        },
      },
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
          kind: "human",
          sessionId: `session-${subject}`,
          expiresAt,
          assertCurrent() {},
          async revalidate() {},
        };
      },
      maxChatsPerUser: 3,
      maxFileBytes: 1024,
      ...(saveDrafts
        ? { storageLimits: { globalBytes: 1_000_000, userBytes: 1_000_000, freeFloorBytes: 1 } }
        : {}),
      turns: {
        models: [
          {
            provider: "sparky",
            id: "synthetic",
            label: "Synthetic",
            thinking: { levels: ["low"], default: "low" },
          },
        ],
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
    const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    const retainedIds: string[] = [];
    const retiredIds: string[] = [];
    if (saveDrafts) {
      const save = async (subject: string, name: string) => {
        const response = await call("/automations", "POST", subject, {
          name,
          instructions: "Summarize synthetic test material.",
          whenToNotify: "Only when there is a meaningful update.",
          agentId: "grogu",
          model: { provider: "sparky", id: "synthetic" },
          schedule: { kind: "every", everyMs: 60_000 },
        });
        assert.equal(response.status, 201);
        const { automation } = await response.json();
        assert.equal(automation.state, "paused");
        assert.equal(typeof automation.id, "string");
        const id: string = automation.id;
        return id;
      };
      retiredIds.push(await save(memberSubject, "Member draft one"));
      retiredIds.push(await save(memberSubject, "Member draft two"));
      retainedIds.push(await save(ownerSubject, "Other member draft"));
      const ownerMe = await (await call("/me", "GET", ownerSubject)).json();
      const sharedId = await save(memberSubject, "Shared definition");
      const coOwnedId = await save(memberSubject, "Co-owned definition");
      const boundId = await save(memberSubject, "Bound definition");
      const enabledId = await save(memberSubject, "Enabled definition");
      retainedIds.push(sharedId, coOwnedId, boundId, enabledId);
      // These synthetic rows exercise future storage shapes outside the save-only release.
      const fixture = new DatabaseSync(databasePath);
      try {
        fixture
          .prepare("UPDATE protected_automations SET visibility = 'shared' WHERE id = ?")
          .run(sharedId);
        fixture.prepare("UPDATE protected_automations SET enabled = 1 WHERE id = ?").run(enabledId);
        fixture
          .prepare(
            "INSERT INTO protected_automation_members (automation_id, profile_id, role, added_at) VALUES (?, ?, 'owner', ?)",
          )
          .run(coOwnedId, ownerMe.user.id, Date.now());
        fixture
          .prepare(
            "INSERT INTO protected_automation_job_bindings (job_id, automation_id, central_owner_profile_id, definition_revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
          )
          .run("synthetic-bound-job", boundId, me.user.id, Date.now(), Date.now());
      } finally {
        fixture.close();
      }
    }
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
    if (!saveDrafts) {
      const legacy = new DatabaseSync(databasePath);
      try {
        assert.deepEqual(
          legacy
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('protected_automations', 'protected_automation_members', 'protected_automation_job_bindings')",
            )
            .all(),
          [],
        );
      } finally {
        legacy.close();
      }
    }
    const removal = await call(`/admin/people/${member.id}/remove`, "POST", ownerSubject, {});
    assert.equal(removal.status, 200, await removal.clone().text());
    assert.equal((await removal.json()).policy, "identity_unavailable");
    assert.match(await stream.text(), /"code":"interrupted"/u);
    assert.equal((await call("/me", "GET", memberSubject)).status, 401);
    if (saveDrafts) {
      const stored = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const ids = stored
          .prepare("SELECT id FROM protected_automations ORDER BY id")
          .all()
          .map((row) => row.id);
        assert.deepEqual(ids, retainedIds.toSorted());
        for (const id of retiredIds) {
          assert.equal(
            stored
              .prepare(
                "SELECT automation_id FROM protected_automation_members WHERE automation_id = ?",
              )
              .get(id),
            undefined,
          );
        }
        assert.equal(
          stored.prepare("SELECT job_id FROM protected_automation_job_bindings").get()?.job_id,
          "synthetic-bound-job",
        );
      } finally {
        stored.close();
      }
      const otherList = await call("/automations", "GET", ownerSubject);
      assert.equal(otherList.status, 200);
      assert.deepEqual(
        (await otherList.json()).automations.map((automation: { id: string }) => automation.id),
        [retainedIds[0]],
      );
      assert.equal((await call("/automations", "GET", memberSubject)).status, 401);
    }
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
}
