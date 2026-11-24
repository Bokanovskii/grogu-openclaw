import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendTranscriptMessage } from "../../src/config/sessions/session-accessor.js";
import { root } from "../../src/infra/fs-safe.js";
import { ProtectedError } from "./errors.js";
import { createProtectedHttp } from "./http.js";
import type { ProtectedTurn } from "./turns.js";

void test("protected chunks publish without remote access work and stop at local invalidation", async (t) => {
  // No canonical model runner or provider fixture is loaded by this HTTP boundary proof.
  t.mock.method(globalThis, "fetch", () => assert.fail("Network is forbidden in this proof."));
  const stateDir = path.resolve(".artifacts", `protected-streaming-${randomUUID()}`);
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const usersDir = path.join(stateDir, "users");
  await mkdir(usersDir, { recursive: true, mode: 0o700 });
  // The protected service refuses to start without its storage key, which must sit outside the state.
  const keyFile = `${stateDir}.protected-storage-key`;
  const priorKeyFile = process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
  await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyFile;
  const origin = "https://synthetic.example";
  let run: (turn: ProtectedTurn) => Promise<void> = async () => {};
  let remoteChecks = 0;
  let accessElapsedMs = 0;
  let validateRun: (() => Promise<void>) | undefined;
  let releaseHeld = () => {};
  const expiresAt = Date.now() + 120_000;
  const expired = new Set<string>();
  const deniedRemotely = new Set<string>();
  const timingLogs: string[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => {
    if (args[0] === "[protected-turn-timing]") {
      assert.equal(typeof args[1], "string");
      timingLogs.push(String(args[1]));
    }
  });
  const app = createProtectedHttp({
    origin,
    accessIssuer: origin,
    stateDir,
    directory: { issuer: origin, allowedSubjects: [] },
    usersRoot: await root(usersDir),
    maxChatsPerUser: 10,
    maxFileBytes: 64_000,
    verifyIdentity: async (request) => {
      const subject = request.headers.get("cookie")!;
      return {
        issuer: origin,
        subject,
        kind: "human",
        expiresAt,
        sessionId: createHash("sha256").update(subject).digest("hex"),
        assertCurrent() {
          if (expired.has(subject)) {
            throw new ProtectedError(401, "unauthorized", "Synthetic expiry.");
          }
        },
        async revalidate() {
          remoteChecks++;
          // Controlled 100ms identity latency, without a real sleep or provider request.
          accessElapsedMs += 100;
          if (deniedRemotely.has(subject)) {
            throw new ProtectedError(401, "unauthorized", "Synthetic remote revocation.");
          }
          if (new URL(request.url).pathname.endsWith("/turns")) {
            await validateRun?.();
          }
        },
      };
    },
    turns: {
      models: [{ provider: "sparky", id: "synthetic", label: "Synthetic" }],
      run: (turn) => run(turn),
      async steer() {
        assert.fail("No steering is needed.");
      },
    },
  });
  t.after(async () => {
    releaseHeld();
    await app.shutdown();
    await rm(stateDir, { recursive: true, force: true });
    await rm(keyFile, { force: true });
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    if (priorKeyFile === undefined) {
      delete process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE;
    } else {
      process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = priorKeyFile;
    }
  });
  const call = (subject: string, route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", subject);
    headers.set("content-type", "application/json");
    return app.fetch(
      new Request(`${origin}/api/protected/v1${route}`, {
        ...init,
        headers,
      }),
    );
  };
  const setup = async (subject: string) => {
    const me = await (await call(subject, "/me")).json();
    const created = await call(subject, "/chats", { method: "POST", body: "{}" });
    assert.equal(created.status, 200);
    const { chat } = await created.json();
    return { profileId: me.user.id as string, route: `/chats/${chat.id}` };
  };
  const start = (subject: string, profileId: string, route: string) =>
    call(subject, `${route}/turns`, {
      method: "POST",
      headers: { "x-grogu-profile": profileId },
      body: '{"provider":"sparky","model":"synthetic","text":"synthetic prompt"}',
    });

  const smooth = await setup("smooth");
  let streamingChecks = 0;
  let streamingAccessMs = 0;
  let streamingWallMs = 0;
  run = async (turn) => {
    await turn.revalidate();
    turn.markStep("runnerStarting");
    turn.markTiming("providerRequestStartMs");
    turn.markTiming("firstProviderOutputMs");
    const before = remoteChecks;
    const beforeMs = accessElapsedMs;
    const beforeTime = performance.now();
    for (let i = 0; i < 12; i++) {
      await turn.delta(`chunk-${i}`);
      await turn.reasoning(`reason-${i}`);
      await turn.activity({
        id: `activity-${i}`,
        kind: "fetch",
        label: `Synthetic source ${i}`,
        status: "done",
      });
      await turn.widgetDraft({
        type: "widget-draft",
        id: "draft",
        title: "Synthetic",
        receivedChars: 0,
      });
    }
    streamingChecks = remoteChecks - before;
    streamingAccessMs = accessElapsedMs - beforeMs;
    streamingWallMs = performance.now() - beforeTime;
    for (const message of [
      { role: "user", content: turn.input.text },
      {
        role: "assistant",
        content: Array.from({ length: 12 }, (_, i) => `chunk-${i}`).join(""),
        stopReason: "stop",
      },
    ]) {
      turn.assertCurrent();
      await appendTranscriptMessage(
        { ...turn.target, sessionId: turn.id, env: { OPENCLAW_STATE_DIR: stateDir } },
        { message },
      );
    }
  };
  const response = await start("smooth", smooth.profileId, smooth.route);
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.equal(stream.match(/"type":"delta"/gu)?.length, 12);
  assert.equal(stream.match(/"type":"reasoning"/gu)?.length, 12);
  assert.equal(stream.match(/"type":"activity"/gu)?.length, 12);
  assert.equal(stream.match(/"type":"widget-draft"/gu)?.length, 12);
  assert.match(stream, /"type":"done"/u);
  assert.doesNotMatch(stream, /"type":"error"/u);
  const saved = await (await call("smooth", smooth.route)).json();
  assert.equal(saved.chat.messages.at(-1)?.status, "complete");
  assert.equal(timingLogs.length, 1);
  const timing: unknown = JSON.parse(timingLogs[0]!);
  assert.ok(isRecord(timing));
  assert.deepEqual(
    Object.keys(timing).toSorted(),
    [
      "admissionMs",
      "providerRequestStartMs",
      "firstProviderOutputMs",
      "firstClientVisibleOutputMs",
      "completionMs",
      "accessChecks",
      "accessValidationMs",
      "outcome",
      "turnOrdinal",
      "finishedAtSec",
      "activeTurns",
      "marks",
    ].toSorted(),
  );
  assert.equal(timing.outcome, "complete");
  assert.ok(Number.isInteger(timing.turnOrdinal) && Number(timing.turnOrdinal) >= 1);
  assert.equal(timing.activeTurns, 1);
  assert.ok(Math.abs(Number(timing.finishedAtSec) - Date.now() / 1000) < 60);
  const marks: unknown = timing.marks;
  assert.ok(isRecord(marks));
  // Every step is recorded once, in the order the request reached it.
  assert.deepEqual(Object.keys(marks), [
    "identityVerified",
    "memberResolved",
    "accessAdmitted",
    "accessBound",
    "chatEntryRead",
    "routeGrantChecked",
    "bodyParsed",
    "turnGrantChecked",
    "aliasesPrepared",
    "storageAdmitted",
    "turnEntryRead",
    "admissionGrantChecked",
    "historyRead",
    "artifactsListed",
    "runnerStarting",
    "resultRead",
  ]);
  let reached = 0;
  for (const value of Object.values(marks)) {
    assert.ok(typeof value === "number" && value >= reached);
    reached = value;
  }
  let previous = 0;
  for (const phase of [
    "admissionMs",
    "providerRequestStartMs",
    "firstProviderOutputMs",
    "firstClientVisibleOutputMs",
    "completionMs",
  ]) {
    const value: unknown = timing[phase];
    assert.equal(typeof value, "number");
    assert.ok(typeof value === "number" && value >= previous);
    // Admission measures pre-run work; the remaining phases start after admission.
    previous = phase === "admissionMs" ? 0 : value;
  }
  t.diagnostic(
    JSON.stringify({
      streamingChecks,
      streamingAccessMs,
      streamingWallMs: Math.round(streamingWallMs * 100) / 100,
      chunks: 48,
      remoteFixtureMs: 100,
    }),
  );
  for (const kind of ["expiry", "logout", "revoke", "stop"] as const) {
    const subject = `synthetic-${kind}`;
    const { profileId, route } = await setup(subject);
    const started = Promise.withResolvers<ProtectedTurn>();
    const release = Promise.withResolvers<void>();
    releaseHeld = release.resolve;
    const childRunId = randomUUID();
    run = async (turn) => {
      turn.childEvent({ type: "child-start", runId: childRunId, agentId: "travel" });
      await turn.delta("before-invalidation");
      started.resolve(turn);
      await release.promise;
      if (kind === "expiry") {
        await turn.reasoning("forbidden-after-invalidation");
      } else if (kind === "logout") {
        await turn.activity({
          id: "forbidden",
          kind: "fetch",
          label: "forbidden-after-invalidation",
          status: "done",
        });
      }
      await turn.delta("forbidden-after-invalidation");
      await turn.widgetDraft({
        type: "widget-draft",
        id: "forbidden",
        title: "Forbidden",
        receivedChars: 0,
      });
    };
    const active = await start(subject, profileId, route);
    const turn = await started.promise;
    if (kind === "expiry") {
      expired.add(subject);
    } else if (kind === "revoke") {
      assert.equal(await app.revokeProfile(profileId), true);
    } else {
      const result = await call(
        subject,
        kind === "logout" ? "/logout" : `${route}/runs/${turn.runId}/stop`,
        { method: "POST" },
      );
      assert.equal(result.status, kind === "logout" ? 204 : 200);
    }
    release.resolve();
    const tail = await active.text();
    assert.match(tail, /before-invalidation/u);
    assert.doesNotMatch(tail, /forbidden-after-invalidation|"id":"forbidden"|"type":"done"/u);
    assert.match(tail, /"type":"error"/u);
    if (kind === "stop") {
      const stoppedChat = await (
        await call(subject, route, {
          headers: { "x-alcove-capabilities": "specialist-stream-v1" },
        })
      ).json();
      const reply = stoppedChat.chat.messages.at(-1);
      assert.equal(reply?.agentId, "travel");
      assert.equal(reply.runId, childRunId);
      assert.equal(reply.status, "failed");
      assert.match(reply.text, /did not finish/u);
    }
  }

  const coalesced = await setup("coalesced");
  run = async (turn) => {
    const remote = Promise.withResolvers<void>();
    releaseHeld = remote.resolve;
    validateRun = () => remote.promise;
    const before = remoteChecks;
    const first = turn.revalidate();
    const second = turn.revalidate();
    try {
      assert.equal(remoteChecks - before, 1, "Concurrent lifecycle checks share remote work.");
      await turn.delta("published-during-validation");
    } finally {
      remote.resolve();
      await Promise.all([first, second]);
      validateRun = undefined;
    }
  };
  const coalescedReply = await start("coalesced", coalesced.profileId, coalesced.route);
  assert.match(await coalescedReply.text(), /published-during-validation/u);

  const remoteRevoked = await setup("remote-revoked");
  const remoteStarted = Promise.withResolvers<ProtectedTurn>();
  const remoteRelease = Promise.withResolvers<void>();
  releaseHeld = remoteRelease.resolve;
  run = async (turn) => {
    await turn.delta("before-remote-revocation");
    remoteStarted.resolve(turn);
    await remoteRelease.promise;
    await turn.delta("forbidden-after-remote-revocation");
  };
  t.mock.timers.enable({ apis: ["setInterval"] });
  const remoteReply = await start("remote-revoked", remoteRevoked.profileId, remoteRevoked.route);
  const remoteTurn = await remoteStarted.promise;
  const aborted = Promise.withResolvers<void>();
  remoteTurn.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
  deniedRemotely.add("remote-revoked");
  t.mock.timers.tick(5000);
  await aborted.promise;
  remoteRelease.resolve();
  const remoteTail = await remoteReply.text();
  assert.match(remoteTail, /before-remote-revocation/u);
  assert.doesNotMatch(remoteTail, /forbidden-after-remote-revocation|"type":"done"/u);
  assert.match(remoteTail, /"code":"interrupted"/u);
  t.mock.timers.reset();

  assert.doesNotMatch(
    timingLogs.join(""),
    /synthetic|smooth|chunk-|draft|authorization|subject|profile|session|credential/iu,
  );
  assert.equal(streamingChecks, 0, "Chunks must not trigger identity requests or SQLite checks.");
});
