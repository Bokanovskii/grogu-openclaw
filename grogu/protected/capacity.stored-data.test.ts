import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { root } from "../../src/infra/fs-safe.js";
import { createStorageAdmission } from "./capacity.js";
import type { StoredDataEntry } from "./storage-entry-quota.js";

async function createFixture(
  t: TestContext,
  limit: number,
  storedDataUsage: () => Promise<readonly StoredDataEntry[]> = async () => [],
  userLimit = limit,
) {
  const stateDir = path.resolve(".artifacts", `protected-stored-quota-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return createStorageAdmission({
    stateDir,
    usersRoot: await root(stateDir),
    maxFileBytes: 1024,
    limits: { globalBytes: limit, userBytes: userLimit, freeFloorBytes: 1 },
    chats: {
      async capacityEntries() {
        return [];
      },
      async transcriptBytes() {
        return 0;
      },
    },
    storedDataUsage,
  });
}

void test("result storage charges its owner once and retains replay metadata after cleanup", async (t) => {
  const measured = { id: "run:old", profileId: "owner", bytes: 10_000 };
  const created = { id: "run:new", profileId: "owner", bytes: 8192 };
  const inbox = { id: "inbox:new", profileId: "owner", bytes: 4096 };
  const marker = { ...measured, bytes: 4096 };
  const newMarker = { ...created, bytes: 4096 };
  const admission = await createFixture(
    t,
    16_384 + 10_000 + 12_288,
    async () => [measured],
    22_288,
  );
  const turn = await admission("active", () => {}, "turn");
  try {
    const result = await admission.reserveStoredData("owner", () => {}, 12_288);
    result.settle({ created: true, entries: [created, inbox] });
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 1),
      {
        code: "quota_exceeded",
      },
    );

    const changes = [
      { removed: measured, retained: marker },
      { removed: created, retained: newMarker },
      { removed: inbox },
    ];
    admission.retiredStoredData(changes);
    admission.retiredStoredData(changes);
    const available = await admission.reserveStoredData("owner", () => {}, 14_096);
    available.release();
    available.release();
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 14_097),
      {
        code: "quota_exceeded",
      },
    );
  } finally {
    turn.release();
  }
});

void test("retirement before a result receipt keeps uncertain bytes charged until settlement", async (t) => {
  const created = { id: "run:pending", profileId: "owner", bytes: 8192 };
  const marker = { ...created, bytes: 4096 };
  const admission = await createFixture(t, 16_384 + 8192);
  const turn = await admission("active", () => {}, "turn");
  try {
    const result = await admission.reserveStoredData("owner", () => {}, 8192);
    admission.retiredStoredData([{ removed: created, retained: marker }]);
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 1),
      {
        code: "quota_exceeded",
      },
    );
    result.settle({ created: true, entries: [created] });
    const reduced = await admission.reserveStoredData("owner", () => {}, 4096);
    reduced.release();
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 4097),
      {
        code: "quota_exceeded",
      },
    );

    admission.retiredStoredData([{ removed: marker }]);
    admission.retiredStoredData([{ removed: created, retained: marker }]);
    const fullyRetired = await admission.reserveStoredData("owner", () => {}, 8192);
    fullyRetired.release();
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 8193),
      {
        code: "quota_exceeded",
      },
    );
  } finally {
    turn.release();
  }
});

void test("result retirement during measurement reconciles a stale snapshot without absent credits", async (t) => {
  const measured = { id: "run:old", profileId: "owner", bytes: 8192 };
  const marker = { ...measured, bytes: 4096 };
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const admission = await createFixture(t, 16_384 + 8192, async () => {
    started.resolve();
    await finish.promise;
    return [measured];
  });
  const pendingTurn = admission("active", () => {}, "turn");
  await started.promise;
  admission.retiredStoredData([{ removed: measured, retained: marker }]);
  admission.retiredStoredData([
    { removed: marker },
    { removed: { ...measured, id: "run:absent", bytes: 100_000 } },
  ]);
  admission.retiredStoredData([{ removed: measured, retained: marker }]);
  finish.resolve();
  const turn = await pendingTurn;
  try {
    const available = await admission.reserveStoredData("owner", () => {}, 8192);
    available.release();
    await assert.rejects(
      admission.reserveStoredData("owner", () => {}, 8193),
      {
        code: "quota_exceeded",
      },
    );
  } finally {
    turn.release();
  }
});

void test("committed ownership transfer preserves global usage and keeps an over-quota successor's data", async (t) => {
  const previous = { id: "run:transferred", profileId: "departing", bytes: 8192 };
  const current = { ...previous, profileId: "successor" };
  const existing = { id: "run:existing", profileId: "successor", bytes: 8192 };
  let entries = [previous, existing];
  const admission = await createFixture(t, 24_576, async () => entries, 8192);
  const holder = await admission("holder", () => {}, "stored-data");
  try {
    entries = [current, existing];
    admission.transferredStoredData([{ previous, current }]);
    admission.transferredStoredData([{ previous, current }]);
    admission.retiredStoredData([{ removed: previous }]);

    const available = await admission.reserveStoredData("departing", () => {}, 8192);
    await assert.rejects(
      admission.reserveStoredData("other", () => {}, 1),
      {
        code: "quota_exceeded",
      },
    );
    available.release();
    await assert.rejects(
      admission.reserveStoredData("successor", () => {}, 1),
      {
        code: "quota_exceeded",
      },
    );
  } finally {
    holder.release();
  }
});

void test("ownership transfer reconciles both sides of a measurement race and later retirement", async (t) => {
  const previous = { id: "run:transferred", profileId: "departing", bytes: 8192 };
  const current = { ...previous, profileId: "successor" };
  for (const snapshot of [previous, current]) {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const admission = await createFixture(
      t,
      16_384,
      async () => {
        started.resolve();
        await finish.promise;
        return [snapshot];
      },
      8192,
    );
    const pendingHolder = admission("holder", () => {}, "stored-data");
    await started.promise;
    admission.transferredStoredData([{ previous, current }]);
    admission.retiredStoredData([{ removed: current, retained: { ...current, bytes: 4096 } }]);
    finish.resolve();
    const holder = await pendingHolder;
    try {
      const available = await admission.reserveStoredData("departing", () => {}, 8192);
      available.release();
      const successor = await admission.reserveStoredData("successor", () => {}, 4096);
      await assert.rejects(
        admission.reserveStoredData("successor", () => {}, 1),
        {
          code: "quota_exceeded",
        },
      );
      successor.release();
    } finally {
      holder.release();
    }
  }
});

void test("late old-owner retirement during a scan cannot credit transferred data", async (t) => {
  const previous = { id: "run:transferred", profileId: "departing", bytes: 8192 };
  const current = { ...previous, profileId: "successor" };
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const admission = await createFixture(
    t,
    16_384,
    async () => {
      started.resolve();
      await finish.promise;
      return [previous];
    },
    8192,
  );
  const pendingHolder = admission("holder", () => {}, "stored-data");
  await started.promise;
  admission.transferredStoredData([{ previous, current }]);
  admission.retiredStoredData([{ removed: previous }]);
  finish.resolve();
  const holder = await pendingHolder;
  try {
    const available = await admission.reserveStoredData("departing", () => {}, 8192);
    await assert.rejects(
      admission.reserveStoredData("other", () => {}, 1),
      {
        code: "quota_exceeded",
      },
    );
    available.release();
  } finally {
    holder.release();
  }
});

void test("held replacement reserves only growth and charges matching committed bytes without rescanning", async (t) => {
  const previous = { id: "session:one", profileId: "owner", bytes: 80 };
  const current = { ...previous, bytes: 100 };
  let scans = 0;
  const admit = await createFixture(t, 100, async () => {
    scans++;
    return [previous];
  });
  const holder = await admit("owner", () => {}, "stored-data");
  const replacement = holder.reserveStoredDataReplacement({ previous, current });
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  replacement.settle(current);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  assert.throws(() => replacement.settle(current), /already settled/);
  assert.equal(scans, 1);
  holder.release();
});

void test("replacement frees shrink only on commit, including cleanup while over quota", async (t) => {
  const previous = { id: "session:one", profileId: "owner", bytes: 100 };
  const current = { ...previous, bytes: 60 };
  const admit = await createFixture(t, 80, async () => [previous]);
  const holder = await admit("owner", () => {}, "stored-data");
  const aborted = holder.reserveStoredDataReplacement({ previous, current });
  aborted.release(previous);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  const replacement = holder.reserveStoredDataReplacement({ previous, current });
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  replacement.settle(current);
  const available = holder.reserveStoredData(20);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  available.release();
  holder.release();
  assert.throws(
    () => holder.reserveStoredDataReplacement({ previous: current, current }),
    /admission closed/,
  );
});

void test("replacement cleanup preserves the admission growth budget and current authority guard", async (t) => {
  const previous = { id: "session:one", profileId: "owner", bytes: 12 * 1024 * 1024 };
  const current = { ...previous, bytes: 0 };
  const admit = await createFixture(t, 20 * 1024 * 1024, async () => [previous]);
  let authorized = true;
  const holder = await admit(
    "owner",
    () => {
      assert.ok(authorized, "authority revoked");
    },
    "stored-data",
  );
  authorized = false;
  assert.throws(
    () => holder.reserveStoredDataReplacement({ previous, current }),
    /authority revoked/,
  );
  authorized = true;
  const replacement = holder.reserveStoredDataReplacement({ previous, current });
  replacement.settle(current);
  const available = holder.reserveStoredData(8 * 1024 * 1024);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  available.release();
  holder.release();
});

void test("unknown or mismatching replacement retains charge and admission until exact rollback", async (t) => {
  const previous = { id: "session:one", profileId: "owner", bytes: 80 };
  const current = { ...previous, bytes: 100 };
  let scans = 0;
  const admit = await createFixture(t, 100, async () => {
    scans++;
    return [previous];
  });
  const holder = await admit("owner", () => {}, "stored-data");
  const replacement = holder.reserveStoredDataReplacement({ previous, current });
  holder.release();
  const observer = await admit("owner", () => {}, "stored-data");
  for (const bad of [
    { ...current, bytes: 99 },
    { ...current, id: "wrong" },
    { ...current, profileId: "other" },
    { ...current, bytes: Number.NaN },
  ]) {
    assert.throws(() => replacement.settle(bad));
    assert.throws(() => observer.reserveStoredData(1), { code: "quota_exceeded" });
  }
  assert.throws(() => replacement.release(current));
  assert.throws(() => observer.reserveStoredData(1), { code: "quota_exceeded" });
  replacement.release(previous);
  replacement.release(previous);
  const available = observer.reserveStoredData(20);
  assert.throws(() => observer.reserveStoredData(1), { code: "quota_exceeded" });
  available.release();
  assert.equal(scans, 1);
  observer.release();
});

void test("replacement rejects invalid baselines and targets before charging, and tombstones rotated identities", async (t) => {
  const previous = { id: "session:one", profileId: "owner", bytes: 80 };
  const occupied = { id: "session:occupied", profileId: "owner", bytes: 10 };
  const retired = { id: "session:retired", profileId: "owner", bytes: 0 };
  const current = { ...previous, id: "session:two", bytes: 90 };
  const admit = await createFixture(t, 100, async () => [previous, occupied]);
  const holder = await admit("owner", () => {}, "stored-data");
  admit.retiredStoredData([{ removed: retired }]);
  for (const change of [
    { previous: { ...previous, bytes: 79 }, current },
    { previous: { ...previous, id: "absent" }, current },
    { previous, current: { ...current, profileId: "other" } },
    { previous, current: occupied },
    { previous, current: retired },
    ...[-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((bytes) => ({
      previous,
      current: { ...current, bytes },
    })),
  ]) {
    assert.throws(() => holder.reserveStoredDataReplacement(change));
  }
  const replacement = holder.reserveStoredDataReplacement({ previous, current });
  replacement.settle(current);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  assert.throws(() =>
    holder.reserveStoredDataReplacement({ previous: current, current: previous }),
  );
  assert.throws(() => holder.reserveStoredDataReplacement({ previous, current }));
  admit.retiredStoredData([{ removed: previous }]);
  assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
  holder.release();
});

void test("late retirement or overlapping replacement rejects settlement atomically without resurrecting data", async (t) => {
  for (const conflict of [
    "retirement",
    "replacement",
    "target",
    "target-retirement",
    "transfer",
  ] as const) {
    const previous = { id: "session:one", profileId: "owner", bytes: 80 };
    const current = { ...previous, id: "session:two", bytes: 100 };
    const admit = await createFixture(t, 130, async () => [previous]);
    const holder = await admit("owner", () => {}, "stored-data");
    const replacement = holder.reserveStoredDataReplacement({ previous, current });
    if (conflict === "retirement") {
      admit.retiredStoredData([{ removed: previous, retained: { ...previous, bytes: 60 } }]);
    } else if (conflict === "replacement") {
      const sameBytes = holder.reserveStoredDataReplacement({ previous, current: previous });
      sameBytes.settle(previous);
    } else if (conflict === "target") {
      const target = holder.reserveStoredData(10);
      target.settle({ created: true, entries: [{ ...current, bytes: 10 }] });
    } else if (conflict === "target-retirement") {
      admit.retiredStoredData([{ removed: current }]);
    } else {
      admit.transferredStoredData([{ previous, current: { ...previous, profileId: "other" } }]);
    }
    assert.throws(() => replacement.settle(current));
    const expectedFree = conflict === "retirement" ? 50 : conflict === "target" ? 20 : 30;
    const available = holder.reserveStoredData(expectedFree);
    assert.throws(() => holder.reserveStoredData(1), { code: "quota_exceeded" });
    available.release();
    replacement.release(previous);
    const rolledBack = holder.reserveStoredData(expectedFree + 20);
    rolledBack.release();
    holder.release();
  }
});
