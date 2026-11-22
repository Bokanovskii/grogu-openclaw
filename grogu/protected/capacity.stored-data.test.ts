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
