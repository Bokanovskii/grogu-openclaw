import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import type { ProtectedPolicyOperation } from "../../src/state/protected-policy-store.js";
import {
  addProtectedSubject,
  bindProtectedAdmission,
  listPendingProtectedPolicy,
  listProtectedAdmissions,
  migrateProtectedSubjects,
  readProtectedAccessRequest,
  removeProtectedAdmission,
  retryProtectedPolicy,
  setProtectedRequestStatus,
  submitProtectedAccessRequest,
} from "./admission-store.js";
import { createProtectedPolicySync, type ProtectedPolicyResult } from "./policy-sync.js";

void test("removing a legacy person closes an open request and cannot re-admit them", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-policy-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://access.example";
  const subject = "legacy-subject";
  const email = "member@example.invalid";
  await migrateProtectedSubjects(stateDir, { issuer, subjects: [subject] });
  assert.equal(
    await bindProtectedAdmission(
      stateDir,
      { issuer, subject, email },
      () => {},
      () => {},
    ),
    true,
  );
  const submitted = await submitProtectedAccessRequest(stateDir, {
    email,
    name: "Synthetic member",
    note: "",
  });
  assert.ok(submitted?.receipt);
  const person = (await listProtectedAdmissions(stateDir))[0];
  assert.ok(person);
  assert.ok(
    await removeProtectedAdmission(
      stateDir,
      { id: person.id, issuer, ownerSubject: "different-owner" },
      () => {},
      () => {},
      () => {},
    ),
  );
  assert.equal((await readProtectedAccessRequest(stateDir, submitted.receipt))?.status, "removed");
  assert.equal(
    await setProtectedRequestStatus(
      stateDir,
      { id: submitted.request.id, status: "approved", issuer },
      () => {},
      () => {},
    ),
    undefined,
  );
  assert.equal(await addProtectedSubject(stateDir, { issuer, subject }), "removed");
});

void test("policy updates serialize and never publish a stale approval", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-policy-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const firstResult = createDeferredCore<ProtectedPolicyResult>();
  const secondResult = createDeferredCore<ProtectedPolicyResult>();
  const firstStarted = createDeferredCore<void>();
  const secondStarted = createDeferredCore<void>();
  const operations: ProtectedPolicyOperation[] = [];
  const controller = createProtectedPolicySync(stateDir, async (operation) => {
    operations.push(operation);
    if (operations.length === 1) {
      firstStarted.resolve();
      return firstResult.promise;
    }
    secondStarted.resolve();
    return secondResult.promise;
  });
  t.after(async () => {
    firstResult.resolve("unknown");
    secondResult.resolve("unknown");
    await controller.stop();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://access.example";
  const ownerSubject = "synthetic-owner";
  const submitted = await submitProtectedAccessRequest(stateDir, {
    email: "member@example.invalid",
    name: "Synthetic member",
    note: "",
  });
  assert.ok(submitted?.receipt);
  assert.ok(
    await setProtectedRequestStatus(
      stateDir,
      { id: submitted.request.id, status: "approved", issuer },
      () => {},
      controller.trigger,
    ),
  );
  await firstStarted.promise;
  const person = (await listProtectedAdmissions(stateDir))[0];
  assert.ok(person);
  assert.equal(controller.isInFlight(person.id), true);
  assert.equal((await listPendingProtectedPolicy(stateDir)).blocked, true);
  assert.equal(
    (await readProtectedAccessRequest(stateDir, submitted.receipt))?.policyState,
    "pending",
  );
  assert.ok(
    await removeProtectedAdmission(
      stateDir,
      { id: person.id, issuer, ownerSubject },
      () => {},
      () => {},
      controller.trigger,
    ),
  );
  firstResult.resolve("synced");
  await secondStarted.promise;
  assert.deepEqual(
    operations.map((operation) => operation.desired),
    ["approved", "removed"],
  );
  const stopped = controller.stop();
  secondResult.resolve("synced");
  await stopped;
  assert.equal((await listProtectedAdmissions(stateDir))[0]?.status, "removed");
  assert.equal((await listProtectedAdmissions(stateDir))[0]?.policyState, "synced");
  assert.deepEqual((await listPendingProtectedPolicy(stateDir)).operations, []);
});

void test("uncertain policy writes block later updates until an owner retries", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-policy-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let controller: ReturnType<typeof createProtectedPolicySync> | undefined;
  t.after(async () => {
    await controller?.stop();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://access.example";
  const started = createDeferredCore<void>();
  controller = createProtectedPolicySync(stateDir, async () => {
    started.resolve();
    return "unknown";
  });
  const submitted = await submitProtectedAccessRequest(stateDir, {
    email: "member@example.invalid",
    name: "Synthetic member",
    note: "",
  });
  assert.ok(submitted);
  await setProtectedRequestStatus(
    stateDir,
    { id: submitted.request.id, status: "approved", issuer },
    () => {},
    controller.trigger,
  );
  await started.promise;
  await controller.stop();
  const blocked = await listPendingProtectedPolicy(stateDir);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.blockedPersonId);
  const retryStarted = createDeferredCore<void>();
  controller = createProtectedPolicySync(stateDir, async () => {
    retryStarted.resolve();
    return "synced";
  });
  assert.equal(
    await retryProtectedPolicy(
      stateDir,
      { id: blocked.blockedPersonId, issuer },
      () => {},
      controller.trigger,
    ),
    true,
  );
  await retryStarted.promise;
  await controller.stop();
  assert.equal((await listPendingProtectedPolicy(stateDir)).blocked, false);
  assert.equal((await listProtectedAdmissions(stateDir))[0]?.policyState, "synced");
});

void test("a crashed policy operation stays blocked across a controller restart", async (t) => {
  const stateDir = path.resolve(".artifacts", `protected-policy-test-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let controller: ReturnType<typeof createProtectedPolicySync> | undefined;
  t.after(async () => {
    await controller?.stop();
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    await rm(stateDir, { recursive: true, force: true });
  });
  const issuer = "https://access.example";
  const started = createDeferredCore<void>();
  controller = createProtectedPolicySync(stateDir, async () => {
    started.resolve();
    throw new Error("Synthetic transport crash");
  });
  const submitted = await submitProtectedAccessRequest(stateDir, {
    email: "member@example.invalid",
    name: "Synthetic member",
    note: "",
  });
  assert.ok(submitted);
  await setProtectedRequestStatus(
    stateDir,
    { id: submitted.request.id, status: "approved", issuer },
    () => {},
    controller.trigger,
  );
  await started.promise;
  await controller.stop();
  const blocked = await listPendingProtectedPolicy(stateDir);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.blockedPersonId);
  const resumed = createDeferredCore<void>();
  controller = createProtectedPolicySync(stateDir, async () => {
    resumed.resolve();
    return "synced";
  });
  controller.trigger();
  await controller.stop();
  assert.equal((await listPendingProtectedPolicy(stateDir)).blocked, true);
  controller = createProtectedPolicySync(stateDir, async () => {
    resumed.resolve();
    return "synced";
  });
  assert.equal(
    await retryProtectedPolicy(
      stateDir,
      { id: blocked.blockedPersonId, issuer },
      () => {},
      controller.trigger,
    ),
    true,
  );
  await resumed.promise;
  await controller.stop();
  assert.equal((await listPendingProtectedPolicy(stateDir)).blocked, false);
});
